import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { startBridge } from "../src/bridge/server.js";
import { findBridgeObservation } from "../src/bridge/runtime.js";
import { bearerAuth } from "../src/auth/middleware.js";
import { nullLogger } from "../src/logger/index.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

describe("shared connector experiment", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
    delete process.env.C2C_SHARED_WORKSPACES;
  });

  it("serves two workspaces from one bridge and stays healthy for both", async () => {
    dirs.push(isolateStateDir());
    const rootA = makeTmpDir("shared-a");
    const rootB = makeTmpDir("shared-b");
    dirs.push(rootA, rootB);
    write(rootA, "a.txt", "a");
    write(rootB, "b.txt", "b");
    const auth = path.join(makeTmpDir("shared-auth"), "store.json");
    dirs.push(path.dirname(auth));
    const wsA = new Workspace(rootA);
    const wsB = new Workspace(rootB);

    const bridge = await startBridge({
      workspaceRoot: rootA,
      sharedWorkspaceRoots: [rootB],
      port: 0,
      persistRuntime: true,
      authStoreFile: auth,
    });
    try {
      expect(bridge.workspaces.map((entry) => entry.id).sort()).toEqual([wsA.id, wsB.id].sort());

      const health = (await (await fetch(`${bridge.localBaseUrl()}/health`)).json()) as {
        workspaceId: string;
        workspaceIds: string[];
        sharedMode: boolean;
      };
      expect(health.sharedMode).toBe(true);
      expect(health.workspaceIds.sort()).toEqual([wsA.id, wsB.id].sort());

      const headers = { Authorization: `Bearer ${bridge.adminToken}` };
      const switched = (await (
        await fetch(`${bridge.localBaseUrl()}/admin/workspace/switch`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId: wsB.id }),
        })
      ).json()) as { activeWorkspaceId: string };
      expect(switched.activeWorkspaceId).toBe(wsB.id);
      expect(bridge.workspace.id).toBe(wsB.id);

      const unknown = await fetch(`${bridge.localBaseUrl()}/admin/workspace/switch`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: "000000000000" }),
      });
      expect(unknown.status).toBe(404);

      const obsA = await findBridgeObservation(wsA.id);
      const obsB = await findBridgeObservation(wsB.id);
      expect(obsA.state).toBe("healthy");
      expect(obsB.state).toBe("healthy");
    } finally {
      await bridge.close();
    }
  });

  it("accepts tokens minted for any bound workspace only in shared mode", () => {
    const store = {
      verifyAccessToken: (token: string) =>
        token === "good"
          ? { ok: true as const, record: { workspaceId: "ws-b", clientId: "c", scopes: ["workspace.read"], expiresAt: Date.now() + 60000 } }
          : { ok: false as const, reason: "unknown" as const },
    };
    const req = (token?: string) => ({ headers: token ? { authorization: `Bearer ${token}` } : {} }) as never;
    const makeRes = () => {
      const box = { statusCode: 0, body: null as unknown };
      const res = {
        status: (code: number) => ({ json: (body: unknown) => { box.statusCode = code; box.body = body; } }),
        set: () => ({ json: (body: unknown) => { box.body = body; } }),
      };
      return { res: res as never, box };
    };
    const deps = { getBaseUrl: () => "http://x", logger: nullLogger };

    let nextCalled = false;
    const r1 = makeRes();
    bearerAuth({ store: store as never, workspaceId: "ws-a", workspaceIds: ["ws-b"], ...deps })(req("good"), r1.res, (() => { nextCalled = true; }) as never);
    expect(nextCalled).toBe(true);

    nextCalled = false;
    const r2 = makeRes();
    bearerAuth({ store: store as never, workspaceId: "ws-a", ...deps })(req("good"), r2.res, (() => { nextCalled = true; }) as never);
    expect(nextCalled).toBe(false);
    expect(r2.box.statusCode).toBe(403);
  });

  it("selects a bound workspace per request without switching", async () => {
    dirs.push(isolateStateDir());
    const rootA = makeTmpDir("sel-a");
    const rootB = makeTmpDir("sel-b");
    dirs.push(rootA, rootB);
    write(rootA, "a.txt", "a");
    write(rootB, "b.txt", "b");
    const auth = path.join(makeTmpDir("sel-auth"), "store.json");
    dirs.push(path.dirname(auth));
    const wsA = new Workspace(rootA);
    const wsB = new Workspace(rootB);
    const bridge = await startBridge({ workspaceRoot: rootA, sharedWorkspaceRoots: [rootB], port: 0, persistRuntime: false, authStoreFile: auth });
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const tokens = bridge.authStore.issueTokens({ clientId: "sel-client", scopes: ["workspace.read"] });
    const client = new Client({ name: "sel-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.localBaseUrl() + "/mcp"), { requestInit: { headers: { authorization: "Bearer " + tokens.accessToken } } }));
    try {
      const textOf = (r: unknown): string => ((r as { content: { text: string }[] }).content[0]?.text ?? "");
      const dflt = JSON.parse(textOf(await client.callTool({ name: "workspace_info", arguments: {} }))) as { workspaceId: string };
      expect(dflt.workspaceId).toBe(wsA.id);
      const other = JSON.parse(textOf(await client.callTool({ name: "workspace_info", arguments: { workspaceId: wsB.id } }))) as { workspaceId: string };
      expect(other.workspaceId).toBe(wsB.id);
      expect(bridge.workspace.id).toBe(wsA.id);
      const bad = await client.callTool({ name: "workspace_info", arguments: { workspaceId: "000000000000" } });
      expect((bad as { isError?: boolean }).isError).toBe(true);
    } finally {
      await client.close();
      await bridge.close();
    }
  });

  it("reads shared roots from C2C_SHARED_WORKSPACES without changing the default", async () => {
    dirs.push(isolateStateDir());
    const rootA = makeTmpDir("env-a");
    const rootB = makeTmpDir("env-b");
    dirs.push(rootA, rootB);
    write(rootA, "a.txt", "a");
    write(rootB, "b.txt", "b");
    process.env.C2C_SHARED_WORKSPACES = rootB;
    const auth = path.join(makeTmpDir("env-auth"), "store.json");
    dirs.push(path.dirname(auth));
    const bridge = await startBridge({ workspaceRoot: rootA, port: 0, persistRuntime: false, authStoreFile: auth });
    try {
      expect(bridge.workspaces).toHaveLength(2);
    } finally {
      await bridge.close();
    }
  });
});
