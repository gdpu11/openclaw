/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MigrationsMemoryApplyResult } from "../../../../packages/gateway-protocol/src/schema/migrations.js";
import { createDeferredCore } from "../../../../src/shared/deferred.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { createApplicationGatewaySnapshot } from "../../test-helpers/application-context-fixtures.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { MemoryImportPage } from "./memory-import-page.tsx";
import type { SessionBackfillGatewayResult } from "./view-types.ts";

type TestContext = ApplicationContext & { notify(): void };
type Handlers = Record<string, (params: { agentId?: string }) => unknown>;
let handlers: Handlers;
let request: ReturnType<typeof createRequest>;
let context: TestContext;
let page: HTMLElement;
let disposals: Array<() => void>;

const settle = waitForSolid;
const calls = (count: number) => settle(() => expect(request).toHaveBeenCalledTimes(count));
const textAppears = (text: string) => settle(() => expect(page.textContent).toContain(text));
const date = (index = 0) => page.querySelectorAll<HTMLInputElement>("input[type='date']")[index];
const collections = () =>
  page.querySelectorAll<HTMLInputElement>(".memory-import__collection input[type='checkbox']");
const applyParams = (index: number) =>
  request.mock.calls[index]?.[1] as { idempotencyKey?: string } | undefined;
function expectOnlyPlans() {
  expect(request.mock.calls.every(([method]) => method === "migrations.memory.plan")).toBe(true);
}
function connection(
  phase: ApplicationGatewaySnapshot["phase"],
  patch: Partial<ApplicationGatewaySnapshot> = {},
) {
  Object.assign(context.gateway.snapshot, { phase }, patch);
  context.notify();
}
function refresh() {
  const control = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === "Refresh",
  );
  expect(control).toBeDefined();
  control!.click();
}

function createRequest(methods: Handlers) {
  return vi.fn(async (method: string, params: { agentId?: string }) => {
    const handler = Object.hasOwn(methods, method) ? methods[method] : undefined;
    if (!handler) {
      throw new Error(`unexpected method: ${method}`);
    }
    return handler(params);
  });
}

function agentRoster(
  ...ids: string[]
): NonNullable<ApplicationContext["agents"]["state"]["agentsList"]> {
  return {
    defaultId: ids[0]!,
    mainKey: "main",
    scope: "per-sender",
    agents: ids.map((id) => ({ id, name: id === "research" ? "Research" : "Writer" })),
  };
}

