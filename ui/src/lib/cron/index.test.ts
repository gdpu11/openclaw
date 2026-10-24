// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  validateCronAddParams,
  validateCronUpdateParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createRequireRecord } from "../../../../test/helpers/record.js";
import type { CronJob, CronJobsListResult } from "../../api/types.ts";
import { parseCronDurationMs } from "../../lib/cron/decimal.ts";
import {
  addCronJob,
  toggleCronJob,
  loadCronJobsPage,
  loadCronScopeStats,
  removeCronJob,
  startCronEdit,
  startCronClone,
} from "../../lib/cron/index.ts";
import type { CronState } from "../../lib/cron/types.ts";
import { DEFAULT_CRON_FORM } from "../../test-helpers/cron.ts";
import {
  createCronJob,
  createMethodRequest,
  createStateWithRequest,
  cronJobsListResponse,
} from "./cron.test-support.ts";
import { createInitialCronState } from "./state.ts";

function createCronRequest(jobId: string, options: { existing?: boolean } = {}) {
  const existingJob = createCronJob(jobId, "Existing job");
  const jobs = options.existing ? [existingJob] : [];
  return createMethodRequest({
    "cron.add": { job: { id: jobId } },
    "cron.update": existingJob,
    "cron.list": cronJobsListResponse(jobs),
    "cron.status": { enabled: true, jobs: jobs.length, nextWakeAtMs: null },
  });
}

function createCronSubmitHarness(jobId: string, form: Partial<CronState["cronForm"]> = {}) {
  const request = createCronRequest(jobId);
  const state = createStateWithRequest(request);
  state.cronForm = { ...DEFAULT_CRON_FORM, name: jobId, payloadText: "run", ...form };
  const submit = async () => {
    const result = await addCronJob(state);
    return { call: sent(request), result };
  };
  return { request, state, submit };
}

function createCronEditHarness(
  job: CronJob,
  request = createCronRequest(job.id, { existing: true }),
  overrides: Partial<CronState> = {},
) {
  const state = createStateWithRequest(request, { cronJobs: [job], ...overrides });
  startCronEdit(state, job);
  const submit = async () => {
    expect(await addCronJob(state)).toEqual({ saved: true, jobId: job.id });
    return sent(request, "cron.update");
  };
  return { request, state, submit };
}

function cloneHarness(source: CronJob, overrides: Partial<CronState> = {}) {
  const request = createCronRequest("clone");
  const state = createStateWithRequest(request, { cronJobs: [source], ...overrides });
  startCronClone(state, source);
  const submit = async () => {
    expect(await addCronJob(state)).toEqual({ saved: true, jobId: "clone" });
    const call = sent(request);
    expect(validateCronAddParams(call)).toBe(true);
    return call;
  };
  return { request, state, submit };
}

function revisionConflict() {
  return Object.assign(new Error("cron job definition changed"), {
    details: { code: "CRON_JOB_CHANGED" },
  });
}

const requireRecord = createRequireRecord("record", "expected-label-record");
const hiddenPolicy = {
  toolsAllow: ["read"],
  fallbacks: [],
  allowUnsafeExternalContent: true,
  lightContext: false,
};

function requestPatch(call: Record<string, unknown>) {
  return requireRecord(call.patch, "cron.update patch");
}

function sent(request: ReturnType<typeof createMethodRequest>, method = "cron.add") {
  const call = request.mock.calls.find(([name]) => name === method);
  if (!call) {
    throw new Error(`Expected ${method} request call`);
  }
  return requireRecord(call[1], `${method} payload`);
}

