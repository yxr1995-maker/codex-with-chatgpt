import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "./manager.js";
import type { Logger } from "../logger/index.js";
import { nullLogger } from "../logger/index.js";

const req = createRequire(import.meta.url);

interface SqliteDatabase {
  prepare(sql: string): { all(): unknown[] };
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
}

let sqliteModule: SqliteModule | null = null;
try {
  sqliteModule = req("node:sqlite") as SqliteModule;
} catch {
  sqliteModule = null;
}

export function getCodexStateDbPath(): string {
  const envPath = process.env.C2C_CODEX_STATE_DB?.trim();
  if (envPath) return envPath;
  return path.join(os.homedir(), ".codex", "state_5.sqlite");
}

function queryProjectRootsSqlite(dbPath: string): string[] {
  if (sqliteModule?.DatabaseSync) {
    try {
      const db = new sqliteModule.DatabaseSync(dbPath, { readOnly: true });
      try {
        const stmt = db.prepare("SELECT DISTINCT path FROM project_roots ORDER BY position ASC");
        const rows = stmt.all() as { path: unknown }[];
        return rows.map((r) => String(r.path ?? "")).filter(Boolean);
      } finally {
        db.close();
      }
    } catch {
      // Fall through to sqlite3 CLI
    }
  }

  try {
    const res = spawnSync(
      "sqlite3",
      ["-readonly", dbPath, "SELECT DISTINCT path FROM project_roots ORDER BY position ASC;"],
      { encoding: "utf8", timeout: 3000 }
    );
    if (res.status === 0 && res.stdout) {
      return res.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    }
  } catch {
    // sqlite3 CLI not available
  }
  return [];
}

/**
 * Discover project roots from Codex desktop's state_5.sqlite database.
 * Read-only access: only existing directories are returned.
 */
export function discoverCodexProjectRoots(dbPath = getCodexStateDbPath()): string[] {
  if (!fs.existsSync(dbPath)) return [];
  try {
    const candidatePaths = queryProjectRootsSqlite(dbPath);
    const roots: string[] = [];
    const seen = new Set<string>();
    for (const raw of candidatePaths) {
      const candidate = raw.trim();
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
          roots.push(candidate);
        }
      } catch {
        // ignore unreadable/inaccessible paths
      }
    }
    return roots;
  } catch {
    return [];
  }
}

export interface WorkspaceRegistryOptions {
  primaryWorkspace: Workspace;
  explicitRoots?: string[];
  autoDiscover?: boolean;
  dbPath?: string;
  discoverFn?: () => string[];
  discoveryIntervalMs?: number;
  logger?: Logger;
  onNewWorkspace?: (ws: Workspace) => void;
}

export class WorkspaceRegistry {
  private primary: Workspace;
  private workspaces = new Map<string, Workspace>();
  private explicitRoots: string[];
  private autoDiscover: boolean;
  private dbPath: string;
  private discoverFn?: () => string[];
  private logger: Logger;
  private onNewWorkspace?: (ws: Workspace) => void;
  private lastDiscoveryTime = 0;
  private discoveryIntervalMs = 1000;

  constructor(opts: WorkspaceRegistryOptions) {
    this.primary = opts.primaryWorkspace;
    this.explicitRoots = opts.explicitRoots ?? [];
    this.autoDiscover =
      opts.autoDiscover ??
      (process.env.C2C_AUTO_DISCOVER !== undefined
        ? process.env.C2C_AUTO_DISCOVER !== "0"
        : !process.env.VITEST);
    this.dbPath = opts.dbPath ?? getCodexStateDbPath();
    this.discoverFn = opts.discoverFn;
    this.discoveryIntervalMs = opts.discoveryIntervalMs ?? (process.env.VITEST ? 0 : 1000);
    this.logger = opts.logger ?? nullLogger;
    this.onNewWorkspace = opts.onNewWorkspace;

    this.workspaces.set(this.primary.id, this.primary);
    this.loadRoots(this.explicitRoots);
    if (this.autoDiscover) {
      this.refreshDiscovered(true);
    }
  }

  private loadRoots(roots: string[]): void {
    for (const root of roots) {
      try {
        const ws = new Workspace(root);
        if (!this.workspaces.has(ws.id)) {
          this.workspaces.set(ws.id, ws);
          this.onNewWorkspace?.(ws);
        }
      } catch (error) {
        this.logger.warn(`Skipping shared workspace ${root}: ${(error as Error).message}`);
      }
    }
  }

  public refreshDiscovered(force = false): void {
    if (!this.autoDiscover) return;
    const now = Date.now();
    if (!force && now - this.lastDiscoveryTime < this.discoveryIntervalMs) {
      return;
    }
    this.lastDiscoveryTime = now;
    const discovered = this.discoverFn ? this.discoverFn() : discoverCodexProjectRoots(this.dbPath);
    this.loadRoots(discovered);
  }

  public get(id: string): Workspace | null {
    const existing = this.workspaces.get(id);
    if (existing) return existing;
    if (this.autoDiscover) {
      this.refreshDiscovered(true);
      return this.workspaces.get(id) ?? null;
    }
    return null;
  }

  public getAll(): Workspace[] {
    if (this.autoDiscover) {
      this.refreshDiscovered();
    }
    return [...this.workspaces.values()];
  }

  public getBoundIds(): string[] {
    if (this.autoDiscover) {
      this.refreshDiscovered();
    }
    return [...this.workspaces.keys()];
  }

  public has(id: string): boolean {
    return this.get(id) !== null;
  }

  public getPrimary(): Workspace {
    return this.primary;
  }

  public setOnNewWorkspace(fn: (ws: Workspace) => void): void {
    this.onNewWorkspace = fn;
  }
}
