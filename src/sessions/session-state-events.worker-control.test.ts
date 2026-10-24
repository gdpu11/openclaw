import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { publishSystemEventStoreResolver } from "../infra/system-event-ownership.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { recordSessionCreated } from "./session-created.js";
import {
  recordSessionCompacted,
  recordSessionGoalChanged,
  recordSessionHumanDirectMessage,
  recordSessionStateEventAsync,
  recordSubagentSpawned,
} from "./session-state-events.js";
import type { SessionStateEventRow, SessionStateNotice } from "./session-state-events.kernel.js";

const edge = vi.hoisted(() => {
  const context = {
    environment: { OPENCLAW_STATE_DIR: "/synthetic" },
    admission: {
      databasePath: "/synthetic/state.sqlite",
      coordinationKey: "captured-shared-state",
      identity: { key: "file:1:1", canonicalPath: "/synthetic/state.sqlite" },
      assertCurrent: vi.fn(),
    },
  } satisfies OpenClawStateWorkerContext;
  const execute = vi.fn<(command: { type: string; input: unknown }) => Promise<unknown>>();
  return {
    context,
    execute,
    capture: vi.fn(() => context),
    admission: vi.fn((_admit: (request: { stage: string }, grant: () => boolean) => void) => ({})),
    run: vi.fn(
      async (
        _context: unknown,
        operation: (scope: { execute: typeof execute }) => Promise<unknown>,
        _options?: { createAdmission: () => unknown },
      ) => operation({ execute }),
    ),
    notice: vi.fn<(notice: unknown) => void>(),
    warn: vi.fn(),
  };
});

vi.mock("../infra/sqlite-worker-operation-admission.js", () => ({
  createSqliteWorkerOperationAdmission: edge.admission,
}));
// mock-isolation: Host-control warnings are captured without installing process log transports.
vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: () => ({ warn: edge.warn }) }));
vi.mock("../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: edge.capture,
  captureOpenClawStateReadWorkerContext: edge.capture,
}));
vi.mock("../state/openclaw-state-worker-store.js", () => ({
  runOpenClawStateWorkerOperation: edge.run,
}));
vi.mock("./session-state-notices.js", () => ({ enqueueSessionStateNotice: edge.notice }));

const watcherStorePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
const notice: SessionStateNotice = {
  watcherSessionKey: "agent:main:main",
  watcherStorePath,
  targetSessionKey: "agent:main:child",
  lastSeenSequence: 17,
  queueOnly: false,
};
const row: SessionStateEventRow = {
  sequence: 18,
  dedupe_key: null,
  session_key: "agent:main:child",
  session_id: "child-session",
  agent_id: "main",
  kind: "human_direct_message",
  actor_type: "human",
  actor_id: null,
  run_id: null,
  occurred_at: 1,
  summary: "human message",
  payload_json: null,
};
type Recorded = { rows: SessionStateEventRow[]; notices: SessionStateNotice[] };
const recordedResult: Recorded = { rows: [row], notices: [notice] };
let now = 4_000_000;

function goalChange() {
  return recordSessionGoalChanged({
    sessionKey: "global",
    agentId: "ops",
    entry: {
      sessionId: "original-session",
      updatedAt: 1,
      spawnedBy: "agent:main:main",
      parentSessionKey: "agent:main:other-parent",
    },
    actor: { type: "human", id: "operator" },
    summary: "goal complete",
  });
}

function record(options?: Parameters<typeof recordSessionStateEventAsync>[1]) {
  return recordSessionStateEventAsync(
    {
      sessionKey: "agent:main:sibling",
      agentId: "main",
      kind: "adopted",
      actorType: "system",
      summary: "session adopted",
    },
    options,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Supply the accepted store without loading runtime config or native ownership metadata.
  publishSystemEventStoreResolver(() => watcherStorePath);
  edge.capture.mockImplementation(() => edge.context);
  edge.execute.mockImplementation(async (command) =>
    command.type === "sessionState.prune" ? undefined : recordedResult,
  );
  edge.notice.mockImplementation(() => undefined);
  edge.warn.mockImplementation(() => undefined);
  now += 4_000_000;
  vi.spyOn(Date, "now").mockReturnValue(now);
});

afterEach(() => {
  publishSystemEventStoreResolver(undefined);
  vi.restoreAllMocks();
});

