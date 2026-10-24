/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
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

const settle = waitForSolid;
const calls = (request: ReturnType<typeof vi.fn>, count: number) =>
  settle(() => expect(request).toHaveBeenCalledTimes(count));
const textAppears = (page: HTMLElement, text: string) =>
  settle(() => expect(page.textContent).toContain(text));
const date = (page: HTMLElement, index = 0) =>
  page.querySelectorAll<HTMLInputElement>("input[type='date']")[index];
const collections = (page: HTMLElement) =>
  page.querySelectorAll<HTMLInputElement>(".memory-import__collection input[type='checkbox']");
const applyParams = (request: ReturnType<typeof vi.fn>, index: number) =>
  request.mock.calls[index]?.[1] as { idempotencyKey?: string } | undefined;
function expectOnlyPlans(request: ReturnType<typeof vi.fn>) {
  expect(request.mock.calls.every(([method]) => method === "migrations.memory.plan")).toBe(true);
}
function refresh(page: HTMLElement) {
  const control = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === "Refresh",
  );
  expect(control).toBeDefined();
  control!.click();
}

function createRequest(handlers: Record<string, (params: { agentId?: string }) => unknown>) {
  return vi.fn(async (method: string, params: { agentId?: string }) => {
    const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined;
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

function button(page: HTMLElement, id: string) {
  return page.querySelector<HTMLButtonElement>(`[data-test-id='memory-${id}']`);
}

async function ready(page: HTMLElement, id: string, disabled?: boolean) {
  await settle(() => {
    expect(button(page, id)).not.toBeNull();
    if (disabled !== undefined) {
      expect(button(page, id)?.disabled).toBe(disabled);
    }
  });
}

async function openImport(page: HTMLElement) {
  await ready(page, "import-provider-button");
  button(page, "import-provider-button")?.click();
  await ready(page, "import-confirm");
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
  return {
    agentId,
    workspace,
    providers: [
      {
        providerId: "codex",
        label: "Codex",
        description: "Import Codex memory.",
        planFingerprint: "a".repeat(64),
        found: true,
        source: "/tmp/codex",
        target: workspace,
        summary: { ...emptySummary, planned: 1 },
        items: [
          {
            id: "memory:codex:MEMORY.md",
            status: "planned",
            source: "/tmp/codex/MEMORY.md",
            target: `${workspace}/memory/imports/codex/MEMORY.md`,
            details: {
              collectionId: "codex",
              collectionLabel: "Codex",
              relativePath: "MEMORY.md",
            },
          },
        ],
      },
    ],
  };
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

function createContext(request: ReturnType<typeof vi.fn>): TestContext {
  const client = { request } as unknown as GatewayBrowserClient;
  const snapshot: ApplicationGatewaySnapshot = createApplicationGatewaySnapshot({
    client,
    phase: "connected",
    assistantAgentId: "research",
    sessionKey: "agent:research:main",
  });
  const gatewayFixture = createApplicationGateway(snapshot);
  const listeners = new Set<() => void>();
  const subscribe = (notify: () => void) => {
    listeners.add(notify);
    return () => listeners.delete(notify);
  };
  return {
    notify() {
      gatewayFixture.publish(snapshot);
      for (const listener of listeners) {
        listener();
      }
    },
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

async function mountPage(context: ApplicationContext): Promise<HTMLElement> {
  const { wrapper } = createSolidApplicationContextProvider(context);
  const view = mountSolid(() => <MemoryImportPage />, { wrapper });
  flush();
  const page = view.container.querySelector<HTMLElement>("openclaw-memory-import-page");
  expect(page).not.toBeNull();
  return page!;
}

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("MemoryImportPage", () => {
  it("shows the disconnected explanation on a cold offline load and opens the workspace on reconnect", async () => {
    const request = vi.fn(async () => createPlan());
    const context = createContext(request);
    context.gateway.snapshot.phase = "stopped";
    const page = await mountPage(context);

    expect(page.textContent).toContain("Connect to the gateway to import memory.");
    expect(page.querySelector(".memory-import")).toBeNull();
    expect(page.textContent).not.toContain("Memory import requires operator.admin access.");
    expect(request).not.toHaveBeenCalled();

    context.gateway.snapshot.phase = "connected";
    context.notify();
    await ready(page, "import-provider-button");
    expect(page.textContent).not.toContain("Connect to the gateway to import memory.");
    expect(page.textContent).toContain("/tmp/openclaw-research");
  });

  it("replans once per owner target and ignores late replies and repeated receipts", async () => {
    const firstPlan = createDeferredCore<ReturnType<typeof createPlan>>();
    const request = vi.fn((_method: string, params: { agentId: string; overwrite: boolean }) =>
      params.agentId === "research" ? firstPlan.promise : Promise.resolve(createPlan("writer")),
    );
    const context = createContext(request);
    const page = await mountPage(context);
    expect(request).toHaveBeenCalledTimes(1);

    context.agents.state.agentsList = agentRoster("writer");
    context.agentSelection.state.selectedId = "writer";
    context.notify();
    context.notify();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).toEqual({ agentId: "writer", overwrite: false });
    await textAppears(page, "/tmp/openclaw-writer");

    firstPlan.resolve(createPlan());
    await firstPlan.promise;
    await Promise.resolve();
    flush();
    expect(page.textContent).toContain("/tmp/openclaw-writer");
    expect(page.textContent).not.toContain("/tmp/openclaw-research");

    page.querySelector<HTMLInputElement>('input[role="switch"]')!.click();
    context.notify();
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2]?.[1]).toEqual({ agentId: "writer", overwrite: true });
    await ready(page, "import-provider-button", false);

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
    const request = vi.fn((method: string) =>
      method === "agents.list" ? rosterReply : Promise.resolve(plan),
    );
    const context = createContext(request);
    const agents = createAgentCapability(context.gateway);
    // The application shell owns the initial shared roster request.
    const initial = agents.ensureList();
    const page = await mountPage({ ...context, agents });
    try {
      roster.reject(new Error("Agent roster unavailable"));
      rosterReply = createDeferredCore().promise;
      await initial;
      flush();
      flush();
      expect(request).toHaveBeenCalledTimes(1);
      expect(page.textContent).toContain("Agent roster unavailable");

      rosterReply = Promise.resolve(agentRoster("research"));
      refresh(page);
      await ready(page, "import-provider-button");
      expect(request.mock.calls.filter(([method]) => method === "agents.list")).toHaveLength(2);
      expect(page.textContent).not.toContain("Agent roster unavailable");
      rosterReply = Promise.reject(new Error("Agent roster unavailable"));
      await agents.refreshList();
      flush();
      expect(button(page, "import-provider-button")).not.toBeNull();
      expect(page.textContent).toContain("/tmp/openclaw-research");
      expect(
        request.mock.calls.filter(([method]) => method === "migrations.memory.plan"),
      ).toHaveLength(1);

      rosterReply = Promise.resolve(agentRoster("writer"));
      plan = createPlan("writer");
      refresh(page);
      await textAppears(page, "/tmp/openclaw-writer");
      expect(request.mock.calls.filter(([method]) => method === "agents.list")).toHaveLength(4);
      expect(request).toHaveBeenLastCalledWith(
        "migrations.memory.plan",
        { agentId: "writer", overwrite: false },
        expect.anything(),
      );
      expect(page.textContent).not.toContain("Agent roster unavailable");
      expect(page.textContent).toContain("/tmp/openclaw-writer");
      expect(page.textContent).not.toContain("/tmp/openclaw-research");
    } finally {
      page.parentElement?.remove();
      agents.dispose();
    }
  });

  it("does not plan memory import without admin access", async () => {
    const request = vi.fn();
    const context = createContext(request);
    context.gateway.snapshot.hello = {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
      features: { methods: ["migrations.memory.plan"] },
    } as ApplicationGatewaySnapshot["hello"];
    const page = await mountPage(context);

    flush();
    expect(request).not.toHaveBeenCalled();
    expect(page.textContent).toContain("Memory import requires operator.admin access.");
  });

  it("keeps a failed plan stable until the operator explicitly refreshes", async () => {
    const request = vi.fn(async () => {
      throw new Error("planning unavailable: OPENAI_API_KEY=sk-1234567890abcdef");
    });
    const context = createContext(request);
    const page = await mountPage(context);

    await calls(request, 1);
    flush();
    await Promise.resolve();
    context.notify();
    flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(page.textContent).toContain("planning unavailable: OPENAI_API_KEY=sk-123...cdef");
    expect(page.textContent).not.toContain("sk-1234567890abcdef");

    refresh(page);
    await calls(request, 2);
  });

  it("keeps apply recovery results visible when the follow-up plan fails", async () => {
    let planRequests = 0;
    const request = createRequest({
      "migrations.memory.plan": () => {
        planRequests += 1;
        if (planRequests > 1) {
          throw new Error("post-apply planning unavailable");
        }
        return createPlan();
      },
      "migrations.memory.apply": () => {
        return {
          providerId: "codex",
          source: "/tmp/codex",
          summary: { ...emptySummary, errors: 1 },
          items: [
            {
              id: "memory:codex:MEMORY.md",
              status: "error",
              reason: "replacement interrupted",
              details: {
                recoveryRecordPath: "/tmp/migration-report/recovery-required.json",
              },
            },
          ],
          reportDir: "/tmp/migration-report",
        };
      },
    });
    const page = await mountPage(createContext(request));

    await openImport(page);
    button(page, "import-confirm")?.click();

    await calls(request, 3);
    flush();
    expect(page.textContent).toContain("post-apply planning unavailable");
    expect(page.textContent).toContain("replacement interrupted");
    expect(page.textContent).toContain("/tmp/migration-report");
    expect(button(page, "import-provider-button")?.disabled).toBe(true);
  });

  it("admits one same-turn import and unlocks after its successful refresh", async () => {
    const request = createRequest({
      "migrations.memory.plan": () => createPlan(),
      "migrations.memory.apply": () => ({
        ...createApplyResult(),
        reportDir: "/tmp/migration-report",
      }),
    });
    const page = await mountPage(createContext(request));

    await openImport(page);
    const confirm = button(page, "import-confirm");
    confirm?.click();
    confirm?.click();
    expect(request).toHaveBeenCalledTimes(2);

    await calls(request, 3);
    await ready(page, "import-provider-button", false);
  });

  it("reuses the same frozen idempotency key when a failed apply is retried", async () => {
    const request = createRequest({
      "migrations.memory.plan": () => createPlan(),
      "migrations.memory.apply": vi
        .fn()
        .mockReturnValue(createApplyResult())
        .mockImplementationOnce(() => {
          throw new Error("response lost");
        }),
    });
    const page = await mountPage(createContext(request));

    await openImport(page);
    button(page, "import-confirm")?.click();
    await settle(() =>
      expect(page.querySelector(".memory-import__confirm [role='alert']")?.textContent).toBe(
        "response lost",
      ),
    );
    button(page, "import-confirm")?.click();

    await calls(request, 4);
    const firstApply = applyParams(request, 1);
    const retryApply = applyParams(request, 2);
    expect(firstApply?.idempotencyKey).toMatch(/\S/u);
    expect(retryApply).toEqual(firstApply);
  });

  it("retains selections, dates, previews and confirmation across a same-client reconnect", async () => {
    const plan = createPlan();
    plan.providers[0]!.items.push({
      ...plan.providers[0]!.items[0]!,
      id: "memory:codex:other.md",
      details: { collectionId: "other", collectionLabel: "Other", relativePath: "other.md" },
    });
    const request = createRequest({
      "migrations.memory.plan": (params) => ({ ...plan, agentId: params.agentId ?? "research" }),
      "memory.sessionBackfill.preview": () => ({
        days: 1,
        candidates: 1,
        staged: 0,
        perDay: [{ day: "2026-07-01", candidateCount: 1, sample: ["Retained preview"] }],
      }),
    });
    const context = createContext(request);
    const page = await mountPage(context);
    await settle(() => expect(collections(page)).toHaveLength(2));
    collections(page)[1]!.click();
    setDate(date(page)!);
    button(page, "backfill-preview")!.click();
    await textAppears(page, "Retained preview");
    await openImport(page);

    context.gateway.snapshot.phase = "stopped";
    context.gateway.snapshot.hello = null;
    context.notify();
    flush();
    flush();
    expect(button(page, "import-confirm")?.disabled).toBe(true);
    expect(date(page)?.value).toBe("2026-07-01");
    expect(page.textContent).toContain("Retained preview");

    context.gateway.snapshot.phase = "connected";
    context.notify();
    await calls(request, 3);
    await ready(page, "import-confirm", false);
    expect([...collections(page)].map((input) => input.checked)).toEqual([true, false]);
    expect(date(page)?.value).toBe("2026-07-01");
    expect(page.textContent).toContain("Retained preview");

    page
      .querySelector<HTMLButtonElement>(".memory-import__confirm button:not([data-test-id])")!
      .click();
    button(page, "backfill-rollback")!.click();
    flush();
    context.gateway.snapshot.phase = "reconnecting";
    context.notify();
    flush();
    expect(button(page, "backfill-rollback-confirm")?.disabled).toBe(true);
    context.gateway.snapshot.phase = "connected";
    context.notify();
    await calls(request, 4);
    expect(button(page, "backfill-rollback-confirm")).not.toBeNull();

    const replacementClient = { request } as unknown as GatewayBrowserClient;
    context.gateway.snapshot.client = replacementClient;
    context.gateway.snapshot.phase = "connected";
    context.notify();
    await calls(request, 5);
    expect(button(page, "import-confirm")).toBeNull();
    expect(button(page, "backfill-rollback-confirm")).toBeNull();
    expect(date(page)?.value).toBe("");
    expect(page.textContent).not.toContain("Retained preview");

    context.gateway.snapshot.hello = gatewayHelloForMethods([], ["operator.read"]);
    context.notify();
    await settle(() => expect(page.querySelector(".memory-import")).toBeNull());
    expect(page.textContent).not.toContain("/tmp/openclaw-research");
  });

  it.each(["account", "recovery"] as const)(
    "retires protected plans and drafts when the same client's %s identity changes",
    async (identity) => {
      const replacementPlan = createDeferredCore<ReturnType<typeof createPlan>>();
      const plan = vi
        .fn()
        .mockResolvedValueOnce(createPlan())
        .mockReturnValue(replacementPlan.promise);
      const request = createRequest({
        "migrations.memory.plan": plan,
      });
      const context = createContext(request);
      context.gateway.snapshot.selfUser = { id: "first", name: "First" };
      const hello = gatewayHelloForMethods(["memory.sessionBackfill.preview"]);
      context.gateway.snapshot.hello = {
        ...hello,
        auth: { ...hello.auth, recoveryScope: "first" },
      };
      const page = await mountPage(context);
      await openImport(page);
      setDate(date(page)!);
      const confirm = button(page, "import-confirm")!;

      if (identity === "account") {
        context.gateway.snapshot.selfUser = { id: "second", name: "Second" };
      } else {
        context.gateway.snapshot.hello = {
          ...hello,
          auth: { ...hello.auth, recoveryScope: "second" },
        };
      }
      context.notify();
      // A retained button cannot submit the previous identity's confirmation before rendering catches up.
      confirm.click();
      expectOnlyPlans(request);
      await calls(plan, 2);
      expect(button(page, "import-confirm")).toBeNull();
      expect(date(page)?.value).toBe("");
      expect(page.textContent).not.toContain("/tmp/openclaw-research");
      replacementPlan.resolve(createPlan());
      await ready(page, "import-provider-button");
    },
  );

  it.each(["disconnect", "roster loss"] as const)(
    "preserves an attempted import key across %s",
    async (interruption) => {
      const result = createApplyResult();
      const firstApplyResult = createDeferredCore<typeof result>();
      let applyRequests = 0;
      const request = createRequest({
        "migrations.memory.plan": () => createPlan(),
        "migrations.memory.apply": async () => {
          applyRequests += 1;
          if (applyRequests === 1) {
            return await firstApplyResult.promise;
          }
          return result;
        },
      });
      const context = createContext(request);
      const roster = context.agents.state.agentsList;
      const page = await mountPage(context);

      await openImport(page);
      button(page, "import-confirm")?.click();
      await calls(request, 2);
      const firstApply = applyParams(request, 1);

      if (interruption === "disconnect") {
        context.gateway.snapshot.phase = "stopped";
      } else {
        context.agents.state.agentsList = null;
        context.agents.state.agentsError = "Agent roster unavailable";
      }
      context.notify();
      flush();
      expect(button(page, "import-confirm")?.disabled ?? true).toBe(true);
      firstApplyResult.resolve(result);
      await Promise.resolve();

      if (interruption === "disconnect") {
        context.gateway.snapshot.phase = "connected";
      } else {
        context.agents.state.agentsList = roster;
        context.agents.state.agentsError = null;
      }
      context.notify();
      await calls(request, 3);
      await ready(page, "import-confirm");
      button(page, "import-confirm")?.click();
      await calls(request, 4);

      const retryApply = applyParams(request, 3);
      expect(firstApply?.idempotencyKey).toMatch(/\S/u);
      expect(retryApply).toEqual(firstApply);
    },
  );

  it.each(["import", "rollback"] as const)(
    "retires %s confirmation when the shared agent changes and its next plan fails",
    async (operation) => {
      const nextPlan = createDeferredCore<ReturnType<typeof createPlan>>();
      const request = createRequest({
        "migrations.memory.plan": (params) =>
          params.agentId === "writer" ? nextPlan.promise : createPlan(),
      });
      const context = createContext(request);
      context.agents.state.agentsList = agentRoster("research", "writer");
      const selection = createAgentSelectionCapability(context.gateway, context.agents);
      const page = await mountPage({ ...context, agentSelection: selection });
      try {
        await ready(page, "import-provider-button");
        if (operation === "import") {
          await openImport(page);
        } else {
          button(page, "backfill-rollback")?.click();
        }
        const selector =
          operation === "import"
            ? "[data-test-id='memory-import-confirm']"
            : "[data-test-id='memory-backfill-rollback-confirm']";
        await settle(() => expect(page.querySelector(selector)).not.toBeNull());
        const confirm = page.querySelector<HTMLButtonElement>(selector);

        selection.set("writer");
        confirm?.click();
        expect(request).toHaveBeenCalledTimes(2);

        await calls(request, 2);
        expect(request.mock.calls[1]?.[1]).toMatchObject({ agentId: "writer" });
        expect(page.querySelector(selector)).toBeNull();
        nextPlan.reject(new Error("Writer plan unavailable"));
        await settle(() => expect(page.textContent).toContain("Writer plan unavailable"));
        expect(page.querySelector(selector)).toBeNull();
        expectOnlyPlans(request);
      } finally {
        cleanupSolid();
        selection.dispose();
      }
    },
  );

  it.each(["import", "backfill"] as const)(
    "shows the next agent while the retired %s request is still pending",
    async (operation) => {
      const pending = createDeferredCore<unknown>();
      const request = createRequest({
        "migrations.memory.plan": (params) => createPlan(params.agentId),
        "migrations.memory.apply": () => pending.promise,
        "memory.sessionBackfill.apply": () => pending.promise,
      });
      const context = createContext(request);
      context.agents.state.agentsList = agentRoster("research", "writer");
      const page = await mountPage(context);
      if (operation === "import") {
        await openImport(page);
        button(page, "import-confirm")!.click();
        await ready(page, "import-confirm", true);
      } else {
        await ready(page, "backfill-apply", false);
        button(page, "backfill-apply")!.click();
        await ready(page, "backfill-apply", true);
      }

      context.agentSelection.state.selectedId = "writer";
      context.notify();
      await settle(() => {
        expect(page.textContent).toContain("/tmp/openclaw-writer");
        expect(page.textContent).not.toContain("/tmp/openclaw-research");
        expect(button(page, "import-confirm")).toBeNull();
      });
      await ready(page, "import-provider-button", false);
      pending.resolve(operation === "import" ? createApplyResult() : backfillChunk());
      await pending.promise;
      flush();
      expect(page.textContent).toContain("/tmp/openclaw-writer");
    },
  );

  it("previews past-session candidates with the selected date range", async () => {
    const request = createRequest({
      "migrations.memory.plan": () => createPlan(),
      "memory.sessionBackfill.preview": () => ({
        days: 1,
        candidates: 2,
        staged: 0,
        truncated: true,
        perDay: [
          { day: "2026-07-01", candidateCount: 2, sample: ["First memory", "Second memory"] },
        ],
      }),
    });
    const page = await mountPage(createContext(request));
    await ready(page, "backfill-preview");
    setDate(date(page)!);
    setDate(date(page, 1)!, "2026-07-31");
    button(page, "backfill-preview")?.click();

    await textAppears(page, "First memory");
    expect(page.textContent).toContain("preview shows the first bounded batch");
    expect(request.mock.calls.at(-1)).toEqual([
      "memory.sessionBackfill.preview",
      { agentId: "research", from: "2026-07-01", to: "2026-07-31", limitDays: 14 },
    ]);
  });

  it("applies backfill chunks until a call returns zero new candidates", async () => {
    const apply = vi
      .fn()
      .mockReturnValue(backfillChunk())
      .mockReturnValueOnce(backfillChunk(2, 3, 2, true))
      .mockReturnValueOnce(backfillChunk(1, 1, 1));
    const request = createRequest({
      "migrations.memory.plan": () => createPlan(),
      "memory.sessionBackfill.apply": apply,
    });
    const page = await mountPage(createContext(request));
    await ready(page, "backfill-apply");
    button(page, "backfill-apply")?.click();

    await settle(() =>
      expect(page.textContent).toContain("3 staged; promotion happens via dreaming"),
    );
    expect(apply).toHaveBeenCalledTimes(3);
    expect(page.textContent).toContain("4 session candidates processed");
    expect(page.textContent).toContain("1 day processed");

    setDate(date(page)!);
    flush();
    expect(page.textContent).not.toContain("3 staged; promotion happens via dreaming");
  });

  it("confirms rollback and surfaces gateway errors", async () => {
    const request = createRequest({
      "migrations.memory.plan": () => createPlan(),
      "memory.sessionBackfill.rollback": () => {
        throw new Error("rollback unavailable");
      },
    });
    const page = await mountPage(createContext(request));
    await ready(page, "backfill-rollback");
    button(page, "backfill-rollback")?.click();
    await ready(page, "backfill-rollback-confirm");
    button(page, "backfill-rollback-confirm")?.click();

    await textAppears(page, "rollback unavailable");
    expect(request.mock.calls.at(-1)).toEqual([
      "memory.sessionBackfill.rollback",
      { agentId: "research" },
    ]);
  });
});
