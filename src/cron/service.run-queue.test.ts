import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { observeCronJobCommits } from "../../test/helpers/cron/runtime-mutation.js";
import { createDueIsolatedJob } from "../../test/helpers/cron/service-regression-fixtures.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import {
  createAgentDatabaseInspectionRefusal,
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import type { OpenClawDatabaseSchemaPreflight } from "../state/openclaw-database-preflight.types.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { executeOpenClawStateWorker } from "../state/openclaw-state-worker-store.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { resolveCronJobConfigRevision } from "./config-revision.js";
import { cronTestDeps } from "./service.fixture-builders.test-support.js";
import { CronService } from "./service.js";
import {
  createFinishedBarrier,
  createCronServiceWithStateForTest,
  setupCronServiceSuite,
} from "./service.test-harness.js";
import {
  commitCronRunRequests,
  drainCronRunQueue,
  waitForCronRunQueue,
} from "./service/run-queue.js";
import type { CronServiceDeps } from "./service/state.js";
import { onTimer } from "./service/timer.test-support.js";
import { loadCronStore, saveCronStore } from "./store.js";
import { createCronScheduledRunId } from "./store/run-request-id.js";
import { cronStreamScheduleKey } from "./stream-schedule.js";
import type { CronJob } from "./types.js";

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-run-queue-",
  fakeTimers: false,
});

function serviceDeps(storePath: string, overrides: Partial<CronServiceDeps> = {}): CronServiceDeps {
  return cronTestDeps({
    nowMs: () => NOW,
    storePath,
    defaultAgentId: "main",
    log: logger,
    enqueueSystemEvent() {},
    runIsolatedAgentJob: async () => ({ status: "ok" }),
    ...overrides,
  });
}

const service = (storePath: string, overrides: Partial<CronServiceDeps> = {}) =>
  createCronServiceWithStateForTest(serviceDeps(storePath, overrides));
const successfulCommand = () => vi.fn(async () => ({ status: "ok" as const }));
const ready = { incompatible: [], indeterminate: [] };

async function storeJobs(jobs: CronJob[]) {
  const { storePath } = await makeStorePath();
  await saveCronStore(storePath, { version: 1, jobs });
  return storePath;
}

async function stopServices(...services: CronService[]) {
  services.forEach((cron) => cron.stop());
  await Promise.all(services.map((cron) => cron.waitForIdle()));
}

function gatedCommand() {
  const entered = createDeferred();
  const release = createDeferred();
  const runCommandJob = vi.fn(async () => {
    entered.resolve();
    await release.promise;
    return { status: "ok" as const };
  });
  return { entered, release, runCommandJob };
}

function readReceipt(receiptId: string) {
  return runOpenClawStateWriteTransaction(({ db }) =>
    db.prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?").get(receiptId),
  );
}

async function requestStoredRun(
  storePath: string,
  job: CronJob,
  receiptId: string,
  scheduled = false,
) {
  const context = captureOpenClawStateWorkerContext();
  await executeOpenClawStateWorker(context, { type: "cron.initializeRunReceipts", input: {} });
  const requested = await executeOpenClawStateWorker(context, {
    type: "cron.requestRuns",
    input: {
      storeKey: storePath,
      nowMs: NOW,
      ...(scheduled ? { defaultAgentId: "main" } : {}),
      requests: [
        {
          jobId: job.id,
          receiptId,
          configRevision: resolveCronJobConfigRevision(job),
          mode: scheduled ? "scheduled" : "force",
          ...(scheduled ? { scheduledSlotMs: NOW, scheduleOwnershipAtMs: NOW } : {}),
        },
      ],
    },
  });
  expect(requested.accepted).toHaveLength(1);
  return context;
}