describe("Session signal worker reconciliation", () => {
  it.each(["transaction", "commit"])(
    "refuses a revoked producer at %s admission",
    async (stage) => {
      const recorded = createDeferred<Recorded>();
      edge.execute.mockReturnValueOnce(recorded.promise);
      let current = true;
      const pending = record({
        assertCurrent: () => {
          if (!current) {
            throw new Error("producer retired");
          }
        },
      });
      edge.run.mock.calls.at(-1)![2]!.createAdmission();
      const admit = edge.admission.mock.calls.at(-1)![0];
      current = false;
      const grant = vi.fn(() => true);
      expect(() => admit({ stage }, grant)).toThrow("producer retired");
      expect(grant).not.toHaveBeenCalled();
      recorded.reject(new Error("producer retired"));
      await expect(pending).resolves.toBeUndefined();
      expect(edge.notice).not.toHaveBeenCalled();
    },
  );

  it("keeps watched human-turn recording off the main-thread transaction owner", async () => {
    const recorded = createDeferred<Recorded>();
    edge.execute.mockReturnValueOnce(recorded.promise);
    let settled = false;
    const pending = Promise.resolve(
      recordSessionHumanDirectMessage({
        sessionKey: "agent:main:child",
        entry: { sessionId: "child-session", updatedAt: now, spawnedBy: "agent:main:main" },
        actor: { actorType: "human" },
        channel: "webchat",
      }),
    ).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(edge.notice).not.toHaveBeenCalled();
    recorded.resolve(recordedResult);
    await pending;
    expect(edge.notice).toHaveBeenCalledWith(notice);
    expect(settled).toBe(true);
  });

  it("retains committed notices and pruning before producer settlement", async () => {
    const recorded = createDeferred<Recorded>();
    const recordStarted = createDeferred();
    const pruning = createDeferred();
    const pruneStarted = createDeferred();
    edge.execute.mockImplementation(async (command) => {
      if (command.type === "sessionState.prune") {
        pruneStarted.resolve();
        return pruning.promise;
      }
      recordStarted.resolve();
      return recorded.promise;
    });
    let returned = false;
    const pending = goalChange().then(() => {
      returned = true;
    });
    await recordStarted.promise;
    expect(edge.notice).not.toHaveBeenCalled();
    expect(returned).toBe(false);
    expect(edge.execute.mock.calls[0]?.[0]).toMatchObject({
      input: {
        events: [
          {
            sessionId: "original-session",
            kind: "goal_changed",
            actorType: "human",
            actorId: "operator",
            watcherSessionKeys: ["agent:main:main"],
            watcherStorePaths: { "agent:main:main": watcherStorePath },
          },
        ],
      },
    });
    recorded.resolve(recordedResult);
    await pruneStarted.promise;
    expect(edge.notice).toHaveBeenCalledExactlyOnceWith(notice);
    expect(returned).toBe(false);
    expect(edge.run.mock.calls[0]?.[0]).toBe(edge.context);
    pruning.resolve();
    await pending;
    expect(returned).toBe(true);
  });

  it.each(["capture", "notice", "prune"] as const)(
    "preserves the originating committed result after %s failure without replay",
    async (failure) => {
      const error = Object.assign(new Error("Synthetic event failure"), {
        code: "outcome-unknown",
      });
      if (failure !== "prune") {
        edge[failure].mockImplementationOnce(() => {
          throw error;
        });
      } else {
        edge.execute.mockImplementation(async (command) => {
          if (command.type === "sessionState.prune") {
            throw error;
          }
          return recordedResult;
        });
      }
      await expect(goalChange()).resolves.toBeUndefined();
      expect(
        edge.execute.mock.calls.filter(([command]) => command.type === "sessionState.record"),
      ).toHaveLength(failure === "capture" ? 0 : 1);
      expect(edge.warn).toHaveBeenCalled();
    },
  );

  it.each([false, true])("releases a pending prune reservation after failure=%s", async (fail) => {
    const pruning = createDeferred();
    const pruneStarted = createDeferred();
    const nextPruneStarted = createDeferred();
    let prunes = 0;
    edge.execute.mockImplementation(async (command) => {
      if (command.type === "sessionState.prune") {
        if (++prunes === 2) {
          nextPruneStarted.resolve();
          return;
        }
        pruneStarted.resolve();
        return pruning.promise;
      }
      return { rows: [row], notices: [] };
    });
    const pending = goalChange();
    await pruneStarted.promise;
    await record();
    if (fail) {
      pruning.reject(new Error("Synthetic prune refusal"));
    } else {
      pruning.resolve();
    }
    await pending;
    if (!fail) {
      now += 4_000_000;
      vi.mocked(Date.now).mockReturnValue(now);
    }
    const next = record();
    await nextPruneStarted.promise;
    await next;
    expect(
      edge.execute.mock.calls.filter(([command]) => command.type === "sessionState.prune"),
    ).toHaveLength(2);
  });

  it.each([
    [
      "creation",
      () =>
        recordSessionCreated(
          {},
          {
            sessionKey: "agent:main:main",
            entry: { sessionId: "created", updatedAt: 1, createdActor: { type: "system" } },
          },
        ),
    ],
    [
      "compaction",
      () => recordSessionCompacted({ sessionKey: "agent:main:child", operationId: "compact" }),
    ],
    [
      "spawn",
      () =>
        recordSubagentSpawned({
          childSessionKey: "agent:main:child",
          childRunId: "spawn",
          requesterSessionKey: "agent:main:main",
          agentId: "main",
        }),
    ],
  ] as const)("settles %s once after an unknown signal outcome", async (_name, recordSignal) => {
    edge.execute.mockRejectedValueOnce(
      Object.assign(new Error("Synthetic lost signal reply"), {
        code: "outcome-unknown",
      }),
    );
    await expect(recordSignal()).resolves.toBeUndefined();
    expect(edge.execute).toHaveBeenCalledTimes(1);
    expect(edge.notice).not.toHaveBeenCalled();
  });
});
