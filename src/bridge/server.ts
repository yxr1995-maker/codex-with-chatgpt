import express, { type Request, type Response, type NextFunction } from "express";
import path from "node:path";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { Workspace } from "../workspace/manager.js";
import { AuthStore } from "../auth/store.js";
import { createOAuthRouter } from "../auth/oauth.js";
import { bearerAuth } from "../auth/middleware.js";
import { PairingManager } from "../pairing/manager.js";
import { createMcpServer } from "../mcp/server.js";
import { createMcpHttpHandler } from "../mcp/http.js";
import { CloudflaredQuickTunnel } from "../tunnel/cloudflared.js";
import { CloudflaredNamedTunnel } from "../tunnel/cloudflared-named.js";
import type { TunnelProvider } from "../tunnel/provider.js";
import { namedTunnelBinding, readTunnelState } from "../tunnel/state.js";
import { Logger, nullLogger } from "../logger/index.js";
import { DEFAULT_HOST, DEFAULT_PORT } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";
import { writeRuntimeState, clearRuntimeState, type RuntimeState } from "./runtime.js";

function tunnelForWorkspace(workspaceId: string, logger: Logger): TunnelProvider {
  const binding = namedTunnelBinding(readTunnelState(workspaceId));
  if (binding) {
    return new CloudflaredNamedTunnel({
      tunnelName: binding.tunnelName,
      hostname: binding.hostname,
      logger,
    });
  }
  return new CloudflaredQuickTunnel(logger);
}

export interface BridgeOptions {
  workspaceRoot: string;
  sharedWorkspaceRoots?: string[];
  port?: number;
  host?: string;
  logger?: Logger;
  tunnelProvider?: TunnelProvider;
  /** Persist runtime state file (disable in tests). */
  persistRuntime?: boolean;
  authStoreFile?: string;
  pairingTtlMs?: number;
  accessTokenTtlMs?: number;
}

export interface Bridge {
  workspace: Workspace;
  workspaces: Workspace[];
  activeWorkspaceId: string;
  switchWorkspace: (idOrRoot: string) => Workspace;
  port: number;
  host: string;
  adminToken: string;
  authStore: AuthStore;
  pairing: PairingManager;
  tunnel: TunnelProvider;
  getPublicBaseUrl(): string | null;
  localBaseUrl(): string;
  close(): Promise<void>;
}

/**
 * Listen on the preferred port; on EADDRINUSE fall back to an ephemeral port.
 */
function listen(app: express.Express, host: string, preferredPort: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number, allowFallback: boolean): void => {
      const server = app.listen(port, host);
      server.once("listening", () => {
        const address = server.address();
        const actual = typeof address === "object" && address ? address.port : port;
        resolve({ server, port: actual });
      });
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" && allowFallback) {
          tryListen(0, false);
        } else {
          reject(error);
        }
      });
    };
    tryListen(preferredPort, preferredPort !== 0);
  });
}

