import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  createPluginInstallRecordMap,
  getPluginInstallRecordMapEntry,
  setPluginInstallRecordMapEntry,
} from "../config/plugin-install-record-map.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import * as stateDbReadOnly from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import {
  getCurrentPluginMetadataSnapshot,
  setGatewayPluginMetadataSnapshot,
} from "./current-plugin-metadata-snapshot.js";
import { indexStoreFixture, readIndexRow } from "./installed-plugin-index-family.test-support.js";
import { inspectPersistedInstalledPluginIndexInstallRecordsSync as inspectRecords } from "./installed-plugin-index-record-state.js";
import {
  loadInstalledPluginIndexInstallRecordsSync as loadRecordsSync,
  readPersistedInstalledPluginIndexInstallRecordsAsync as readRecords,
} from "./installed-plugin-index-records.js";
import {
  refreshPersistedInstalledPluginIndexWithLeaseSync as refreshWithLease,
  refreshPersistedInstalledPluginIndex as refreshIndex,
  restorePersistedInstalledPluginIndexIfCurrent as restoreIndex,
  writePersistedInstalledPluginIndex as writeIndex,
} from "./installed-plugin-index-store-write.js";
import {
  readPersistedInstalledPluginIndex as readIndex,
  readPersistedInstalledPluginIndexSync as readIndexSync,
  resolveInstalledPluginIndexStorePath as storePath,
} from "./installed-plugin-index-store.js";
import {
  diffInstalledPluginIndexInvalidationReasons as invalidationReasons,
  resolveInstalledPluginIndexPolicyHash as policyHash,
  type InstalledPluginIndex,
} from "./installed-plugin-index.js";
import { withPluginLifecycleLease as withLease } from "./plugin-lifecycle-lease.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import * as metadataWorker from "./plugin-metadata-state-worker.js";
import { loadPluginRegistrySnapshotWithMetadata as loadRegistry } from "./plugin-registry-snapshot.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import {
  createInstalledPluginIndex as createIndex,
  createInstalledPluginIndexCandidate as createCandidate,
  seedInstalledPluginIndex,
} from "./test-helpers/installed-plugin-index.js";

const tempDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  clearPluginMetadataLifecycleCaches();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  cleanupTrackedTempDirs(tempDirs);
});
const makeTempDir = () => makeTrackedTempDir("openclaw-installed-plugin-index-store", tempDirs);
const makeStore = () => indexStoreFixture(makeTempDir());
const discoveryEnv = {
  OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
  OPENCLAW_VERSION: "2026.4.25",
  VITEST: "true",
};

function requirePersisted(index: InstalledPluginIndex | null): InstalledPluginIndex {
  assert(index, "Expected persisted installed plugin index");
  return index;
}

function expectPluginIds(index: InstalledPluginIndex, expected: string[]) {
  expect(index.plugins.map((plugin) => plugin.pluginId)).toEqual(expected);
}

function makePluginFixture(configPaths?: readonly string[], overrides: NodeJS.ProcessEnv = {}) {
  const stateDir = makeTempDir();
  const pluginDir = path.join(stateDir, "plugins", "demo");
  fs.mkdirSync(pluginDir, { recursive: true });
  const candidate = createCandidate(pluginDir, { configPaths });
  const env = { ...discoveryEnv, ...overrides };
  const params = { stateDir, candidates: [candidate], env };
  return {
    ...indexStoreFixture(stateDir, env),
    pluginDir,
    params,
    refresh: (options: Partial<Parameters<typeof refreshIndex>[0]> = {}) =>
      refreshIndex({ reason: "manual", ...params, ...options }),
  };
}