type StartupAdmission = Parameters<Parameters<typeof withAgentDatabaseStartupAdmission>[0]>[0];
function deferAdmission(
  admission: StartupAdmission,
  agentIds: string[],
  env: NodeJS.ProcessEnv = { ...process.env },
  isCurrent = () => true,
) {
  const inspections = agentIds.map(() => createDeferred<OpenClawDatabaseSchemaPreflight>());
  const refusals = admission.defer({
    env,
    reason: "synthetic cron startup admission",
    inspections: agentIds.map((agentId, index) => ({
      target: { agentId, path: openOpenClawAgentDatabase({ agentId, env }).path },
      result: inspections[index]!.promise,
    })),
  });
  recordAgentDatabaseAdmissions(refusals, { env, source: "startup" });
  const lifetime = admission.adopt();
  admission.activate({
    isCurrent,
    preparationReady: Promise.resolve(),
    openAgent: async () => {},
    migrateAgent: async () => {},
    publishAgent: async () => {},
  });
  return { refusals, lifetime, env, inspections, inspection: inspections[0]! };
}

function commandJob(id: string, nextRunAtMs = NOW + 60_000): CronJob {
  return {
    ...createDueIsolatedJob({ id, nowMs: NOW, nextRunAtMs }),
    agentId: "main",
    payload: { kind: "command", argv: ["synthetic", id] },
  };
}

it.for(["startup", "scheduled"] as const)(
  "keeps preparing jobs queued without blocking initialization or a healthy agent: %s",
  async (source, { signal }) => {
    const slowJobs = Array.from({ length: 8 }, (_, index) => ({
      ...commandJob(`slow-${index}`, NOW - 1_000),
      agentId: "preparing",
    }));
    const healthyJob = commandJob("healthy", NOW - 1_000);
    const jobs = [...slowJobs, healthyJob];
    const storePath = await storeJobs(jobs);
    await withAgentDatabaseStartupAdmission(async (admission) => {
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: path.join(path.dirname(storePath), "admission-state"),
      };
      const {
        refusals: refusal,
        lifetime,
        inspections,
      } = deferAdmission(admission, ["preparing", "main"], env);
      const [inspection, healthyInspection] = inspections;
      const healthy = gatedCommand();
      const finished = createFinishedBarrier();
      const healthyFinished = finished.waitForOk(healthyJob.id);
      const allFinished = Promise.all(slowJobs.map((job) => finished.waitForOk(job.id)));
      const ran: string[] = [];
      const { cron, state } = service(storePath, {
        env,
        onEvent: finished.onEvent,
        isAgentAvailable: (agentId) => !readAgentDatabaseAdmissionRefusal(agentId, { env }),
        runCommandJob: async ({ job }) => {
          ran.push(job.id);
          if (job.id === healthyJob.id) {
            await healthy.runCommandJob();
          }
          return { status: "ok" };
        },
      });
      let completed: Promise<unknown> | undefined;
      try {
        if (source !== "startup") {
          healthyInspection!.resolve(ready);
        }
        completed = source === "startup" ? cron.start() : onTimer(state);
        void completed.catch(() => {});
        if (source === "startup") {
          await withinTest(completed, signal);
          expect(ran).toEqual([]);
          expect((await loadCronStore(storePath)).jobs.map((job) => job.state.queuedAtMs)).toEqual(
            jobs.map(() => NOW),
          );
          healthyInspection!.resolve(ready);
        }
        await withinTest(healthy.entered.promise, signal);
        expect(ran).toEqual([healthyJob.id]);
        const queued = (await loadCronStore(storePath)).jobs.filter(
          (job) => job.agentId === "preparing",
        );
        expect(queued.map((job) => [job.state.queuedAtMs, job.state.runningAtMs])).toEqual(
          slowJobs.map(() => [NOW, undefined]),
        );
        healthy.release.resolve();
        await withinTest(healthyFinished, signal);
        await drainCronRunQueue(state);
        // A different service can still be preparing the same agent id.
        recordAgentDatabaseAdmissions(
          refusal
            .filter((entry) => entry.agentId === "preparing")
            .map((entry) => createAgentDatabaseInspectionRefusal({ ...entry, pending: true })),
          { source: "startup" },
        );
        inspection!.resolve(ready);
        await withinTest(Promise.all([completed, allFinished]), signal);
        expect(ran).toEqual([healthyJob.id, ...slowJobs.map((job) => job.id)]);
      } finally {
        healthy.release.resolve();
        inspections.forEach((entry) => entry.resolve(ready));
        cron.stop();
        await Promise.all([cron.waitForIdle(), lifetime.stop()]);
        recordAgentDatabaseAdmissions([], { source: "startup" });
        recordAgentDatabaseAdmissions([], { env, source: "startup" });
      }
    });
  },
);

