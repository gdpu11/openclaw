import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { recordLegacyAcpMigrationSources } from "../../config/sessions/session-accessor.sqlite-acp-provenance.js";
import { readSessionEntryCache } from "../../config/sessions/session-accessor.sqlite-entry-cache.js";
import {
  readExactSessionEntryRow,
  writeArchivedSessionEntries,
  writeSessionEntry,
} from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { readTranscriptContextVersionInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-state.js";
import { appendTranscriptEventsInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-store.js";
import { createSessionActorWorkerFixture } from "../../config/sessions/session-actor-worker.test-support.js";
import type { SessionEntryWritePostimages } from "../../config/sessions/session-entry-write-postimage.js";
import { readTranscriptContextVersionsInTransaction } from "../../config/sessions/session-transcript-context-versions.js";
import { promptReport } from "../../config/sessions/system-prompt-report.test-support.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import type { EngineConnection } from "../sql-connection.js";
import { runSqliteImmediateTransactionSync } from "../sqlite-transaction.js";
import { createSqliteWorkerTransferCollector } from "../sqlite-worker-transfer.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

function report(generatedAt: number): NonNullable<SessionEntry["systemPromptReport"]> {
  return promptReport(generatedAt, 10, 0);
}

function persisted(db: EngineConnection, sessionKey: string, sessionId: string) {
  return {
    node: db.prepare("SELECT * FROM session_nodes WHERE session_key = ?").get(sessionKey),
    window: db.prepare("SELECT * FROM session_windows WHERE session_id = ?").get(sessionId),
    snapshots: db
      .prepare(
        "SELECT field, value_json FROM session_entry_snapshots WHERE session_key = ? ORDER BY field",
      )
      .all(sessionKey),
  };
}

function withEntryDatabase(
  run: (fixture: ReturnType<typeof entryDatabase>) => void,
  freezeTime = false,
) {
  return withEngineStoreAdmission(() => {
    const fixture = entryDatabase();
    const now = freezeTime ? vi.spyOn(Date, "now").mockReturnValue(20) : undefined;
    try {
      run(fixture);
    } finally {
      now?.mockRestore();
    }
  });
}

function entryDatabase() {
  const database = openOpenClawAgentDatabase({ agentId: "main" });
  return {
    database,
    transaction: <T>(run: (owner: typeof database) => T) =>
      runOpenClawAgentWriteTransaction(run, { agentId: "main", path: database.path }),
    write: (key: string, entry: SessionEntry) =>
      runSqliteImmediateTransactionSync(database.db, () => writeSessionEntry(database, key, entry)),
    state: (key: string, id: string) => persisted(database.db, key, id),
  };
}

function expectState(
  state: ReturnType<typeof persisted>,
  revision: number,
  skills?: SessionEntry["skillsSnapshot"],
  prompt?: SessionEntry["systemPromptReport"],
) {
  expect(state.node).toMatchObject({ snapshot_revision: revision });
  expect(state.snapshots).toEqual(snapshotRows(skills, prompt));
  return expect(state);
}

function snapshotRows(
  skills: SessionEntry["skillsSnapshot"],
  prompt?: SessionEntry["systemPromptReport"],
) {
  return [
    ...(skills ? [{ field: "skillsSnapshot", value_json: JSON.stringify(skills) }] : []),
    ...(prompt ? [{ field: "systemPromptReport", value_json: JSON.stringify(prompt) }] : []),
  ];
}

describe.skipIf(!mixedAgentConnection).each(["sqlite", "postgres"] as const)(
  "%s prepared entry writes",
  (engine) => {
    useMixedAgentPair(engine, engine);

    it("batches archive entries with exact shared-window, rollback, and cache outcomes", () =>
      withEntryDatabase(({ database, transaction }) => {
        const keys = [
          "agent:main:archive-a",
          ...Array.from({ length: 63 }, (_, index) => `agent:main:archive-middle-${index}`),
          "agent:main:archive-b",
        ];
        const untouched = "agent:main:archive-unselected";
        const skills = { prompt: "Retained archive instructions", skills: [] };
        const read = (key: string) => {
          const row = readExactSessionEntryRow(database, key, "full", "canonical", true);
          if (!row) {
            throw new Error("Missing archive equivalence fixture row");
          }
          return row;
        };
        const current = () =>
          [...keys, untouched].map((key) => {
            const entry = read(key).entry;
            return persisted(database.db, key, entry.sessionId);
          });
        const inputs = () =>
          [...keys, keys[1]!].map((sessionKey, index) => {
            const previous = read(sessionKey);
            return {
              sessionKey,
              previous,
              entry: {
                ...previous.entry,
                archivedAt: 30,
                archiveReason: "age-retention" as const,
                ...(index === 0 ? { hookExternalContentSource: "gmail" as const } : {}),
                ...(sessionKey === keys[1] ? { label: index === 1 ? "superseded" : "final" } : {}),
              },
            };
          });
        const rawUnselectedWrite = () => {
          const entry = { ...read(untouched).entry, label: "untracked update before archive" };
          database.db
            .prepare("UPDATE session_nodes SET entry_json = ?, label = ? WHERE session_key = ?")
            .run(JSON.stringify(entry), entry.label, untouched);
        };
        transaction((owner) => {
          for (const [index, key] of [...keys, untouched].entries()) {
            writeSessionEntry(owner, key, {
              sessionId: index === 0 || index === 64 ? "archive-shared" : `archive-${index}`,
              updatedAt: 10,
              skillsSnapshot: skills,
            });
          }
          appendTranscriptEventsInTransaction(
            owner,
            { agentId: "main", sessionKey: keys.at(-1)!, sessionId: "archive-shared" },
            [{ type: "session", id: "archive-shared", version: 3 }],
          );
        });
        const initial = current();
        let sequential: ReturnType<typeof current> | undefined;
        const rollback = new Error("archive equivalence rollback");
        expect(() =>
          transaction((owner) => {
            rawUnselectedWrite();
            for (const input of inputs()) {
              writeSessionEntry(owner, input.sessionKey, input.entry);
            }
            sequential = current();
            throw rollback;
          }),
        ).toThrow(rollback);
        expect(current()).toEqual(initial);

        readSessionEntryCache(database, { cache: true, projection: "list" });
        expect(() =>
          transaction((owner) => {
            rawUnselectedWrite();
            writeArchivedSessionEntries(owner, inputs(), new Map());
            throw rollback;
          }),
        ).toThrow(rollback);
        expect(current()).toEqual(initial);
        expect(
          readSessionEntryCache(database, { cache: true, projection: "list" }).entries.get(keys[0]!)
            ?.archivedAt,
        ).toBeUndefined();

        const postimages: SessionEntryWritePostimages = new Map();
        const written = transaction((owner) => {
          rawUnselectedWrite();
          return writeArchivedSessionEntries(owner, inputs(), postimages);
        });
        expect(current()).toEqual(sequential);
        expect(written.map((entry) => entry.archivedAt)).toEqual(
          Array.from({ length: 66 }, () => 30),
        );
        expect([written[1]?.label, written.at(-1)?.label]).toEqual(["final", "final"]);
        expect(current()[0]).toMatchObject({
          node: { archived_at: 30, snapshot_revision: 1 },
          snapshots: snapshotRows(skills),
          window: { session_key: keys.at(-1), hook_external_content_source: "gmail" },
        });
        for (const key of keys) {
          const state = persisted(database.db, key, read(key).entry.sessionId);
          const postimage = postimages.get(key);
          expect(postimage).toBeDefined();
          expect(state.window).toMatchObject(postimage!.window);
          expect(postimage?.entry.skillsSnapshot).toEqual(skills);
        }
        expect(
          readSessionEntryCache(database, { cache: true, projection: "list" }).entries.get(
            untouched,
          )?.label,
        ).toBe("untracked update before archive");
      }, true));

    it("keeps batched empty, hot, cold, and changed transcript versions equivalent", () =>
      withEntryDatabase(({ database, transaction }) => {
        const ids = [
          "version-absent",
          "version-empty",
          "version-hot",
          "version-cold",
          "version-hot",
        ];
        const scope = (sessionId: string) => ({
          agentId: "main",
          sessionKey: `agent:main:${sessionId}`,
          sessionId,
        });
        const read = () => {
          const batch = readTranscriptContextVersionsInTransaction(database, ids);
          expect(batch).toEqual(
            ids.map((id) => readTranscriptContextVersionInTransaction(database, id)),
          );
          return batch;
        };
        transaction((owner) => {
          for (const id of ids.slice(1, 4)) {
            writeSessionEntry(owner, scope(id).sessionKey, { sessionId: id, updatedAt: 10 });
          }
          appendTranscriptEventsInTransaction(owner, scope("version-hot"), [
            { type: "session", id: "version-hot", version: 3 },
            { type: "custom", customType: "version", data: { value: "first" } },
          ]);
          owner.db
            .prepare(
              "INSERT INTO transcript_rewrite_watermarks (session_id, generation, updated_at) VALUES (?, ?, ?)",
            )
            .run("version-cold", "cold-generation", 17);
          owner.db
            .prepare("UPDATE session_windows SET transcript_updated_at = ? WHERE session_id = ?")
            .run(17, "version-cold");
          owner.db
            .prepare(`INSERT INTO session_transcript_cold_archives
              (session_id, generation, archive_name, archive_sha256, event_count, raw_bytes, archive_bytes, last_seq, archived_at, storage, archive_blob)
              VALUES (?, ?, ?, ?, 10, 1, 1, 9, 17, 'file', NULL)`)
            .run("version-cold", "cold-generation", "version-cold.zst", "0".repeat(64));
        });
        const before = read();
        expect(before).toEqual([
          { rawSeq: null, generation: null, updatedAt: null },
          { rawSeq: null, generation: null, updatedAt: null },
          { rawSeq: 1, generation: expect.any(String), updatedAt: 20 },
          { rawSeq: 9, generation: "cold-generation", updatedAt: 17 },
          { rawSeq: 1, generation: expect.any(String), updatedAt: 20 },
        ]);
        const rollback = new Error("rollback changed transcript versions");
        expect(() =>
          transaction((owner) => {
            readTranscriptContextVersionInTransaction(owner, "version-hot");
            appendTranscriptEventsInTransaction(owner, scope("version-hot"), [
              { type: "custom", customType: "version", data: { value: "later" } },
            ]);
            owner.db
              .prepare(
                "UPDATE session_transcript_cold_archives SET last_seq = 11 WHERE session_id = ?",
              )
              .run("version-cold");
            owner.db
              .prepare(
                "UPDATE transcript_rewrite_watermarks SET generation = ? WHERE session_id = ?",
              )
              .run("cold-next", "version-cold");
            const changed = read();
            expect(changed[2]?.rawSeq).toBe(2);
            expect(changed[3]).toEqual({ rawSeq: 11, generation: "cold-next", updatedAt: 17 });
            throw rollback;
          }),
        ).toThrow(rollback);
        expect(read()).toEqual(before);
      }, true));

    it("preserves native cold-patch and actor participant ordering", () =>
      withEntryDatabase(({ database }) => {
        const scope = {
          agentId: "main",
          storePath: database.path,
          sessionKey: "agent:main:entry-pairs",
          sessionId: "entry-pairs",
        };
        replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 10 });
        runSqliteImmediateTransactionSync(database.db, () => {
          const insert = database.db.prepare(
            "INSERT INTO session_participants (session_key, identity_namespace, actor_id, contribution_count, first_prompted_at) VALUES (?, ?, ?, 1, ?)",
          );
          for (const [type, id, time] of [
            ["profile", "a", 20],
            ["agent", "a", 20],
            ["agent", "z", null],
          ] as const) {
            insert.run(scope.sessionKey, JSON.stringify({ type }), id, time);
          }
        });
        const f = createSessionActorWorkerFixture({ database, scope }, (options) =>
          withEngineStoreAdmission(() => openOpenClawAgentDatabase(options)),
        );
        let coldPatch: unknown;
        const transfer = createSqliteWorkerTransferCollector("patch", (value) => {
          coldPatch = value;
        });
        f.hooks.admit = (_stage, facts) => {
          if (isRecord(facts) && "transfer" in facts) {
            transfer.accept(facts.transfer);
          }
        };
        try {
          f.patchEntry({
            selection: { kind: "entry", sessionKey: scope.sessionKey, exact: true },
            sessionKey: scope.sessionKey,
            operation: { kind: "fields", patch: { label: "Cold participant projection" } },
            operationLabel: "session-entry.patch",
            validateCanonicalKeys: false,
            preserveActivity: true,
          });
          const timestamped = [
            { identity: { type: "agent", id: "a" } },
            { identity: { type: "profile", id: "a" } },
          ];
          const untimestamped = { identity: { type: "agent", id: "z" } };
          expect(coldPatch).toMatchObject({
            entry: {
              participants:
                engine === "sqlite"
                  ? [untimestamped, ...timestamped]
                  : [...timestamped, untimestamped],
            },
          });
          delete f.hooks.admit;
          expect(f.read().entry?.participants).toEqual([untimestamped, ...timestamped]);
        } finally {
          f.close();
        }
      }));

    it("binds interleaved snapshot shapes and preserves legacy provenance when its column is omitted", () =>
      withEntryDatabase(({ database, write }) => {
        const keyA = "agent:main:entry-shape-a";
        const keyB = "agent:main:entry-shape-b";
        let a: SessionEntry = {
          sessionId: "entry-shape-a",
          lifecycleRevision: "a0",
          updatedAt: 10,
          displayName: "Shape A",
          label: "A0",
          skillsSnapshot: { prompt: "A0 instructions", skills: [] },
        };
        let b: SessionEntry = {
          sessionId: "entry-shape-b",
          updatedAt: 10,
          displayName: "Shape B",
          label: "B0",
          skillsSnapshot: { prompt: "B0 instructions", skills: [] },
          systemPromptReport: report(10),
        };
        const stateA = () => persisted(database.db, keyA, a.sessionId);
        const source = (lifecycleRevision: string) => ({
          sourcePath: "/synthetic/acp/cache.json",
          sourceSessionKey: keyA,
          sessionId: a.sessionId,
          lifecycleRevision,
          sourceSha256: "c".repeat(64),
          sourceSizeBytes: 1,
        });
        const record = (revisions: string[]) =>
          runSqliteImmediateTransactionSync(database.db, () =>
            recordLegacyAcpMigrationSources(database.db, keyA, revisions.map(source)),
          );
        write(keyA, a);
        write(keyB, b);
        a = { ...a, label: "A1", skillsSnapshot: { prompt: "A1 instructions", skills: [] } };
        write(keyA, a);
        b = { ...b, label: "B1", skillsSnapshot: { prompt: "B1 instructions", skills: [] } };
        write(keyB, b);
        a = { ...a, label: "A2", skillsSnapshot: { prompt: "A2 instructions", skills: [] } };
        write(keyA, a);
        expectState(stateA(), 3, a.skillsSnapshot).toMatchObject({ node: { label: "A2" } });
        const stableB = persisted(database.db, keyB, b.sessionId);
        expectState(stableB, 3, b.skillsSnapshot, b.systemPromptReport).toMatchObject({
          node: { label: "B1" },
        });

        record(["a0", "a1"]);
        a = { ...a, lifecycleRevision: "a1", updatedAt: 20 };
        write(keyA, a);
        const afterWindow = stateA();
        expect(JSON.parse(String(afterWindow.node?.legacy_acp_migration_json))).toEqual([
          source("a1"),
        ]);
        expectState(afterWindow, 3, a.skillsSnapshot).toMatchObject({ window: { updated_at: 20 } });
        a = { ...a, updatedAt: 30 };
        write(keyA, a);
        expect(stateA().node?.legacy_acp_migration_json).toBe(
          afterWindow.node?.legacy_acp_migration_json,
        );

        record(["a2"]);
        a = {
          ...a,
          lifecycleRevision: "a2",
          label: "A3",
          skillsSnapshot: { prompt: "A3 instructions", skills: [] },
        };
        write(keyA, a);
        const afterSnapshot = stateA();
        expect(JSON.parse(String(afterSnapshot.node?.legacy_acp_migration_json))).toEqual([
          source("a2"),
        ]);
        expectState(afterSnapshot, 4, a.skillsSnapshot).toMatchObject({
          node: { label: "A3" },
          window: { updated_at: 30 },
        });
        a = { ...a, label: "A4", skillsSnapshot: { prompt: "A4 instructions", skills: [] } };
        write(keyA, a);
        expectState(stateA(), 5, a.skillsSnapshot).toMatchObject({
          node: {
            label: "A4",
            legacy_acp_migration_json: afterSnapshot.node?.legacy_acp_migration_json,
          },
          window: afterSnapshot.window,
        });
        expect(persisted(database.db, keyB, b.sessionId)).toEqual(stableB);
      }));

    it("creates foreign-key children after their node and preserves snapshot revisions, deletion, and window ownership", () =>
      withEntryDatabase(({ database, write, state }) => {
        const plainKey = "agent:main:entry-new-window";
        write(plainKey, { sessionId: "entry-new-window", updatedAt: 10 });
        expectState(state(plainKey, "entry-new-window"), 0).toMatchObject({
          node: { current_session_id: "entry-new-window" },
          window: { session_key: plainKey },
        });

        const key = "agent:main:entry-new-snapshots";
        const skills = { prompt: "New instructions", skills: [] };
        const prompt = report(10);
        const entry = {
          sessionId: "entry-new-snapshots",
          updatedAt: 10,
          label: "New node",
          displayName: "Stable cold display name",
          skillsSnapshot: skills,
          systemPromptReport: prompt,
        };
        const current = () => state(key, entry.sessionId);
        const changedSkills = { prompt: "One changed snapshot", skills: [] };
        const changed = { ...entry, label: "Changed node", skillsSnapshot: changedSkills };
        const withoutSkills = { ...changed, skillsSnapshot: undefined };
        const stages: [string, SessionEntry, number][] = [
          ["newNodeSnapshots", entry, 2],
          ["existingNodeSnapshots", changed, 3],
          ["unchanged", changed, 3],
          ["removeOne", withoutSkills, 4],
          ["removeAll", { ...withoutSkills, systemPromptReport: undefined }, 5],
        ];
        let initialWindow: ReturnType<typeof persisted>["window"];
        let previous: ReturnType<typeof persisted> | undefined;
        for (const [name, value, revision] of stages) {
          write(key, value);
          const result = current();
          initialWindow ??= result.window;
          expectState(
            result,
            revision,
            value.skillsSnapshot,
            value.systemPromptReport,
          ).toMatchObject({ node: { label: value.label }, window: initialWindow });
          expect(result.window).toMatchObject({ session_key: key });
          if (name === "unchanged") {
            expect(result).toEqual(previous);
          }
          previous = result;
        }

        const otherKey = "agent:main:entry-window-owner";
        write(otherKey, { sessionId: entry.sessionId, updatedAt: 20 });
        write(key, { sessionId: entry.sessionId, updatedAt: 30, status: "done" });
        expect(current()).toMatchObject({
          node: { current_session_id: entry.sessionId, status: "done", snapshot_revision: 5 },
          window: { session_key: otherKey, created_at: 10, updated_at: 30, status: "done" },
        });

        const refusedKey = "agent:main:entry-refused-new";
        expect(() =>
          runSqliteImmediateTransactionSync(database.db, () => {
            writeSessionEntry(database, refusedKey, { ...entry, sessionId: "entry-refused-new" });
            throw new Error("rollback new node");
          }),
        ).toThrow("rollback new node");
        expect(state(refusedKey, "entry-refused-new")).toEqual({
          node: undefined,
          window: undefined,
          snapshots: [],
        });
      }));
  },
);