describe("cron controller", () => {
  it.each<
    [
      string,
      Partial<CronJob>,
      Partial<CronState["cronForm"]>,
      Record<string, unknown>,
      Partial<CronState["cronForm"]>?,
      string[]?,
    ]
  >([
    [
      "explicit zero timeout",
      {},
      { timeoutSeconds: "0" },
      { payload: { kind: "agentTurn", message: "run", timeoutSeconds: 0 } },
    ],
    [
      "cleared payload overrides",
      {
        payload: {
          kind: "agentTurn",
          message: "run",
          model: "openai/gpt-5.5",
          thinking: "high",
          timeoutSeconds: 0,
        },
      },
      { payloadModel: "", payloadThinking: "", timeoutSeconds: "" },
      {
        payload: {
          kind: "agentTurn",
          message: "run",
          model: null,
          thinking: null,
          timeoutSeconds: null,
        },
      },
      { timeoutSeconds: "0" },
    ],
    [
      "Gateway-owned hidden policy",
      {
        payload: { kind: "agentTurn", message: "run", ...hiddenPolicy, toolsAllowIsDefault: true },
      },
      { description: "Metadata changed" },
      { payload: { kind: "agentTurn", message: "run", lightContext: false } },
      { timeoutSeconds: "" },
    ],
    [
      "exact event timing and cleared owner",
      {},
      { clearAgent: true, scheduleExact: true, payloadKind: "systemEvent", payloadText: "updated" },
      {
        agentId: null,
        schedule: { kind: "cron", expr: "0 * * * *", staggerMs: 0 },
        payload: { kind: "systemEvent", text: "updated" },
        delivery: expect.objectContaining({ mode: "none" }),
      },
      {},
      ["deleteAfterRun"],
    ],
    [
      "cleared delivery routing",
      { delivery: { mode: "announce", channel: "telegram", to: "123", accountId: "ops" } },
      { deliveryChannel: "last", deliveryTo: " ", deliveryAccountId: " " },
      {
        delivery: expect.objectContaining({
          mode: "announce",
          channel: "last",
          to: null,
          accountId: null,
        }),
      },
    ],
    [
      "zero cooldown",
      { failureAlert: { cooldownMs: 0 } },
      { description: "Metadata changed" },
      { failureAlert: expect.objectContaining({ cooldownMs: 0 }) },
      { failureAlertCooldownSeconds: "0" },
    ],
    [
      "maximum safe cooldown",
      { failureAlert: { cooldownMs: Number.MAX_SAFE_INTEGER } },
      { description: "Metadata changed" },
      { failureAlert: expect.objectContaining({ cooldownMs: Number.MAX_SAFE_INTEGER }) },
      { failureAlertCooldownSeconds: "9007199254740.991" },
    ],
  ])("saves %s", async (_name, stored, form, expected, before, absent = []) => {
    const job = createCronJob("job", "Stored job", stored);
    const original = structuredClone(job);
    const { state, submit } = createCronEditHarness(job);
    if (before) {
      expect(state.cronForm).toMatchObject(before);
    }
    Object.assign(state.cronForm, form);
    const call = await submit();
    expect(validateCronUpdateParams(call)).toBe(true);
    const patch = requestPatch(call);
    for (const [key, value] of Object.entries(expected)) {
      expect(patch[key]).toEqual(value);
    }
    for (const key of absent) {
      expect(patch).not.toHaveProperty(key);
    }
    expect(job).toEqual(original);
  });

  it.each([
    {
      name: "Webhook",
      form: { deliveryMode: "webhook", deliveryTo: "https://example.invalid/cron" },
      delivery: expect.objectContaining({ mode: "webhook", to: "https://example.invalid/cron" }),
    },
    {
      name: "Main event",
      form: {
        sessionTarget: "main",
        payloadKind: "systemEvent",
        deliveryMode: "announce",
        deliveryTo: "buddy",
      },
      delivery: { mode: "none" },
    },
  ] as const)("submits normalized delivery for $name", async ({ name, form, delivery }) => {
    const { state, submit } = createCronSubmitHarness(name, form);
    const { call, result } = await submit();
    expect(result).toEqual({ saved: true, jobId: name });
    expect(call.name).toBe(name);
    expect(call.delivery).toEqual(delivery);
    expect(state.cronForm.deliveryMode).toBe("none");
  });

  it("requires a loaded config revision before form saves and toggles", async () => {
    const job = createCronJob("job-missing-revision", "Missing revision", {
      configRevision: undefined,
    });
    const request = vi.fn(async () => {
      throw new Error("unguarded mutation should not be issued");
    });
    const saveState = createStateWithRequest(request, { cronJobs: [job] });
    startCronEdit(saveState, job);
    saveState.cronForm.name = "Unsafe edit";

    await expect(addCronJob(saveState)).resolves.toEqual({ saved: false });
    expect(saveState.cronEditingJob?.id).toBe(job.id);
    expect(saveState.cronError).toContain("configuration revision");
    expect(request).not.toHaveBeenCalled();

    const toggleState = createStateWithRequest(request, { cronJobs: [job] });
    await expect(toggleCronJob(toggleState, job, false)).resolves.toBe(false);
    expect(toggleState.cronError).toContain("configuration revision");
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps the draft's frozen revision when exact conflict recovery fails", async () => {
    const stale = createCronJob("conflict", "Loaded", { configRevision: "stale" });
    const current = { ...stale, name: "Current", configRevision: "current" };
    const firstList = createDeferred<CronJobsListResult>();
    const list = vi
      .fn()
      .mockReturnValueOnce(firstList.promise)
      .mockResolvedValue(cronJobsListResponse([current]));
    const revisions: unknown[] = [];
    const request = createMethodRequest(
      { "cron.status": { enabled: true, jobs: 1 } },
      {
        "cron.update": (payload) => {
          revisions.push(requireRecord(payload, "update").expectedConfigRevision);
          throw revisionConflict();
        },
        "cron.list": list,
        "cron.get": () => {
          throw new Error("Exact refresh unavailable");
        },
      },
    );
    const { state } = createCronEditHarness(stale, request);
    state.cronForm.name = "Unsaved";
    const pending = loadCronJobsPage(state, { tableFilters: true });
    expect(list).toHaveBeenCalledOnce();
    expect(await addCronJob(state)).toEqual({ saved: false });
    expect(state.cronForm.name).toBe("Unsaved");
    expect(state.cronEditingJob?.configRevision).toBe("stale");
    expect(state.cronError).toContain("could not be loaded");
    firstList.resolve(cronJobsListResponse([current]));
    await pending;
    expect(state).toMatchObject({
      cronJobs: [current],
      cronForm: { name: "Unsaved" },
      cronEditingJob: { configRevision: "stale" },
    });
    expect(await addCronJob(state)).toEqual({ saved: false });
    expect(revisions).toEqual(["stale", "stale"]);
  });

  it("commits authoritative toggle state and advances an open editor revision", async () => {
    const loadedJob = createCronJob("job-authoritative-toggle", "Toggle job", {
      enabled: true,
      configRevision: "revision-loaded",
    });
    const updatedJob = {
      ...loadedJob,
      enabled: false,
      updatedAtMs: 2,
      configRevision: "revision-toggled",
    };
    const listResponse = createDeferred<CronJobsListResult>();
    const request = createMethodRequest({
      "cron.update": updatedJob,
      "cron.list": listResponse.promise,
      "cron.status": { enabled: true, jobs: 1 },
    });
    const { state } = createCronEditHarness(loadedJob, request);
    state.cronForm.name = "Unsaved rename";

    const toggle = toggleCronJob(state, loadedJob, false);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("cron.list", expect.anything()));

    expect(request).toHaveBeenCalledWith("cron.update", {
      id: loadedJob.id,
      expectedConfigRevision: "revision-loaded",
      patch: { enabled: false },
    });
    expect(state.cronJobs).toEqual([updatedJob]);
    expect(state.cronEditingJob).toEqual(updatedJob);
    expect(state.cronForm.name).toBe("Unsaved rename");

    listResponse.resolve(cronJobsListResponse([updatedJob]));
    await expect(toggle).resolves.toBe(true);

    await addCronJob(state);
    const updateCalls = request.mock.calls.filter(([method]) => method === "cron.update");
    expect(updateCalls[1]?.[1]).toMatchObject({
      expectedConfigRevision: "revision-toggled",
      patch: { name: "Unsaved rename" },
    });
  });

  it("removes confirmed jobs locally before a failed reconciliation", async () => {
    const removedJob = createCronJob("job-remove-local", "Remove locally");
    const remainingJob = createCronJob("job-remaining", "Keep locally");
    const request = createMethodRequest(
      {
        "cron.remove": { ok: true, removed: true },
        "cron.status": { enabled: true, jobs: 1 },
      },
      {
        "cron.list": () => {
          throw new Error("reconciliation unavailable");
        },
      },
    );
    const { state } = createCronEditHarness(removedJob, request, {
      cronJobs: [removedJob, remainingJob],
      cronJobsTotal: 2,
      cronRunsJobId: removedJob.id,
      cronRuns: [{ ts: 1, jobId: removedJob.id, action: "finished", status: "ok" }],
    });

    await removeCronJob(state, removedJob);

    expect(state.cronJobs).toEqual([remainingJob]);
    expect(state.cronJobsTotal).toBe(1);
    expect(state.cronEditingJob).toBeNull();
    expect(state.cronRunsJobId).toBeNull();
    expect(state.cronRuns).toEqual([]);
  });

  it("requires an explicit delivery choice before editing an unknown persisted mode", async () => {
    const job = createCronJob("legacy-delivery", "Garden summary", {
      delivery: { mode: "announce", channel: "telegram", to: "garden-room" },
    });
    Reflect.set(job.delivery!, "mode", "unknown");
    const original = structuredClone(job);
    const { request, state } = createCronEditHarness(job);
    state.cronForm.name = "Renamed garden summary";
    expect(await addCronJob(state)).toEqual({ saved: false });
    expect(request.mock.calls.some(([method]) => method === "cron.update")).toBe(false);
    expect(job).toEqual(original);
    expect(state.cronFieldErrors.deliveryMode).toBe("cron.errors.deliveryModeRequired");

    state.cronForm.deliveryMode = "announce";
    expect(await addCronJob(state)).toMatchObject({ saved: true, jobId: job.id });
    const patch = requestPatch(sent(request, "cron.update"));
    expect(patch).toMatchObject({
      name: "Renamed garden summary",
      delivery: { mode: "announce", channel: "telegram", to: "garden-room" },
    });
    expect(validateCronUpdateParams(sent(request, "cron.update"))).toBe(true);
  });

  it("accepts prefixed-number stagger input", async () => {
    const { call, result } = await createCronSubmitHarness("stagger", {
      scheduleKind: "cron",
      cronExpr: "0 * * * *",
      staggerAmount: "0x10",
      staggerUnit: "seconds",
    }).submit();
    expect(result.saved).toBe(true);
    expect(call.schedule).toEqual({
      kind: "cron",
      expr: "0 * * * *",
      staggerMs: 16_000,
    });
    expect(validateCronAddParams(call)).toBe(true);
  });

  it("preserves the trigger draft and inventory when its syntax is rejected", async () => {
    const job = createCronJob("syntax", "Conditional job", {
      trigger: { script: "return { fire: true }" },
    });
    const { request, state } = createCronEditHarness(job);
    state.cronForm.triggerScript = "const x = ;";
    request.mockRejectedValue(new Error("Invalid trigger syntax"));
    expect(await addCronJob(state)).toEqual({ saved: false });
    expect(state.cronError).toBe("Invalid trigger syntax");
    expect(state.cronForm.triggerScript).toBe("const x = ;");
    expect(state.cronJobs).toEqual([job]);
    expect(state.cronEditingJob).toBe(job);
  });

  it("requires an explicit clear before saving an existing script payload with a condition trigger", async () => {
    const job = createCronJob("job-script-trigger-conflict", "Conflicting script", {
      schedule: { kind: "every", everyMs: 30_000 },
      payload: { kind: "script", script: "json({ state: {} })" },
      trigger: { script: "json({ fire: true })" },
    });
    const { request, state, submit } = createCronEditHarness(job);

    expect(state.cronForm.triggerEnabled).toBe(true);
    expect(await addCronJob(state)).toEqual({ saved: false });
    expect(state.cronFieldErrors.triggerScript).toBe("cron.errors.triggerScriptPayloadUnsupported");
    expect(request).not.toHaveBeenCalled();

    state.cronForm.triggerEnabled = false;
    const call = await submit();

    expect(requestPatch(call).trigger).toBeNull();
    expect(requestPatch(call)).not.toHaveProperty("payload");
  });

  it.each([
    [
      "custom",
      {
        channel: "last",
        mode: null,
        includeSkipped: true,
        after: null,
        to: null,
        cooldownMs: null,
        accountId: null,
      },
    ],
    ["inherit", null],
  ] as const)("clears persisted failure alert overrides with %s", async (mode, expected) => {
    const job = createCronJob("job-clear-alert-fields", "Clear failure alert fields", {
      delivery: { mode: "announce" },
      failureAlert: {
        after: 2,
        channel: "telegram",
        to: "123456",
        cooldownMs: 60_000,
        accountId: "bot-a",
        mode: "webhook",
        includeSkipped: true,
      },
    });
    const { state, submit } = createCronEditHarness(job);

    const blankAlerts = Object.fromEntries(
      Object.entries(DEFAULT_CRON_FORM).filter(([field]) => field.startsWith("failureAlert")),
    );
    Object.assign(state.cronForm, blankAlerts, { failureAlertMode: mode });
    const call = await submit();

    // oxlint-disable-next-line unicorn/prefer-structured-clone -- verify explicit clears on the wire
    expect(JSON.parse(JSON.stringify(requestPatch(call).failureAlert))).toEqual(expected);
  });

  it.each<[Partial<CronState["cronForm"]>, string, string]>([
    [
      { scheduleKind: "cron", staggerAmount: "8640000000000.001", staggerUnit: "seconds" },
      "staggerAmount",
      "cron.errors.staggerAmountInvalid",
    ],
    [
      { scheduleKind: "cron", staggerAmount: "0.0001" },
      "staggerAmount",
      "cron.errors.staggerAmountInvalid",
    ],
    [{ timeoutSeconds: "Infinity" }, "timeoutSeconds", "cron.errors.timeoutInvalid"],
    [{ everyAmount: "0x10" }, "everyAmount", "cron.errors.everyAmountInvalid"],
    [
      {
        everyAmount: "29.999",
        everyUnit: "seconds",
        triggerEnabled: true,
        triggerScript: "json({ fire: true })",
      },
      "everyAmount",
      "cron.errors.triggerIntervalTooShort",
    ],
    [
      { failureAlertMode: "custom", failureAlertAfter: ".5" },
      "failureAlertAfter",
      "Failure alert threshold must be at least 1.",
    ],
    [
      { failureAlertMode: "custom", failureAlertCooldownSeconds: "1e308" },
      "failureAlertCooldownSeconds",
      "Cooldown must be finite and 0 or greater.",
    ],
  ])("rejects invalid numeric input %j before RPC", async (form, field, error) => {
    const { state, request } = createCronSubmitHarness("invalid", form);
    expect(await addCronJob(state)).toEqual({ saved: false });
    expect(state.cronFieldErrors).toHaveProperty(field, error);
    expect(request).not.toHaveBeenCalled();
  });

  it("clones deny-all payload policy without its capture marker", async () => {
    const policy = {
      ...hiddenPolicy,
      toolsAllow: [],
      allowUnsafeExternalContent: false,
      toolsAllowIsDefault: true,
    };
    const source = createCronJob("source", "Policy source", {
      agentId: "writer",
      payload: { kind: "agentTurn", message: "Synthetic task", ...policy },
    });
    const original = structuredClone(source);
    const { request, state, submit } = cloneHarness(source, { cronAgentId: "main" });
    startCronEdit(state, source);
    startCronClone(state, source);
    const submitted = await submit();
    expect(submitted.name).toBe("Policy source copy");
    expect(submitted.agentId).toBe("writer");
    expect(request.mock.calls.some(([method]) => method === "cron.update")).toBe(false);
    const expected: Extract<CronJob["payload"], { kind: "agentTurn" }> = {
      kind: "agentTurn",
      message: "Synthetic task",
      ...policy,
    };
    delete expected.toolsAllowIsDefault;
    expect(submitted.payload).toEqual(expected);
    expect(source).toEqual(original);
  });

  it.each([
    [
      "agent task to system event",
      { kind: "agentTurn", message: "Original task", ...hiddenPolicy },
      undefined,
      "systemEvent",
    ],
    [
      "command to new agent task",
      { kind: "command", argv: ["node", "synthetic.mjs"], toolsAllow: [] },
      { script: "return { fire: true }", once: false },
      "agentTurn",
    ],
  ] satisfies Array<[string, CronJob["payload"], CronJob["trigger"], "agentTurn" | "systemEvent"]>)(
    "clone payload policy: retains common restrictions for %s",
    async (_name, payload, trigger, target) => {
      const source = createCronJob("kind-source", "Kind transition source", {
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        payload,
        trigger,
      });
      const original = structuredClone(source);
      const { request, state, submit } = cloneHarness(source);
      if (payload.kind === "command") {
        expect(state.cronForm.payloadText).toBe("");
        expect(await addCronJob(state)).toEqual({ saved: false });
        expect(state.cronFieldErrors.payloadText).toBe("cron.errors.agentMessageRequired");
        expect(request).not.toHaveBeenCalled();
      }
      Object.assign(state.cronForm, {
        payloadKind: target,
        sessionTarget: target === "systemEvent" ? "main" : "isolated",
        payloadText: "New operator-authored task",
      });

      const submitted = await submit();
      expect(source).toEqual(original);
      expect(submitted.trigger).toEqual(trigger);
      expect(submitted.payload).toEqual({
        kind: target,
        ...(target === "systemEvent"
          ? { text: "New operator-authored task" }
          : { message: "New operator-authored task" }),
        toolsAllow: payload.toolsAllow,
      });
    },
  );

  it.each([
    { schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC", staggerMs: 60_000 } },
    { schedule: { kind: "on-exit", command: "make build", cwd: "/repo" } },
    {
      failureAlert: {
        after: 4,
        cooldownMs: 1_001,
        mode: "webhook",
        to: "https://alerts.example.test/cron",
        accountId: "bot-a",
        includeSkipped: true,
      },
    },
    { failureAlert: { channel: "last", includeSkipped: false } },
    { failureAlert: false },
  ] as const)("clones exact persisted fields: %j", async (fields) => {
    const sourceJob = createCronJob("source", "Source", fields);
    const { submit } = cloneHarness(sourceJob, {
      cronJobs: "schedule" in fields ? [sourceJob] : [],
    });
    const payload = await submit();
    for (const [field, expected] of Object.entries(fields)) {
      // oxlint-disable-next-line unicorn/prefer-structured-clone -- verify omitted fields on the wire
      expect(JSON.parse(JSON.stringify(payload[field]))).toEqual(expected);
    }
  });

  it("round-trips hidden delivery destinations through clone and edit", async () => {
    const sourceJob = createCronJob("job-routing", "Routed job", {
      sessionKey: "agent:ops:main",
      delivery: {
        mode: "announce",
        accountId: "ops-bot",
        threadId: 42,
        bestEffort: true,
        completionDestination: { mode: "webhook", to: "https://example.test/complete" },
        failureDestination: {
          mode: "announce",
          channel: "telegram",
          to: "ops",
          accountId: "alerts",
        },
      },
    });

    const addPayload = await cloneHarness(sourceJob).submit();
    expect(addPayload.delivery).toEqual(sourceJob.delivery);
    expect(addPayload.sessionKey).toBe("agent:ops:main");

    const { request: updateRequest, state: editState } = createCronEditHarness(sourceJob);
    editState.cronForm.deliveryThreadId = "thread-42";
    await addCronJob(editState);
    const updatePayload = sent(updateRequest, "cron.update");
    expect(requireRecord(updatePayload.patch, "cron.update patch").delivery).toEqual({
      ...sourceJob.delivery,
      threadId: "thread-42",
    });
    expect(validateCronUpdateParams(updatePayload)).toBe(true);
  });
});