it.for([
  { outcome: "ready", error: undefined, stopped: false },
  { outcome: "inspection-failed", error: "synthetic terminal inspection failure", stopped: false },
  { outcome: "ownership-lost", error: "Gateway no longer owns preparation", stopped: false },
  { outcome: "service-stopped", error: undefined, stopped: true },
  { outcome: "gateway-stopped", error: undefined, stopped: true },
])(
  "retains cron custody beyond the foreground admission budget: $outcome",
  async ({ outcome, error, stopped }, { signal }) => {
    const job = { ...commandJob("slow-startup"), agentId: "preparing" };
    const storePath = await storeJobs([job]);
    await withAgentDatabaseStartupAdmission(async (admission) => {
      let ownsPreparation = true;
      const { lifetime, env, inspection } = deferAdmission(
        admission,
        [job.agentId],
        undefined,
        () => ownsPreparation,
      );
      const observed = createDeferred();
      const waitForPreparation = admission.waitForAgentPreparation.bind(admission);
      vi.spyOn(admission, "waitForAgentPreparation").mockImplementation((id, options) => {
        const waiting = waitForPreparation(id, options);
        observed.resolve();
        return waiting;
      });
      const runCommandJob = successfulCommand();
      const { cron, state } = service(storePath, { runCommandJob });
      try {
        const requests = await commitCronRunRequests(state, [job], {
          source: "manual",
          mode: "force",
        });
        const request = expectDefined(requests[0], "queued cron request");
        const receiptStatus = () => readReceipt(request.runReceipt.receiptId);
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        await drainCronRunQueue(state);
        await withinTest(observed.promise, signal);
        // A foreground request expires, while the same startup owner keeps preparing.
        const foreground = waitForPreparation(job.agentId, { env, forWrite: true });
        const timedOut = expect(foreground).rejects.toThrow("still preparing");
        await vi.advanceTimersByTimeAsync(360_001);
        await timedOut;
        vi.useRealTimers();
        expect(receiptStatus()).toEqual({ status: "running" });
        const queued = (await loadCronStore(storePath)).jobs[0]?.state;
        expect(queued?.queuedAtMs).toBe(NOW);
        expect(queued?.runningAtMs).toBeUndefined();
        expect(runCommandJob).not.toHaveBeenCalled();

        if (outcome === "service-stopped") {
          cron.stop();
        } else if (outcome === "gateway-stopped") {
          const stopping = lifetime.stop();
          inspection.resolve(ready);
          await stopping;
        } else if (outcome === "inspection-failed") {
          inspection.reject(new Error(error));
        } else {
          ownsPreparation = outcome !== "ownership-lost";
          inspection.resolve(ready);
        }
        if (error) {
          await expect(withinTest(request.completion, signal)).rejects.toThrow(error);
        } else {
          const result = await withinTest(request.completion, signal);
          if (stopped) {
            expect(result).toMatchObject({ ran: false, reason: "stopped" });
          }
        }
        await withinTest(waitForCronRunQueue(state), signal);
        expect(receiptStatus()).toEqual({ status: stopped ? "running" : error ? "skipped" : "ok" });
        expect((await loadCronStore(storePath)).jobs[0]?.state.queuedAtMs).toBe(
          stopped ? NOW : undefined,
        );
        expect(runCommandJob).toHaveBeenCalledTimes(outcome === "ready" ? 1 : 0);
        if (!stopped) {
          await drainCronRunQueue(state);
          expect(runCommandJob).toHaveBeenCalledTimes(outcome === "ready" ? 1 : 0);
        }
      } finally {
        vi.useRealTimers();
        inspection.resolve(ready);
        cron.stop();
        await Promise.all([cron.waitForIdle(), lifetime.stop()]);
        recordAgentDatabaseAdmissions([], { env, source: "startup" });
      }
    });
  },
);