export function sharedRootsFromEnv(): string[] {
  const raw = process.env.C2C_SHARED_WORKSPACES ?? "";
  return raw
    .split(path.delimiter)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export async function startBridge(opts: BridgeOptions): Promise<Bridge> {
  const logger = opts.logger ?? nullLogger;
  const workspace = new Workspace(opts.workspaceRoot);
  const workspaces = new Map<string, Workspace>();
  workspaces.set(workspace.id, workspace);
  for (const root of [...(opts.sharedWorkspaceRoots ?? []), ...sharedRootsFromEnv()]) {
    try {
      const extra = new Workspace(root);
      if (!workspaces.has(extra.id)) workspaces.set(extra.id, extra);
    } catch (error) {
      logger.warn(`Skipping shared workspace ${root}: ${(error as Error).message}`);
    }
  }
  let activeWorkspaceId = workspace.id;
  const boundIds = (): string[] => [...workspaces.keys()];
  const getActive = (): Workspace => workspaces.get(activeWorkspaceId) ?? workspace;
  const sharedMode = workspaces.size > 1;
  const host = opts.host ?? DEFAULT_HOST;
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("The bridge only binds to loopback addresses. Public exposure goes through the tunnel.");
  }

  const authStore = new AuthStore(workspace.id, { file: opts.authStoreFile });
  const pairing = new PairingManager(workspace.id, { ttlMs: opts.pairingTtlMs });
  const tunnel = opts.tunnelProvider ?? tunnelForWorkspace(workspace.id, logger);
  const adminToken = `c2c_admin_${randomBytes(24).toString("base64url")}`;

  let publicBaseUrl: string | null = null;

  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");

  const getBaseUrl = (req: Request): string => {
    if (publicBaseUrl) return publicBaseUrl;
    const proto = req.protocol;
    const hostHeader = req.get("host") ?? `${host}:${port}`;
    return `${proto}://${hostHeader}`;
  };

  // ---- Health (public but minimal) ---------------------------------------

  app.get("/health", (_req, res) => {
    res.json({ service: SERVICE_NAME, version: VERSION, workspaceId: getActive().id, workspaceIds: boundIds(), sharedMode, status: "ok" });
  });

  // ---- OAuth + discovery ---------------------------------------------------

  app.use(
    createOAuthRouter({
      store: authStore,
      pairing,
      workspaceName: workspace.name,
      getBaseUrl,
      logger,
    })
  );

  // ---- MCP endpoint (bearer-protected) --------------------------------------

  const mcpHandler = createMcpHttpHandler(() => createMcpServer({ workspace: getActive(), getWorkspace: getActive, getWorkspaceById: (id) => workspaces.get(id) ?? null, logger }), logger);
  app.all(
    "/mcp",
    express.json({ limit: "8mb" }),
    bearerAuth({ store: authStore, workspaceId: workspace.id, workspaceIds: boundIds(), getBaseUrl, logger }),
    (req: Request, res: Response) => {
      void mcpHandler(req, res);
    }
  );

  // ---- Admin API (loopback + admin token only; used by the CLI/Skill) --------

  const adminGuard = (req: Request, res: Response, next: NextFunction): void => {
    // Defense in depth: reject anything that arrived through a proxy/tunnel.
    const remote = req.socket.remoteAddress ?? "";
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    const viaProxy = Boolean(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]);
    const header = req.headers.authorization ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!isLoopback || viaProxy || token !== adminToken) {
      res.status(404).end(); // do not advertise the admin surface
      return;
    }
    next();
  };

  app.post("/admin/pairing", adminGuard, (_req, res) => {
    const session = pairing.create();
    logger.info("Created pairing session");
    res.json({ code: session.code, expiresAt: session.expiresAt });
  });

  app.get("/admin/info", adminGuard, (_req, res) => {
    const active = getActive();
    res.json({
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: active.id,
      workspaceName: active.name,
      workspaceRoot: active.root,
      workspaces: boundIds().map((id) => {
        const entry = workspaces.get(id) as Workspace;
        return { workspaceId: entry.id, workspaceName: entry.name, workspaceRoot: entry.root };
      }),
      activeWorkspaceId,
      sharedMode,
      port,
      publicUrl: publicBaseUrl,
      tunnel: tunnel.status(),
      tokenCount: authStore.tokenCount(),
      pairingActive: pairing.hasActiveSession(),
      pid: process.pid,
      startedAt,
    });
  });

  app.post("/admin/workspace/switch", adminGuard, express.json({ limit: "4kb" }), (req, res) => {
    const body = (req.body ?? {}) as { workspaceId?: string; root?: string };
    const key = (body.workspaceId ?? body.root ?? "").trim();
    let next: Workspace | null = null;
    if (key) {
      next = workspaces.get(key) ?? null;
      if (!next) {
        try {
          const candidate = new Workspace(key);
          next = workspaces.get(candidate.id) ?? null;
        } catch {
          next = null;
        }
      }
    }
    if (!next) {
      res.status(404).json({ error: "unknown_workspace", workspaceIds: boundIds() });
      return;
    }
    activeWorkspaceId = next.id;
    persistRuntime();
    logger.info(`Switched active workspace to ${next.name} (${next.id})`);
    res.json({ activeWorkspaceId: next.id, workspaceName: next.name, workspaceRoot: next.root });
  });

  app.post("/admin/tunnel/start", adminGuard, (_req, res) => {
    tunnel
      .start(port)
      .then((url) => {
        publicBaseUrl = url;
        persistRuntime();
        res.json({ url });
      })
      .catch((error: Error) => {
        logger.error(`Tunnel start failed: ${error.message}`);
        res.status(500).json({ error: "tunnel_failed", message: error.message });
      });
  });

  app.post("/admin/tunnel/stop", adminGuard, (_req, res) => {
    void tunnel.stop().then(() => {
      publicBaseUrl = null;
      persistRuntime();
      res.json({ stopped: true });
    });
  });

  app.post("/admin/revoke-all", adminGuard, (_req, res) => {
    const count = authStore.revokeAll();
    pairing.invalidateAll();
    logger.info(`Revoked all tokens (${count})`);
    res.json({ revoked: count });
  });

  app.post("/admin/shutdown", adminGuard, (_req, res) => {
    res.json({ shuttingDown: true });
    setTimeout(() => {
      void shutdown().then(() => process.exit(0));
    }, 100);
  });

  const { server, port } = await listen(app, host, opts.port ?? DEFAULT_PORT);
  const startedAt = new Date().toISOString();
  logger.info(`Bridge listening on ${host}:${port} for workspace ${workspace.name} (${workspace.id})`);

  const persistRuntime = (): void => {
    if (opts.persistRuntime === false) return;
    for (const entry of workspaces.values()) {
      const state: RuntimeState = {
        service: SERVICE_NAME,
        version: VERSION,
        workspaceId: entry.id,
        workspaceRoot: entry.root,
        pid: process.pid,
        port,
        adminToken,
        publicUrl: publicBaseUrl,
        startedAt,
      };
      writeRuntimeState(state);
    }
  };
  persistRuntime();

  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await tunnel.stop().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (opts.persistRuntime !== false) for (const id of workspaces.keys()) clearRuntimeState(id);
    logger.info("Bridge stopped");
  };

  const switchWorkspace = (idOrRoot: string): Workspace => {
    const key = idOrRoot.trim();
    const direct = workspaces.get(key);
    if (direct) {
      activeWorkspaceId = direct.id;
      return direct;
    }
    const candidate = new Workspace(key);
    const known = workspaces.get(candidate.id);
    if (!known) throw new Error(`Unknown workspace: ${idOrRoot}`);
    activeWorkspaceId = known.id;
    persistRuntime();
    return known;
  };

  return {
    get workspace(): Workspace {
      return getActive();
    },
    workspaces: [...workspaces.values()],
    get activeWorkspaceId(): string {
      return activeWorkspaceId;
    },
    switchWorkspace,
    port,
    host,
    adminToken,
    authStore,
    pairing,
    tunnel,
    getPublicBaseUrl: () => publicBaseUrl,
    localBaseUrl: () => `http://${host}:${port}`,
    close: shutdown,
  };
}
