import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge } from "../src/bridge/server.js";
import { findBridgeObservation } from "../src/bridge/runtime.js";
import { Workspace } from "../src/workspace/manager.js";
import { discoverCodexProjectRoots } from "../src/workspace/discovery.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const req = createRequire(import.meta.url);
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: unknown[]): void };
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

function executeSql(dbPath: string, sql: string): void {
  if (sqliteModule?.DatabaseSync) {
    const db = new sqliteModule.DatabaseSync(dbPath);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
    return;
  }
  const res = spawnSync("sqlite3", [dbPath, sql], { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`sqlite3 failed: ${res.stderr || res.stdout}`);
  }
}

function insertProjectRoot(dbPath: string, projectId: string, pos: number, rootPath: string): void {
  if (sqliteModule?.DatabaseSync) {
    const db = new sqliteModule.DatabaseSync(dbPath);
    try {
      const stmt = db.prepare("INSERT INTO project_roots (project_id, position, path) VALUES (?, ?, ?)");
      stmt.run(projectId, pos, rootPath);
    } finally {
      db.close();
    }
    return;
  }
  const escapedPath = rootPath.replace(/'/g, "''");
  const sql = `INSERT INTO project_roots (project_id, position, path) VALUES ('${projectId}', ${pos}, '${escapedPath}');`;
  const res = spawnSync("sqlite3", [dbPath, sql], { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`sqlite3 insert failed: ${res.stderr || res.stdout}`);
  }
}

function createTestDb(dbPath: string, projectRoots: { projectId: string; pos: number; path: string }[]): void {
  executeSql(
    dbPath,
    `
      CREATE TABLE projects (id TEXT PRIMARY KEY);
      CREATE TABLE project_roots (
        project_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        path TEXT NOT NULL,
        PRIMARY KEY (project_id, position)
      );
    `
  );
  for (const r of projectRoots) {
    insertProjectRoot(dbPath, r.projectId, r.pos, r.path);
  }
}

describe("Codex project auto-discovery", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
    delete process.env.C2C_CODEX_STATE_DB;
    delete process.env.C2C_AUTO_DISCOVER;
  });

  it("reads project roots from SQLite in position order and filters nonexistent paths", () => {
    const tmp = makeTmpDir("test-db-dir");
    dirs.push(tmp);
    const validDir = makeTmpDir("valid-proj");
    dirs.push(validDir);
    const nonExistentDir = path.join(tmp, "does-not-exist");

    const dbPath = path.join(tmp, "state_5.sqlite");
    createTestDb(dbPath, [
      { projectId: "p1", pos: 0, path: validDir },
      { projectId: "p2", pos: 1, path: nonExistentDir },
    ]);

    const roots = discoverCodexProjectRoots(dbPath);
    expect(roots).toEqual([fs.realpathSync.native(validDir)]);
  });

  it("auto-discovers projects dynamically without restarting the bridge", async () => {
    dirs.push(isolateStateDir());
    const rootPrimary = makeTmpDir("proj-primary");
    const rootSecondary = makeTmpDir("proj-secondary");
    dirs.push(rootPrimary, rootSecondary);
    write(rootPrimary, "primary.txt", "hello primary");
    write(rootSecondary, "secondary.txt", "hello secondary");

    const tmp = makeTmpDir("db-dir");
    dirs.push(tmp);
    const dbPath = path.join(tmp, "state_5.sqlite");
    // Initially only rootPrimary in db
    createTestDb(dbPath, [
      { projectId: "p1", pos: 0, path: rootPrimary },
    ]);

    const auth = path.join(makeTmpDir("auth"), "store.json");
    dirs.push(path.dirname(auth));
    const wsPrimary = new Workspace(rootPrimary);
    const wsSecondary = new Workspace(rootSecondary);

    const bridge = await startBridge({
      workspaceRoot: rootPrimary,
      autoDiscoverProjects: true,
      codexStateDbPath: dbPath,
      port: 0,
      persistRuntime: true,
      authStoreFile: auth,
    });

    try {
      expect(bridge.workspaces.map((w) => w.id)).toContain(wsPrimary.id);
      expect(bridge.workspaces.map((w) => w.id)).not.toContain(wsSecondary.id);

      // Now simulate Codex desktop registering a new project in state_5.sqlite
      insertProjectRoot(dbPath, "p2", 0, rootSecondary);

      // Querying health should discover the new project without restart
      const healthBefore = (await (await fetch(`${bridge.localBaseUrl()}/health`)).json()) as {
        workspaceIds: string[];
      };
      expect(healthBefore.workspaceIds).toContain(wsSecondary.id);

      // Switching to newly discovered workspace succeeds
      const headers = { Authorization: `Bearer ${bridge.adminToken}` };
      const switched = (await (
        await fetch(`${bridge.localBaseUrl()}/admin/workspace/switch`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId: wsSecondary.id }),
        })
      ).json()) as { activeWorkspaceId: string };
      expect(switched.activeWorkspaceId).toBe(wsSecondary.id);
      expect(bridge.workspace.id).toBe(wsSecondary.id);

      // Runtime file was automatically created for the new workspace
      const obsSecondary = await findBridgeObservation(wsSecondary.id);
      expect(obsSecondary.state).toBe("healthy");
    } finally {
      await bridge.close();
    }
  });

  it("exposes all discoverable workspace IDs and names to MCP clients via workspace_info", async () => {
    dirs.push(isolateStateDir());
    const rootA = makeTmpDir("mcp-a");
    const rootB = makeTmpDir("mcp-b");
    dirs.push(rootA, rootB);
    write(rootA, "a.txt", "a");
    write(rootB, "b.txt", "b");

    const tmp = makeTmpDir("mcp-db");
    dirs.push(tmp);
    const dbPath = path.join(tmp, "state_5.sqlite");
    createTestDb(dbPath, [
      { projectId: "p1", pos: 0, path: rootA },
      { projectId: "p2", pos: 1, path: rootB },
    ]);

    const auth = path.join(makeTmpDir("mcp-auth"), "store.json");
    dirs.push(path.dirname(auth));
    const wsA = new Workspace(rootA);
    const wsB = new Workspace(rootB);

    const bridge = await startBridge({
      workspaceRoot: rootA,
      autoDiscoverProjects: true,
      codexStateDbPath: dbPath,
      port: 0,
      persistRuntime: false,
      authStoreFile: auth,
    });

    const tokens = bridge.authStore.issueTokens({ clientId: "mcp-client", scopes: ["workspace.read"] });
    const client = new Client({ name: "mcp-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(bridge.localBaseUrl() + "/mcp"), {
        requestInit: { headers: { authorization: "Bearer " + tokens.accessToken } },
      })
    );

    try {
      const textOf = (r: unknown): string => ((r as { content: { text: string }[] }).content[0]?.text ?? "");
      const resA = JSON.parse(textOf(await client.callTool({ name: "workspace_info", arguments: {} }))) as {
        workspaceId: string;
        workspaces?: { workspaceId: string; workspaceName: string; workspaceRoot: string }[];
      };
      expect(resA.workspaceId).toBe(wsA.id);
      expect(resA.workspaces).toBeDefined();
      const discoveredIds = resA.workspaces!.map((w) => w.workspaceId);
      expect(discoveredIds).toContain(wsA.id);
      expect(discoveredIds).toContain(wsB.id);

      // Client can target the discovered workspace using workspaceId
      const resB = JSON.parse(
        textOf(await client.callTool({ name: "workspace_info", arguments: { workspaceId: wsB.id } }))
      ) as { workspaceId: string };
      expect(resB.workspaceId).toBe(wsB.id);
    } finally {
      await client.close();
      await bridge.close();
    }
  });

  it("preserves sandbox boundaries for discovered workspaces", async () => {
    dirs.push(isolateStateDir());
    const rootA = makeTmpDir("sandbox-a");
    const rootB = makeTmpDir("sandbox-b");
    dirs.push(rootA, rootB);
    write(rootA, "fileA.txt", "content A");
    write(rootB, "fileB.txt", "content B");

    const tmp = makeTmpDir("sb-db");
    dirs.push(tmp);
    const dbPath = path.join(tmp, "state_5.sqlite");
    createTestDb(dbPath, [
      { projectId: "p1", pos: 0, path: rootA },
      { projectId: "p2", pos: 1, path: rootB },
    ]);

    const auth = path.join(makeTmpDir("sb-auth"), "store.json");
    dirs.push(path.dirname(auth));
    const wsB = new Workspace(rootB);

    const bridge = await startBridge({
      workspaceRoot: rootA,
      autoDiscoverProjects: true,
      codexStateDbPath: dbPath,
      port: 0,
      persistRuntime: false,
      authStoreFile: auth,
    });

    const tokens = bridge.authStore.issueTokens({ clientId: "sb-client", scopes: ["workspace.read"] });
    const client = new Client({ name: "sb-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(bridge.localBaseUrl() + "/mcp"), {
        requestInit: { headers: { authorization: "Bearer " + tokens.accessToken } },
      })
    );

    try {
      const textOf = (r: unknown): string => ((r as { content: { text: string }[] }).content[0]?.text ?? "");

      // Reading valid file inside rootB via workspaceId=wsB.id succeeds
      const readValid = JSON.parse(
        textOf(await client.callTool({ name: "read_file", arguments: { workspaceId: wsB.id, path: "fileB.txt" } }))
      ) as { content: string };
      expect(readValid.content).toBe("content B");

      // Attempting to read outside workspace rootB fails
      const readEscape = (await client.callTool({
        name: "read_file",
        arguments: { workspaceId: wsB.id, path: "../sandbox-a/fileA.txt" },
      })) as { isError?: boolean };
      expect(readEscape.isError).toBe(true);
    } finally {
      await client.close();
      await bridge.close();
    }
  });

  it("starts cleanly with persistRuntime=true, explicit extra roots, and auto-discovery without TDZ reference errors", async () => {
    dirs.push(isolateStateDir());
    const rootPrimary = makeTmpDir("tdz-primary");
    const rootExtra = makeTmpDir("tdz-extra");
    const rootDb = makeTmpDir("tdz-db-proj");
    dirs.push(rootPrimary, rootExtra, rootDb);
    write(rootPrimary, "p.txt", "p");
    write(rootExtra, "e.txt", "e");
    write(rootDb, "d.txt", "d");

    const tmp = makeTmpDir("tdz-db");
    dirs.push(tmp);
    const dbPath = path.join(tmp, "state_5.sqlite");
    createTestDb(dbPath, [
      { projectId: "p-db", pos: 0, path: rootDb },
    ]);

    const auth = path.join(makeTmpDir("tdz-auth"), "store.json");
    dirs.push(path.dirname(auth));
    const wsPrimary = new Workspace(rootPrimary);
    const wsExtra = new Workspace(rootExtra);
    const wsDb = new Workspace(rootDb);

    // This must NOT throw ReferenceError: Cannot access 'port' before initialization
    const bridge = await startBridge({
      workspaceRoot: rootPrimary,
      sharedWorkspaceRoots: [rootExtra],
      autoDiscoverProjects: true,
      codexStateDbPath: dbPath,
      port: 0,
      persistRuntime: true,
      authStoreFile: auth,
    });

    try {
      const bound = bridge.workspaces.map((w) => w.id).sort();
      expect(bound).toEqual([wsPrimary.id, wsExtra.id, wsDb.id].sort());

      const obsPrimary = await findBridgeObservation(wsPrimary.id);
      const obsExtra = await findBridgeObservation(wsExtra.id);
      const obsDb = await findBridgeObservation(wsDb.id);

      expect(obsPrimary.state).toBe("healthy");
      expect(obsExtra.state).toBe("healthy");
      expect(obsDb.state).toBe("healthy");
    } finally {
      await bridge.close();
    }
  });

  it("resolves findBridgeObservation(newId) as healthy after new DB row is inserted, without manual health call", async () => {
    dirs.push(isolateStateDir());
    const rootPrimary = makeTmpDir("obs-primary");
    const rootNew = makeTmpDir("obs-new");
    dirs.push(rootPrimary, rootNew);
    write(rootPrimary, "primary.txt", "primary");
    write(rootNew, "new.txt", "newly added project");

    const tmp = makeTmpDir("obs-db");
    dirs.push(tmp);
    const dbPath = path.join(tmp, "state_5.sqlite");
    // Initially only rootPrimary
    createTestDb(dbPath, [
      { projectId: "p1", pos: 0, path: rootPrimary },
    ]);

    const auth = path.join(makeTmpDir("obs-auth"), "store.json");
    dirs.push(path.dirname(auth));
    const wsPrimary = new Workspace(rootPrimary);
    const wsNew = new Workspace(rootNew);

    const bridge = await startBridge({
      workspaceRoot: rootPrimary,
      autoDiscoverProjects: true,
      codexStateDbPath: dbPath,
      port: 0,
      persistRuntime: true,
      authStoreFile: auth,
    });

    try {
      // Simulate Codex desktop registering new project in state_5.sqlite
      insertProjectRoot(dbPath, "p2", 0, rootNew);

      // Directly call findBridgeObservation(wsNew.id) BEFORE any health call
      const obs = await findBridgeObservation(wsNew.id);
      expect(obs.state).toBe("healthy");
      if (obs.state === "healthy") {
        expect(obs.runtime.workspaceId).toBe(wsNew.id);
        expect(obs.runtime.port).toBe(bridge.port);
      }
    } finally {
      await bridge.close();
    }
  });
});