it.for(["complete", "cancel", "lost-result"] as const)(
  "handles a same-store on-exit predecessor without joining unrelated work: %s",
  async (outcome, { signal }) => {
    const schedule = { kind: "on-exit", command: "synthetic-exit" } as const;
    const job = { ...commandJob("exit-wait"), schedule };
    const unrelated = commandJob("unrelated-wait");
    const storePath = await storeJobs([job, unrelated]);
    const target = gatedCommand();
    const other = gatedCommand();
    const accepted = createDeferred();
    let targetRuns = 0;
    const runCommandJob = vi.fn(async ({ job: current }: { job: CronJob }) => {
      if (current.id === unrelated.id) {
        await other.runCommandJob();
      } else if (++targetRuns === 1) {
        await target.runCommandJob();
      }
      return { status: "ok" as const };
    });
    const createService = () => new CronService(serviceDeps(storePath, { runCommandJob }));
    const cron = createService();
    const sibling = createService();
    const controller = new AbortController();
    const pending: Array<Promise<unknown>> = [];
    let restoreFinalization: (() => void) | undefined;
    try {
      const first = cron.run(job.id, "force");
      void first.catch(() => {});
      pending.push(first, cron.run(unrelated.id, "force"));
      await withinTest(Promise.all([target.entered.promise, other.entered.promise]), signal);
      if (outcome === "lost-result") {
        const execute = stateWorker.executeOpenClawStateWorker;
        const finalization = vi
          .spyOn(stateWorker, "executeOpenClawStateWorker")
          .mockImplementation((context, command) =>
            command.type === "cron.finalizeRuns"
              ? Promise.reject(new Error("synthetic terminal write failure"))
              : execute(context, command),
          );
        restoreFinalization = () => finalization.mockRestore();
      }
      const exit = sibling.runOnExit(job.id, {
        schedule,
        signal: controller.signal,
        commitGuard() {},
        onReserved: () => accepted.resolve(),
      });
      pending.push(exit);
      if (outcome === "cancel") {
        controller.abort();
        await expect(withinTest(exit, signal)).resolves.toMatchObject({
          ok: true,
          ran: false,
          reason: "stopped",
        });
        target.release.resolve();
        await withinTest(first, signal);
      } else if (outcome === "lost-result") {
        target.release.resolve();
        await expect(withinTest(first, signal)).rejects.toThrow("synthetic terminal write failure");
        await expect(withinTest(exit, signal)).resolves.toMatchObject({
          ok: true,
          ran: false,
          reason: "already-running",
        });
      } else {
        target.release.resolve();
        await withinTest(accepted.promise, signal);
        await expect(withinTest(exit, signal)).resolves.toMatchObject({ ok: true, ran: true });
      }
      expect(targetRuns).toBe(outcome === "complete" ? 2 : 1);
      expect((await cron.readJob(unrelated.id))?.state.runningAtMs).toBeDefined();
    } finally {
      controller.abort();
      restoreFinalization?.();
      target.release.resolve();
      other.release.resolve();
      await Promise.allSettled(pending);
      await stopServices(cron, sibling);
    }
  },
);

it("preserves owned work on repeated start and joins it after scheduler cleanup fails", async ({
  signal,
}) => {
  const job = commandJob("restart-after-cleanup");
  const storePath = await storeJobs([job]);
  const { entered, release, runCommandJob } = gatedCommand();
  const cleanupFailed = createDeferred();
  const { cron, state } = service(storePath, { runCommandJob });
  const pending: Array<Promise<unknown>> = [];
  let restoreStop: (() => void) | undefined;
  try {
    await cron.start();
    const running = cron.run(job.id, "force");
    pending.push(running);
    await withinTest(entered.promise, signal);
    await cron.start();
    const active = await cron.readJob(job.id);
    expect(active?.state).toMatchObject({ runningAtMs: NOW, runningReceiptId: expect.any(String) });
    expect(active?.state.lastError).toBeUndefined();
    const stopScope = state.schedulerScope.stop.bind(state.schedulerScope);
    const stop = vi.spyOn(state.schedulerScope, "stop").mockImplementationOnce(async () => {
      await stopScope();
      cleanupFailed.resolve();
      throw new Error("synthetic scheduler cleanup failure");
    });
    restoreStop = () => stop.mockRestore();
    cron.stop();
    const restarting = cron.start();
    pending.push(restarting);
    void restarting.catch(() => {});
    await withinTest(cleanupFailed.promise, signal);
    expect(state.stopped).toBe(true);
    release.resolve();
    await withinTest(Promise.all([running, restarting]), signal);
    expect(await cron.readJob(job.id)).toMatchObject({ state: { lastRunStatus: "ok" } });
    await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
    expect(runCommandJob).toHaveBeenCalledTimes(2);
  } finally {
    release.resolve();
    restoreStop?.();
    await Promise.allSettled(pending);
    await stopServices(cron);
  }
});