it("reads intervals into the largest exact unit without rounding", () => {
  for (const [everyMs, amount, unit] of [
    [1, "0.001", "seconds"],
    [60_000, "1", "minutes"],
    [7_200_000, "2", "hours"],
    [86_400_000, "1", "days"],
    [8_639_999_999_999_999, "8639999999999.999", "seconds"],
  ] as const) {
    const state = createInitialCronState({ connected: true });
    startCronEdit(
      state,
      createCronJob("interval", "Interval", { schedule: { kind: "every", everyMs } }),
    );
    expect(state.cronForm.everyUnit).toBe(unit);
    expect(state.cronForm.everyAmount).toBe(amount);
    expect(parseCronDurationMs(state.cronForm.everyAmount, state.cronForm.everyUnit)).toBe(everyMs);
  }
});

it("omits an unchanged minute but sends a genuinely changed minute", async () => {
  const originalAt = "2030-01-02T03:04:56.789Z";
  const original = createCronJob("job-at-precision", "Precise one-shot", {
    schedule: { kind: "at", at: originalAt },
    deleteAfterRun: true,
  });

  const unchanged = createCronEditHarness(original);
  unchanged.state.cronForm.description = "metadata only";
  const unchangedPatch = requestPatch(await unchanged.submit());
  expect(unchangedPatch).not.toHaveProperty("schedule");

  const changed = createCronEditHarness(original);
  const originalMinute = new Date(originalAt);
  originalMinute.setMinutes(originalMinute.getMinutes() + 1);
  originalMinute.setSeconds(0, 0);
  const localMinute = new Date(
    originalMinute.getTime() - originalMinute.getTimezoneOffset() * 60_000,
  );
  changed.state.cronForm.scheduleAt = localMinute.toISOString().slice(0, 16);
  const changedPatch = requestPatch(await changed.submit());
  expect(changedPatch.schedule).toEqual({
    kind: "at",
    at: originalMinute.toISOString(),
  });
});