function withDatabase<T>(filePath: string, run: (db: DatabaseSync) => T, readOnly = false) {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(filePath, { readOnly });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

describe("installed plugin index persistence", () => {
  it.each(["write", "rollback"] as const)(
    "keeps the running Gateway inventory after an installed-index %s",
    async (operation) => {
      const f = makePluginFixture(undefined, { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" });
      const { stateDir, env } = f;
      const config = {};
      const index = await f.refresh({ config });
      const boot = loadPluginMetadataSnapshot({ index, config, env, allowCurrent: false });
      setGatewayPluginMetadataSnapshot(boot, { config, env });
      expect(getCurrentPluginMetadataSnapshot({ config, env })).toBe(boot);
      const next = { ...index, plugins: [] };

      if (operation === "rollback") {
        const revision = f.revision();
        await expect(
          withLease({ env }, (lease) => restoreIndex(next, revision, { stateDir, lease })),
        ).resolves.toBe(true);
      } else {
        await f.write(next);
      }

      expectPluginIds(requirePersisted(await f.read()), []);
      expect(getCurrentPluginMetadataSnapshot({ config, env })).toBe(boot);
      expectPluginIds(boot.index, ["demo"]);
    },
  );

  it("retains declared engine ownership across metadata and install-record reads", async () => {
    const stateDir = makeTempDir();
    const ownership = { demo: ["canonical-engine"] };
    const index = createIndex({
      installRecords: { demo: { source: "npm", contextEngineIdsByPlugin: ownership } },
    });
    for (const plugin of index.plugins) {
      plugin.contextEngineIds = ["canonical-engine"];
    }

    await writeIndex(index, { stateDir });

    expect((await readIndex({ stateDir }))?.plugins[0]?.contextEngineIds).toEqual([
      "canonical-engine",
    ]);
    expect((await readRecords({ stateDir }))?.demo?.contextEngineIdsByPlugin).toEqual(ownership);
  });

  it("keeps a successor index when conditional rollback sees a newer revision", async () => {
    const f = makeStore();
    await withLease({ env: f.env }, async (lease) => {
      await f.write(createIndex({ policyHash: "previous" }));
      const previous = requirePersisted(await f.read());
      // A future persisted revision exercises collision fencing across worker clocks.
      const futureRevision = Date.now() + 60_000;
      f.sql(
        `UPDATE config_machine_state
                SET value_json = json_set(value_json, '$.revision', ?), updated_at_ms = ?
              WHERE state_key = 'plugins.installedIndex'`,
        futureRevision,
        futureRevision,
      );
      await f.write(createIndex({ policyHash: "tentative" }));
      const tentativeRevision = f.revision();
      await f.write(createIndex({ policyHash: "successor" }));
      const successorRevision = f.revision();
      expect([tentativeRevision, successorRevision]).toEqual([
        futureRevision + 1,
        futureRevision + 2,
      ]);
      await expect(
        restoreIndex(previous, tentativeRevision, { stateDir: f.stateDir, lease }),
      ).resolves.toBe(false);
      expect((await f.read())?.policyHash).toBe("successor");
    });
  });

  it("rejects a stale caller's registry refresh without replacing the successor index", async () => {
    const stateDir = makeTempDir();
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const staleLease = await withLease({ env }, async (lease) => lease);
    await withLease({ env }, async (successorLease) => {
      const successorIndex = await refreshIndex({
        env,
        lease: successorLease,
        reason: "manual",
        candidates: [],
        config: { plugins: { enabled: false } },
        workspaceDir: "/agents/gadget/workspace",
      });

      await expect(
        refreshIndex({
          env,
          lease: staleLease,
          reason: "manual",
          candidates: [],
          config: { plugins: { enabled: true } },
        }),
      ).rejects.toThrow("original live lease context");
      const persisted = requirePersisted(await readIndex({ env }));
      expect(persisted).toMatchObject({
        policyHash: successorIndex.policyHash,
        workspaceDir: successorIndex.workspaceDir,
      });
      if (process.platform !== "win32") {
        expect(fs.statSync(storePath({ stateDir })).mode & 0o777).toBe(0o600);
      }
    });
  });

  it("rereads install-record writes under their non-default policy", async () => {
    const { pluginDir, params } = makePluginFixture();
    const config = { plugins: { entries: { demo: { enabled: false } } } };

    await seedInstalledPluginIndex(
      { demo: { source: "npm", spec: "demo@1.0.0", installPath: pluginDir } },
      { ...params, config },
    );
    const result = loadRegistry({ ...params, config });

    expect(result.source).toBe("persisted");
    expect(result.diagnostics).toStrictEqual([]);
    expect(result.snapshot.policyHash).toBe(policyHash(config));
    expect(result.snapshot.plugins.find((plugin) => plugin.pluginId === "demo")).toMatchObject({
      enabled: false,
    });
  });

  it("persists resolved doctor contract hashes and signatures", async () => {
    const { stateDir, pluginDir, refresh } = makePluginFixture();
    const contractPath = path.join(pluginDir, "doctor-contract-api.ts");
    fs.writeFileSync(contractPath, "export const legacyConfigRules = [];\n", "utf8");

    const first = await refresh();
    const firstPlugin = first.plugins[0];
    const firstHash = firstPlugin?.doctorContractHash;
    const firstFile = firstPlugin?.doctorContractFile;
    expect(firstHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(firstFile).toEqual({
      size: fs.statSync(contractPath).size,
      mtimeMs: fs.statSync(contractPath).mtimeMs,
      ctimeMs: fs.statSync(contractPath).ctimeMs,
    });
    expect((await readIndex({ stateDir }))?.plugins[0]).toMatchObject({
      pluginId: "demo",
      doctorContractHash: firstHash,
      doctorContractFile: firstFile,
    });
    fs.appendFileSync(contractPath, "// changed contract\n");
    const changed = await refresh();
    const changedPlugin = requirePersisted(changed).plugins[0]!;
    expect(changedPlugin.manifestHash).toBe(firstPlugin?.manifestHash);
    expect(changedPlugin.doctorContractHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(changedPlugin.doctorContractHash).not.toBe(firstHash);
    expect(changedPlugin.doctorContractFile).not.toEqual(firstFile);
    expect(invalidationReasons(first, changed)).toEqual(["stale-manifest"]);
    expect((await readIndex({ stateDir }))?.plugins[0]).toMatchObject({
      doctorContractHash: changedPlugin.doctorContractHash,
      doctorContractFile: changedPlugin.doctorContractFile,
    });
  });

  it("does not repair shared state schema while reading the index", async () => {
    const stateDir = makeTempDir();
    const filePath = storePath({ stateDir });
    await writeIndex(createIndex(), { stateDir });
    await closeOpenClawStateDatabaseAsync();

    const indexName = "idx_operator_approvals_resolution_ref";
    withDatabase(filePath, (db) => db.exec(`DROP INDEX ${indexName};`));
    const expectCanonicalIndexMissing = () =>
      withDatabase(
        filePath,
        (db) => {
          expect(
            db
              .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = ?")
              .get(indexName),
          ).toBeUndefined();
        },
        true,
      );

    await expect(readIndex({ stateDir })).resolves.toMatchObject({
      version: 1,
    });
    expectCanonicalIndexMissing();

    expect(await readRecords({ stateDir })).toEqual({});
    expectCanonicalIndexMissing();
  });

  it("marks legacy config-path startup indexes stale so update rebuilds them", async () => {
    const { stateDir, params, refresh } = makePluginFixture(["browser"]);
    const current = await refresh();
    const legacy = {
      ...current,
      plugins: current.plugins.map((plugin) => {
        const { configPaths: _configPaths, ...startup } = plugin.startup;
        return { ...plugin, startup };
      }),
    };
    expect(invalidationReasons(legacy, current)).toEqual(["migration"]);
    await writeIndex(legacy, { stateDir });

    const inspection = loadRegistry(params);
    expect(inspection.source).toBe("derived");

    const refreshed = await refresh({ reason: "policy-changed" });
    expect(refreshed.plugins[0]?.startup.configPaths).toEqual(["browser"]);
    const persisted = requirePersisted(await readIndex({ stateDir }));
    expect(persisted.plugins[0]?.startup.configPaths).toEqual(["browser"]);
  });

  it("does not allocate a revision or rewrite an invalid predecessor", async () => {
    const stateDir = makeTempDir();
    const persistedValueJson = JSON.stringify({
      revision: 123,
      index: {
        ...createIndex({ plugins: [] }),
        installRecords: JSON.parse('{"__proto__":{"source":"bogus"}}'),
      },
    });
    insertPersistedIndexRow(stateDir, persistedValueJson);

    await expect(writeIndex(createIndex(), { stateDir })).rejects.toThrow(
      "Persisted plugin install records are invalid",
    );
    expect(readIndexRow(storePath({ stateDir }))).toMatchObject({
      value_json: persistedValueJson,
      updated_at_ms: 123,
    });
  });

  it("preserves newer shared-state schema errors while reading the index", async () => {
    const stateDir = makeTempDir();
    await writeIndex(createIndex(), { stateDir });
    await closeOpenClawStateDatabaseAsync();
    const databasePath = storePath({ stateDir });
    fs.renameSync(databasePath, `${databasePath}.template`);
    fs.copyFileSync(`${databasePath}.template`, databasePath, fs.constants.COPYFILE_EXCL);
    withDatabase(databasePath, (db) =>
      db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};`),
    );
    const schemaError = {
      name: "SqliteSchemaVersionError",
      message: expect.stringContaining(
        `uses newer schema version ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`,
      ),
    };
    expect(() => loadRecordsSync({ stateDir })).toThrow(expect.objectContaining(schemaError));
    await expect(readIndex({ stateDir })).rejects.toMatchObject(schemaError);
  });

  it("does not read retired JSON index files", async () => {
    const stateDir = makeTempDir();
    const filePath = path.join(stateDir, "installs.json");
    fs.writeFileSync(filePath, JSON.stringify(createIndex()), "utf8");

    await expect(readIndex({ filePath })).resolves.toBeNull();
    expect(await readRecords({ filePath })).toBeNull();
  });
});

describe("installed plugin index install-record persistence", () => {
  it.each(["records-first", "index-first"] as const)(
    "reads one row for independent projections of an invalid index: %s",
    async (order) => {
      const f = makeStore();
      const { stateDir } = f;
      await withLease({ env: f.env }, async () => {
        expect(await readRecords({ stateDir })).toBeNull();
        expect(readIndexSync({ stateDir })).toBeNull();
        const records = { demo: { source: "npm" as const, spec: "demo@1.0.0" } };
        await writeIndex(createIndex({ installRecords: records, plugins: [] }), { stateDir });
        f.sql(`UPDATE config_machine_state
                  SET value_json = json_remove(value_json, '$.index.plugins')
                WHERE state_key = 'plugins.installedIndex'`);
        const { StatementSync } = requireNodeSqlite();
        let installedIndexReads = 0;
        observeSqliteReadSql(StatementSync.prototype, (sql, bindings) => {
          if (
            bindings.includes("plugins.installedIndex") &&
            /SELECT\b[\s\S]*?\bFROM\s+"?config_machine_state"?\s+WHERE\s+"?state_key"?\s*(?:=|IN\s*\()/i.test(
              sql,
            )
          ) {
            installedIndexReads += 1;
          }
        });
        const workerRead = vi.spyOn(metadataWorker, "readPluginMetadataStateRow");
        const assertRecords = async () => expect(await readRecords({ stateDir })).toEqual(records);
        const assertIndex = () => expect(readIndexSync({ stateDir })).toBeNull();

        const readers = [assertRecords, assertIndex];
        if (order === "index-first") {
          readers.reverse();
        }
        for (const read of readers) {
          await read();
        }

        expect(installedIndexReads + workerRead.mock.calls.length).toBe(1);
      });
    },
  );

  it("persists legal prototype-named plugin ids as inert own properties", async () => {
    const stateDir = makeTempDir();
    const installRecords =
      createPluginInstallRecordMap<InstalledPluginIndex["installRecords"][string]>();
    const constructorRecord = { source: "npm" as const, futureMetadata: { retained: true } };
    setPluginInstallRecordMapEntry(installRecords, "constructor", constructorRecord);
    setPluginInstallRecordMapEntry(installRecords, "toString", { source: "path" });
    setPluginInstallRecordMapEntry(installRecords, "__proto__", { source: "git" });

    await writeIndex(createIndex({ installRecords, plugins: [] }), { stateDir });

    const persisted = requirePersisted(await readIndex({ stateDir }));
    expect(Object.getPrototypeOf(persisted.installRecords)).toBeNull();
    expect(
      ["constructor", "toString", "__proto__"].map((id) =>
        getPluginInstallRecordMapEntry(persisted.installRecords, id),
      ),
    ).toEqual([constructorRecord, { source: "path" }, { source: "git" }]);
  });
});

const validRecords = { demo: { source: "npm" } } as const;
const rowJson = (index: object) => JSON.stringify({ revision: 123, index });
const readError = () => Object.assign(new Error("plugin index read denied"), { code: "EACCES" });

async function expectRecordState(stateDir: string, status: string, records: object | null) {
  const state = inspectRecords({ stateDir });
  expect(state).toEqual(status === "missing" ? { status } : expect.objectContaining({ status }));
  expect(await readRecords({ stateDir })).toEqual(records);
  await expect(readIndex({ stateDir })).resolves.toBeNull();
}

function insertPersistedIndexRow(stateDir: string, valueJson: string): void {
  indexStoreFixture(stateDir, {}).sql(
    "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES ('plugins.installedIndex', ?, 123)",
    valueJson,
  );
}

describe("installed plugin index read state", () => {
  it("preserves the original read error through both full-index readers", async () => {
    const stateDir = makeTempDir();
    const error = readError();
    const readSpy = vi.spyOn(stateDbReadOnly, "withExistingOpenClawStateDatabaseReadOnly");
    const asyncReadSpy = vi.spyOn(metadataWorker, "readPluginMetadataStateRow");
    for (const { read, fail } of [
      { read: readIndexSync, fail: readSpy },
      { read: readIndex, fail: asyncReadSpy },
    ]) {
      fail.mockImplementationOnce(() => {
        throw error;
      });
      const pending = Promise.resolve().then(() => read({ stateDir }));
      await expect.soft(pending, read.name).rejects.toBe(error);
    }
  });

  it.each(["database", "table", "row"])("reads missing %s without creation", async (missing) => {
    const stateDir = makeTempDir();
    const filePath = storePath({ stateDir });
    if (missing !== "database") {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      withDatabase(filePath, (db) => {
        if (missing === "row") {
          db.exec(
            "CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL) STRICT",
          );
        }
      });
    }
    const before = missing === "database" ? undefined : fs.readFileSync(filePath);
    await expectRecordState(stateDir, "missing", null);
    expect(missing === "database" ? fs.existsSync(filePath) : fs.readFileSync(filePath)).toEqual(
      before ?? false,
    );
  });

  it.each(["manual", "policy-changed"] as const)("blocks %s on read failure", async (reason) => {
    const stateDir = makeTempDir();
    const installRecords = { demo: { source: "npm", spec: "demo@1.0.0" } } as const;
    const valueJson = rowJson(createIndex({ installRecords, plugins: [] }));
    insertPersistedIndexRow(stateDir, valueJson);
    const filePath = storePath({ stateDir });
    closeOpenClawStateDatabaseForTest();
    const error = readError();
    const readSpy = vi
      .spyOn(stateDbReadOnly, "withExistingOpenClawStateDatabaseReadOnly")
      .mockImplementationOnce(() => {
        throw error;
      });
    const lease = { assertOwnedInTransaction: vi.fn() };
    const refresh = () =>
      refreshWithLease({
        reason,
        stateDir,
        candidates: [],
        env: { OPENCLAW_VERSION: "2026.4.25", VITEST: "true" },
        ...(reason === "policy-changed" ? { installRecords } : {}),
        lease,
      });
    await expect.soft(Promise.resolve().then(refresh)).rejects.toBe(error);
    expect.soft(lease.assertOwnedInTransaction).not.toHaveBeenCalled();
    expect
      .soft(readIndexRow(filePath))
      .toMatchObject({ value_json: valueJson, updated_at_ms: 123 });
    readSpy.mockRestore();
    refresh();
    expect((await readIndex({ stateDir }))?.installRecords).toEqual(installRecords);
    expect(JSON.parse(readIndexRow(filePath)!.value_json).revision).toBeGreaterThan(123);
  });

  it.each([
    ["malformed JSON", "{", "invalid"],
    ["missing records", rowJson({}), "invalid"],
    ["malformed records", rowJson({ installRecords: { demo: { source: "bogus" } } }), "invalid"],
    ["invalid index metadata", rowJson({ version: 999, installRecords: validRecords }), "valid"],
    ["missing revision", JSON.stringify({ index: { installRecords: validRecords } }), "valid"],
  ] as const)("independent record parsing: %s", async (_label, valueJson, status) => {
    const stateDir = makeTempDir();
    insertPersistedIndexRow(stateDir, valueJson);
    await expectRecordState(stateDir, status, status === "valid" ? validRecords : null);
  });
});