it("shares capacity across sibling services for timer, manual, stream, and consumed exit requests", async ({
  signal,
}) => {
  const clock = createGatewaySchedulerClock(NOW);
  const release = createDeferred();
  const capacityFilled = createDeferred();
  const exitAccepted = createDeferred();
  const timerRequested = createDeferred();
  const blockers = Array.from({ length: 8 }, (_, index) => commandJob(`blocker-${index}`));
  const manual = commandJob("queued-manual");
  const timed = commandJob("queued-timer", NOW + 10_000);
  const exitSchedule = { kind: "on-exit" as const, command: "synthetic-watch" };
  const exit: CronJob = { ...commandJob("queued-exit"), schedule: exitSchedule, state: {} };
  const streamSchedule = { kind: "stream" as const, command: ["synthetic-stream"] };
  const stream: CronJob = {
    ...commandJob("queued-stream"),
    schedule: streamSchedule,
    payload: { kind: "agentTurn", message: "configured stream payload" },
    state: { streamSourceIdentity: "synthetic-source" },
  };
  const storePath = await storeJobs([...blockers, manual, timed, stream, exit]);
  let active = 0;
  let peakActive = 0;
  let blockersStarted = 0;
  const executed: CronJob[] = [];
  const runCommandJob = vi.fn(async ({ job }: { job: CronJob }) => {
    active += 1;
    peakActive = Math.max(peakActive, active);
    try {
      if (job.id.startsWith("blocker-")) {
        blockersStarted += 1;
        if (blockersStarted === 8) {
          capacityFilled.resolve();
        }
        await release.promise;
      } else {
        executed.push(structuredClone(job));
      }
      return { status: "ok" as const };
    } finally {
      active -= 1;
    }
  });
  const runIsolatedAgentJob = successfulCommand();
  const createService = () =>
    service(storePath, {
      scheduler: createTestGatewayScheduler(clock.clock),
      nowMs: clock.clock.now,
      runCommandJob,
      runIsolatedAgentJob,
    });
  const { cron, state } = createService();
  const { cron: sibling } = createService();
  sibling.pauseScheduling();
  const pending: Array<Promise<unknown>> = [];
  const stopObserving = observeCronJobCommits(timed.id, (runtime) => {
    if (runtime.queuedAtMs !== undefined) {
      timerRequested.resolve();
    }
  });
  try {
    await cron.start();
    pending.push(...blockers.map((job) => cron.run(job.id, "force")));
    await withinTest(capacityFilled.promise, signal);

    await clock.advanceBy(10_000);
    const tick = onTimer(state);
    pending.push(tick);
    await withinTest(
      awaitGateBeforeSettlement(timerRequested.promise, tick, "timer did not queue its due job"),
      signal,
    );
    const manualAck = await cron.enqueueRun(manual.id, "force");
    expect(manualAck).toMatchObject({ ok: true, enqueued: true });
    const streamRun = sibling.run(stream.id, "force", {
      payload: { kind: "agentTurn", message: "accepted stream payload" },
      streamBatch: "line one\nline two",
      streamScheduleKey: cronStreamScheduleKey(streamSchedule),
      streamSourceIdentity: "synthetic-source",
    });
    pending.push(streamRun);
    const exitRun = sibling.runOnExit(exit.id, {
      schedule: exitSchedule,
      signal,
      commitGuard() {},
      onReserved: () => exitAccepted.resolve(),
      payload: () => ({ kind: "command", argv: ["synthetic", "accepted exit"] }),
    });
    pending.push(exitRun);
    await withinTest(
      awaitGateBeforeSettlement(exitAccepted.promise, exitRun, "exit was not accepted"),
      signal,
    );

    const queued = (await loadCronStore(storePath)).jobs;
    for (const job of [manual, timed, stream, exit]) {
      expect(
        queued.find((candidate) => candidate.id === job.id)?.state.queuedAtMs,
        `${job.id}: queued run remains behind shared capacity`,
      ).toEqual(expect.any(Number));
    }
    expect(queued.find((job) => job.id === exit.id)?.enabled).toBe(false);
    expect(executed).toEqual([]);
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();

    release.resolve();
    await withinTest(Promise.all(pending), signal);
    if (!manualAck.ok || !("runId" in manualAck)) {
      throw new Error("Expected the accepted manual request ID");
    }
    expect(await cron.waitForManualRun(manualAck.runId, 60_000, signal)).toBe(true);
    expect(peakActive).toBe(8);
    expect(executed.map((job) => job.id).toSorted()).toEqual(
      [exit.id, manual.id, timed.id].toSorted(),
    );
    expect(executed.find((job) => job.id === exit.id)).toMatchObject({
      enabled: false,
      payload: { kind: "command", argv: ["synthetic", "accepted exit"] },
    });
    expect(runIsolatedAgentJob).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "accepted stream payload\n\nline one\nline two" }),
    );
    const persistedExit = (await loadCronStore(storePath)).jobs.find((job) => job.id === exit.id);
    expect(persistedExit).toMatchObject({ enabled: false, state: { lastRunStatus: "ok" } });
  } finally {
    release.resolve();
    stopObserving();
    await Promise.allSettled(pending);
    await stopServices(cron, sibling);
  }
});