function setDate(input: HTMLInputElement, value = "2026-07-01") {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function button(id: string) {
  return page.querySelector<HTMLButtonElement>(`[data-test-id='memory-${id}']`);
}

async function ready(id: string, disabled?: boolean) {
  await settle(() => {
    expect(button(id)).not.toBeNull();
    if (disabled !== undefined) {
      expect(button(id)?.disabled).toBe(disabled);
    }
  });
}

async function openImport() {
  await ready("import-provider-button");
  button("import-provider-button")?.click();
  await ready("import-confirm");
}

const emptySummary = {
  total: 1,
  planned: 0,
  migrated: 0,
  skipped: 0,
  conflicts: 0,
  errors: 0,
  sensitive: 0,
};

function createPlan(agentId = "research") {
  const workspace = `/tmp/openclaw-${agentId}`;
  const provider = {
    providerId: "codex",
    label: "Codex",
    planFingerprint: "a".repeat(64),
    found: true,
    source: "/tmp/codex",
    target: workspace,
    summary: { ...emptySummary, planned: 1 },
    items: [
      {
        id: "memory:codex:MEMORY.md",
        status: "planned",
        details: { collectionId: "codex", collectionLabel: "Codex" },
      },
    ],
  };
  return { agentId, workspace, providers: [provider] };
}

function createApplyResult(): MigrationsMemoryApplyResult {
  return {
    providerId: "codex",
    source: "/tmp/codex",
    summary: { ...emptySummary, migrated: 1 },
    items: [{ id: "memory:codex:MEMORY.md", status: "migrated" }],
  };
}

function backfillChunk(
  days = 0,
  candidates = 0,
  staged = 0,
  hasMore = false,
): SessionBackfillGatewayResult {
  return {
    days,
    candidates,
    staged,
    perDay: candidates ? [{ day: "2026-07-01", candidateCount: candidates, sample: [] }] : [],
    cursor: { advanced: candidates > 0, exhausted: candidates === 0, hasMore },
  };
}

function createContext(): TestContext {
  const client = { request } as unknown as GatewayBrowserClient;
  const snapshot: ApplicationGatewaySnapshot = createApplicationGatewaySnapshot({
    client,
    phase: "connected",
    assistantAgentId: "research",
    sessionKey: "agent:research:main",
  });
  const gatewayFixture = createApplicationGateway(snapshot);
  const subscribe = gatewayFixture.gateway.subscribe;
  return {
    notify: () => gatewayFixture.publish(snapshot),
    gateway: gatewayFixture.gateway,
    router: { subscribe: () => () => {} },
    agents: {
      state: {
        client,
        connected: true,
        agentsLoading: false,
        agentsError: null,
        agentsList: {
          defaultId: "research",
          agents: [{ id: "research", name: "Research" }],
        },
      },
      ensureList: vi.fn(),
      subscribe,
    },
    agentSelection: {
      state: { selectedId: "research" },
      set: vi.fn(),
      subscribe,
    },
  } as unknown as TestContext;
}

async function mountPage(target: ApplicationContext = context) {
  const { wrapper } = createSolidApplicationContextProvider(target);
  const view = mountSolid(() => <MemoryImportPage />, { wrapper });
  flush();
  const element = view.container.querySelector<HTMLElement>("openclaw-memory-import-page");
  expect(element).not.toBeNull();
  page = element!;
}

beforeEach(() => {
  disposals = [];
  handlers = { "migrations.memory.plan": () => createPlan() };
  request = createRequest(handlers);
  context = createContext();
});

afterEach(() => {
  cleanupSolid();
  for (const dispose of disposals) {
    dispose();
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("MemoryImportPage", () => {
  it("shows the disconnected explanation on a cold offline load and opens the workspace on reconnect", async () => {
    context.gateway.snapshot.phase = "stopped";
    await mountPage();

    expect(page.textContent).toContain("Connect to the gateway to import memory.");
    expect(page.querySelector(".memory-import")).toBeNull();
    expect(page.textContent).not.toContain("Memory import requires operator.admin access.");
    expect(request).not.toHaveBeenCalled();

    connection("connected");
    await ready("import-provider-button");
    expect(page.textContent).not.toContain("Connect to the gateway to import memory.");
    expect(page.textContent).toContain("/tmp/openclaw-research");
  });

  it("replans per target or overwrite, coalesces receipts, and stops on disposal", async () => {
    handlers["migrations.memory.plan"] = (params) => createPlan(params.agentId);
    await mountPage();
    expect(request).toHaveBeenCalledTimes(1);

    context.agents.state.agentsList = agentRoster("writer");
    context.agentSelection.state.selectedId = "writer";
    context.notify();
    context.notify();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).toEqual({ agentId: "writer", overwrite: false });
    await textAppears("/tmp/openclaw-writer");

    expect(page.textContent).not.toContain("/tmp/openclaw-research");

    page.querySelector<HTMLInputElement>('input[role="switch"]')!.click();
    context.notify();
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2]?.[1]).toEqual({ agentId: "writer", overwrite: true });
    await ready("import-provider-button", false);

    cleanupSolid();
    context.agentSelection.state.selectedId = "research";
    context.agents.state.agentsList = agentRoster("research");
    context.notify();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("retains a loaded plan after roster refresh failure and retries the roster on Refresh", async () => {
    const roster = createDeferredCore<unknown>();
    let rosterReply: Promise<unknown> = roster.promise;
    let plan = createPlan();
    handlers["agents.list"] = () => rosterReply;
    handlers["migrations.memory.plan"] = () => plan;
    const agents = createAgentCapability(context.gateway);
    disposals.push(() => agents.dispose());
    // The application shell owns the initial shared roster request.
    const initial = agents.ensureList();
    await mountPage({ ...context, agents });
    roster.reject(new Error("Agent roster unavailable"));
    rosterReply = createDeferredCore().promise;
    await initial;
    flush();
    flush();
    expect(page.textContent).toContain("Agent roster unavailable");

    rosterReply = Promise.resolve(agentRoster("research"));
    refresh();
    await ready("import-provider-button");
    expect(page.textContent).not.toContain("Agent roster unavailable");
    rosterReply = Promise.reject(new Error("Agent roster unavailable"));
    await agents.refreshList();
    flush();
    expect(button("import-provider-button")).not.toBeNull();
    expect(page.textContent).toContain("/tmp/openclaw-research");
    expect(
      request.mock.calls.filter(([method]) => method === "migrations.memory.plan"),
    ).toHaveLength(1);

    rosterReply = Promise.resolve(agentRoster("writer"));
    plan = createPlan("writer");
    refresh();
    await textAppears("/tmp/openclaw-writer");
    expect(page.textContent).not.toContain("Agent roster unavailable");
    expect(page.textContent).toContain("/tmp/openclaw-writer");
    expect(page.textContent).not.toContain("/tmp/openclaw-research");
  });

  it.each([false, true])(
    "keeps planning errors stable and redacted (after apply=%s)",
    async (afterApply) => {
      const failure = "planning unavailable: OPENAI_API_KEY=sk-1234567890abcdef";
      const plan = vi.fn(() => {
        throw new Error(failure);
      });
      handlers["migrations.memory.plan"] = afterApply
        ? vi.fn().mockReturnValueOnce(createPlan()).mockImplementation(plan)
        : plan;
      if (afterApply) {
        handlers["migrations.memory.apply"] = () => ({
          ...createApplyResult(),
          summary: { ...emptySummary, errors: 1 },
          items: [],
          reportDir: "/tmp/migration-report",
        });
      }
      await mountPage();
      if (afterApply) {
        await openImport();
        button("import-confirm")!.click();
      }
      await textAppears("planning unavailable: OPENAI_API_KEY=sk-123...cdef");
      expect(page.textContent).not.toContain("sk-1234567890abcdef");
      const before = request.mock.calls.length;
      context.notify();
      flush();
      expect(request).toHaveBeenCalledTimes(before);
      if (afterApply) {
        expect(page.textContent).toContain("/tmp/migration-report");
        expect(button("import-provider-button")?.disabled).toBe(true);
      }
      refresh();
      await calls(before + 1);
    },
  );

  it("admits one same-turn import, retries its frozen key, and unlocks after refresh", async () => {
    handlers["migrations.memory.apply"] = vi
      .fn()
      .mockReturnValue(createApplyResult())
      .mockImplementationOnce(() => {
        throw new Error("response lost");
      });
    await mountPage();
    await openImport();
    const confirm = button("import-confirm")!;
    confirm.click();
    confirm.click();
    expect(request).toHaveBeenCalledTimes(2);
    await settle(() =>
      expect(page.querySelector(".memory-import__confirm [role='alert']")?.textContent).toBe(
        "response lost",
      ),
    );
    button("import-confirm")!.click();
    await ready("import-provider-button", false);
    const first = applyParams(1);
    expect(first?.idempotencyKey).toMatch(/\S/u);
    expect(applyParams(2)).toEqual(first);
  });

  it("retains selections, dates, previews and confirmation across a same-client reconnect", async () => {
    const plan = createPlan();
    plan.providers[0]!.items.push({
      ...plan.providers[0]!.items[0]!,
      id: "memory:codex:other.md",
      details: { collectionId: "other", collectionLabel: "Other" },
    });
    Object.assign(handlers, {
      "migrations.memory.plan": (params: { agentId?: string }) => ({
        ...plan,
        agentId: params.agentId ?? "research",
      }),
      "memory.sessionBackfill.preview": () => ({
        days: 1,
        candidates: 1,
        staged: 0,
        perDay: [{ day: "2026-07-01", candidateCount: 1, sample: ["Retained preview"] }],
      }),
    });
    await mountPage();
    await settle(() => expect(collections()).toHaveLength(2));
    collections()[1]!.click();
    setDate(date()!);
    setDate(date(1)!, "2026-07-31");
    button("backfill-preview")!.click();
    await textAppears("Retained preview");
    expect(request.mock.calls.at(-1)).toEqual([
      "memory.sessionBackfill.preview",
      { agentId: "research", from: "2026-07-01", to: "2026-07-31", limitDays: 14 },
    ]);
    await openImport();

    connection("stopped", { hello: null });
    flush();
    flush();
    expect(button("import-confirm")?.disabled).toBe(true);
    expect(date()?.value).toBe("2026-07-01");
    expect(page.textContent).toContain("Retained preview");

    connection("connected");
    await ready("import-confirm", false);
    expect([...collections()].map((input) => input.checked)).toEqual([true, false]);
    expect(date()?.value).toBe("2026-07-01");
    expect(page.textContent).toContain("Retained preview");

    page
      .querySelector<HTMLButtonElement>(".memory-import__confirm button:not([data-test-id])")!
      .click();
    button("backfill-rollback")!.click();
    flush();
    connection("reconnecting");
    flush();
    expect(button("backfill-rollback-confirm")?.disabled).toBe(true);
    connection("connected");
    await calls(4);
    expect(button("backfill-rollback-confirm")).not.toBeNull();

    connection("connected", { client: { request } as unknown as GatewayBrowserClient });
    await calls(5);
    expect(button("import-confirm")).toBeNull();
    expect(button("backfill-rollback-confirm")).toBeNull();
    expect(date()?.value).toBe("");
    expect(page.textContent).not.toContain("Retained preview");

    const beforeAccessLoss = request.mock.calls.length;
    context.gateway.snapshot.hello = gatewayHelloForMethods([], ["operator.read"]);
    context.notify();
    await settle(() => expect(page.querySelector(".memory-import")).toBeNull());
    expect(request).toHaveBeenCalledTimes(beforeAccessLoss);
    expect(page.textContent).toContain("Memory import requires operator.admin access.");
    expect(page.textContent).not.toContain("/tmp/openclaw-research");
  });

  it.each(["disconnect", "roster loss"] as const)(
    "preserves an attempted import key across %s",
    async (interruption) => {
      const result = createApplyResult();
      const firstApplyResult = createDeferredCore<typeof result>();
      let applyRequests = 0;
      Object.assign(handlers, {
        "migrations.memory.apply": async () => {
          applyRequests += 1;
          if (applyRequests === 1) {
            return await firstApplyResult.promise;
          }
          return result;
        },
      });
      const roster = context.agents.state.agentsList;
      await mountPage();

      await openImport();
      button("import-confirm")?.click();
      await calls(2);
      const firstApply = applyParams(1);

      if (interruption === "disconnect") {
        context.gateway.snapshot.phase = "stopped";
      } else {
        context.agents.state.agentsList = null;
        context.agents.state.agentsError = "Agent roster unavailable";
      }
      context.notify();
      flush();
      expect(button("import-confirm")?.disabled ?? true).toBe(true);
      firstApplyResult.resolve(result);
      await Promise.resolve();

      if (interruption === "disconnect") {
        context.gateway.snapshot.phase = "connected";
      } else {
        context.agents.state.agentsList = roster;
        context.agents.state.agentsError = null;
      }
      context.notify();
      await calls(3);
      await ready("import-confirm");
      button("import-confirm")?.click();
      await calls(4);

      const retryApply = applyParams(3);
      expect(firstApply?.idempotencyKey).toMatch(/\S/u);
      expect(retryApply).toEqual(firstApply);
    },
  );

  it.each(["account", "recovery", "agent import", "agent rollback"] as const)(
    "retires protected drafts on %s changes before accepting more writes",
    async (target) => {
      const nextPlan = createDeferredCore<ReturnType<typeof createPlan>>();
      handlers["migrations.memory.plan"] = vi
        .fn()
        .mockReturnValue(nextPlan.promise)
        .mockReturnValueOnce(createPlan());
      const agentChange = target.startsWith("agent");
      context.agents.state.agentsList = agentRoster("research", "writer");
      const selection = agentChange
        ? createAgentSelectionCapability(context.gateway, context.agents)
        : undefined;
      if (selection) {
        disposals.push(() => selection.dispose());
      }
      context.gateway.snapshot.selfUser = { id: "first", name: "First" };
      const hello = gatewayHelloForMethods(["memory.sessionBackfill.preview"]);
      context.gateway.snapshot.hello = {
        ...hello,
        auth: { ...hello.auth, recoveryScope: "first" },
      };
      await mountPage(selection ? { ...context, agentSelection: selection } : context);
      const id = target === "agent rollback" ? "backfill-rollback-confirm" : "import-confirm";
      if (target === "agent rollback") {
        await ready("backfill-rollback");
        button("backfill-rollback")!.click();
      } else {
        await openImport();
      }
      setDate(date()!);
      await ready(id);
      const confirm = button(id)!;
      if (target === "account") {
        context.gateway.snapshot.selfUser = { id: "second", name: "Second" };
      } else if (target === "recovery") {
        context.gateway.snapshot.hello = {
          ...hello,
          auth: { ...hello.auth, recoveryScope: "second" },
        };
      } else {
        selection!.set("writer");
      }
      context.notify();
      // Click the retained DOM node before Solid has rendered the new authority scope.
      confirm.click();
      expectOnlyPlans();
      await calls(2);
      expect(button(id)).toBeNull();
      expect(date()?.value).toBe("");
      expect(page.textContent).not.toContain("/tmp/openclaw-research");
      if (agentChange) {
        expect(request.mock.calls[1]?.[1]).toMatchObject({ agentId: "writer" });
        nextPlan.reject(new Error("Writer plan unavailable"));
        await textAppears("Writer plan unavailable");
        expect(button(id)).toBeNull();
        expectOnlyPlans();
      } else {
        nextPlan.resolve(createPlan());
        await ready("import-provider-button");
      }
    },
  );

  it.each(["import", "backfill"] as const)(
    "shows the next agent while the retired %s request is still pending",
    async (operation) => {
      const pending = createDeferredCore<unknown>();
      Object.assign(handlers, {
        "migrations.memory.plan": (params: { agentId?: string }) => createPlan(params.agentId),
        "migrations.memory.apply": () => pending.promise,
        "memory.sessionBackfill.apply": () => pending.promise,
      });
      context.agents.state.agentsList = agentRoster("research", "writer");
      await mountPage();
      if (operation === "import") {
        await openImport();
        button("import-confirm")!.click();
        await ready("import-confirm", true);
      } else {
        await ready("backfill-apply", false);
        button("backfill-apply")!.click();
        await ready("backfill-apply", true);
      }

      context.agentSelection.state.selectedId = "writer";
      context.notify();
      await settle(() => {
        expect(page.textContent).toContain("/tmp/openclaw-writer");
        expect(page.textContent).not.toContain("/tmp/openclaw-research");
        expect(button("import-confirm")).toBeNull();
      });
      await ready("import-provider-button", false);
      pending.resolve(operation === "import" ? createApplyResult() : backfillChunk());
      await pending.promise;
      flush();
      expect(page.textContent).toContain("/tmp/openclaw-writer");
    },
  );

  it("applies backfill chunks until a call returns zero new candidates", async () => {
    const apply = vi
      .fn()
      .mockReturnValue(backfillChunk())
      .mockReturnValueOnce(backfillChunk(2, 3, 2, true))
      .mockReturnValueOnce(backfillChunk(1, 1, 1));
    handlers["memory.sessionBackfill.apply"] = apply;
    await mountPage();
    await ready("backfill-apply");
    button("backfill-apply")?.click();

    await settle(() =>
      expect(page.textContent).toContain("3 staged; promotion happens via dreaming"),
    );
    expect(apply).toHaveBeenCalledTimes(3);
    expect(page.textContent).toContain("4 session candidates processed");
    expect(page.textContent).toContain("1 day processed");

    setDate(date()!);
    flush();
    expect(page.textContent).not.toContain("3 staged; promotion happens via dreaming");
  });

  it("confirms rollback and surfaces gateway errors", async () => {
    handlers["memory.sessionBackfill.rollback"] = () => {
      throw new Error("rollback unavailable");
    };
    await mountPage();
    await ready("backfill-rollback");
    button("backfill-rollback")?.click();
    await ready("backfill-rollback-confirm");
    button("backfill-rollback-confirm")?.click();

    await textAppears("rollback unavailable");
    expect(request.mock.calls.at(-1)).toEqual([
      "memory.sessionBackfill.rollback",
      { agentId: "research" },
    ]);
  });
});