it("loads independent totals and next wake time for the selected agent", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ jobs: [], total: 7 })
    .mockResolvedValueOnce({ jobs: [{ state: { nextRunAtMs: 1234 } }], total: 1 });
  const state = createStateWithRequest(request, { cronAgentId: "writer" });
  await loadCronScopeStats(state);
  expect(state).toMatchObject({ cronScopedTotal: 7, cronScopedNextWakeAtMs: 1234 });
  expect(request).toHaveBeenNthCalledWith(
    1,
    "cron.list",
    expect.objectContaining({ agentId: "writer", includeDisabled: true }),
  );
});

describe("failure alert form round trips", () => {
  it("serializes cooldown seconds in exponent notation", async () => {
    const { call } = await createCronSubmitHarness("cooldown", {
      failureAlertMode: "custom",
      failureAlertCooldownSeconds: "1e-3",
    }).submit();
    expect(validateCronAddParams(call)).toBe(true);
    expect(call.failureAlert).toMatchObject({ cooldownMs: 1 });
  });

  it("preserves inherited alert fields while editing a command with hidden alert controls", async () => {
    const job = createCronJob("command-inherited-policy", "Command alert policy", {
      payload: { kind: "command", argv: ["node", "report.mjs"] },
      failureAlert: {},
    });
    const { state, submit } = createCronEditHarness(job);
    state.cronForm.description = "Only metadata changed";

    const call = await submit();

    expect(requestPatch(call)).not.toHaveProperty("payload");
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- hidden controls must not materialize defaults on the wire
    expect(JSON.parse(JSON.stringify(requestPatch(call).failureAlert))).toEqual({});
  });
});