it("retires a stale markerless receipt at startup so the job can run again", async () => {
  const job = commandJob("markerless-receipt");
  const storePath = await storeJobs([job]);
  const receiptId = "cron:request:markerless-receipt";
  const context = await requestStoredRun(storePath, job, receiptId);
  const active = await executeOpenClawStateWorker(context, {
    type: "cron.drainQueue",
    input: {
      storeKey: storePath,
      nowMs: NOW,
      maxConcurrentRuns: 1,
      requests: [{ receiptId, mode: "force" }],
    },
  });
  expect(active.launches).toHaveLength(1);
  // Model a crash after job finalization but before the deferred receipt finish.
  runOpenClawStateWriteTransaction(({ db }) => {
    db.prepare(
      "UPDATE cron_jobs SET state_json = json_remove(state_json, '$.runningAtMs', '$.runningReceiptId') WHERE store_key = ? AND job_id = ?",
    ).run(storePath, job.id);
  });
  expect(readReceipt(receiptId)).toEqual({ status: "running" });
  const runCommandJob = successfulCommand();
  const { cron } = service(storePath, { runCommandJob });
  try {
    await cron.start();
    expect(readReceipt(receiptId)).toEqual({ status: "interrupted" });
    expect(runCommandJob).not.toHaveBeenCalled();
    expect(await cron.run(job.id, "force")).toEqual({ ok: true, ran: true });
    expect(runCommandJob).toHaveBeenCalledOnce();
    expect(readReceipt(receiptId)).toEqual({ status: "interrupted" });
    expect((await loadCronStore(storePath)).jobs[0]?.state.lastRunStatus).toBe("ok");
  } finally {
    await stopServices(cron);
  }
});

it("contains recovered scheduled launch failures without an unhandled rejection", async () => {
  const job = commandJob("recovered-launch-failure", NOW);
  const storePath = await storeJobs([job]);
  const receiptId = createCronScheduledRunId(storePath, job.id, NOW);
  await requestStoredRun(storePath, job, receiptId, true);
  const { cron, state } = service(storePath, {
    runSchedulerOwned: async () => {
      throw new Error("scheduler owner is retired");
    },
  });
  // Durable requests survive restart; this new owner has no caller completion to observe.
  state.store = await loadCronStore(storePath);
  try {
    await drainCronRunQueue(state);
    await waitForCronRunQueue(state);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    // Vitest fails on unhandled rejections; the event-loop turn above exposes late ones.
    const persisted = (await loadCronStore(storePath)).jobs[0];
    expect(persisted?.state.queuedAtMs).toBeUndefined();
    expect(persisted?.state.runningAtMs).toBeUndefined();
  } finally {
    await stopServices(cron);
  }
});
