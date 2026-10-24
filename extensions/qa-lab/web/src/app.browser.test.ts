/* @vitest-environment jsdom */
import type { QaBusStateSnapshot } from "openclaw/plugin-sdk/qa-channel-protocol";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  createBootstrap,
  httpMock,
  mountCapture,
  mountRunner,
  setupAppBrowserTests,
} from "./app.browser.test-support.js";
import type { EvidenceEnvelope, OutcomesEnvelope, RunnerSelection } from "./ui-types.js";

function createRunnerSelection(): RunnerSelection {
  return {
    alternateModel: "mock-openai/gpt-5.6-luna-alt",
    channel: null,
    channelDriver: "qa-channel",
    evidenceMode: "full",
    fastMode: false,
    primaryModel: "mock-openai/gpt-5.6-luna",
    profile: "all",
    providerMode: "mock-openai",
    runtimePair: null,
    runtimePairLane: null,
    scenarioIds: ["dm-chat-baseline"],
  };
}

async function mountRunningControlUi(controlUiUrl: string | null) {
  const selection: RunnerSelection = createRunnerSelection();
  const root = await mountRunner(selection);
  const getJson = httpMock.getJson.getMockImplementation()!;
  const bootstrap = createBootstrap(selection);
  bootstrap.runner.status = "running";
  bootstrap.runner.startedAt = "2026-09-19T00:00:00.000Z";
  const outcomes: OutcomesEnvelope = {
    run: {
      kind: "suite",
      status: "running",
      startedAt: bootstrap.runner.startedAt,
      scenarios: [{ id: "dm-chat-baseline", name: "DM baseline", status: "pending" }],
      counts: { total: 1, pending: 1, running: 0, passed: 0, failed: 0, skipped: 0 },
    },
  };
  const setControlUiUrl = (value: string | null) => {
    bootstrap.controlUiUrl = value;
    bootstrap.controlUiEmbeddedUrl = value;
  };
  setControlUiUrl(controlUiUrl);
  httpMock.getJson.mockImplementation(async (url: string) => {
    if (url === "/api/bootstrap") {
      return structuredClone(bootstrap);
    }
    if (url === "/api/outcomes") {
      return structuredClone(outcomes);
    }
    return getJson(url);
  });
  // The server publishes running/pending before the Gateway link, then waits for transport.
  // Consume that fingerprint first so it cannot hide a later link-only update.
  await vi.advanceTimersByTimeAsync(1_000);
  return { root, setControlUiUrl };
}

function query(root: HTMLElement) {
  return <T extends HTMLElement = HTMLElement>(selector: string) =>
    root.querySelector<T>(selector)!;
}

function setValue(root: HTMLElement, selector: string, value: string, event = "change") {
  const input = query(root)<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(selector);
  input.value = value;
  input.dispatchEvent(new Event(event, { bubbles: true }));
}

setupAppBrowserTests();

describe("QA Lab runner browser interactions", () => {
  it("keeps capture actions from releasing another pending action's busy state", async () => {
    const root = await mountRunner(createRunnerSelection());
    const $ = query(root);
    const reset = Promise.withResolvers<void>();
    httpMock.postJson.mockImplementationOnce(() => reset.promise);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    onTestFinished(() => confirm.mockRestore());
    try {
      $('[data-action="reset"]').click();
      $('[data-tab="capture"]').click();
      $("#capture-controls-toggle").click();
      $("[data-copy-text]").click();
      $("#capture-purge-all").click();
      await vi.advanceTimersByTimeAsync(0);

      expect($<HTMLButtonElement>('[data-action="refresh"]').disabled).toBe(true);
      expect(writeText).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      expect(httpMock.postJson).toHaveBeenCalledExactlyOnceWith("/api/reset", {});

      reset.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect($<HTMLButtonElement>('[data-action="refresh"]').disabled).toBe(false);
      $("[data-copy-text]").click();
      await vi.advanceTimersByTimeAsync(0);
      expect(writeText).toHaveBeenCalledOnce();
    } finally {
      reset.resolve();
    }
  });

  it("shows clipboard failures from capture startup commands", async () => {
    const root = await mountRunner(createRunnerSelection());
    const $ = query(root);
    const writeText = vi.fn().mockRejectedValue(new Error("Clipboard permission denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    $('[data-tab="capture"]').click();
    const copy = $<HTMLButtonElement>("[data-copy-text]");

    copy.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(writeText).toHaveBeenCalledExactlyOnceWith("pnpm proxy:start --port 7799");
    expect($(".header-status .badge-fail").textContent).toBe("Clipboard permission denied");
    expect($<HTMLButtonElement>('[data-action="refresh"]').disabled).toBe(false);
  });

  it.each([
    {
      selector: "#capture-delete-selected-sessions",
      endpoint: "/api/capture/delete-sessions",
      body: { sessionIds: ["capture-1"] },
    },
    { selector: "#capture-purge-all", endpoint: "/api/capture/purge", body: {} },
  ])(
    "shows $endpoint failures without discarding capture selection",
    async ({ selector, endpoint, body }) => {
      const root = await mountRunner(createRunnerSelection());
      const $ = query(root);
      await mountCapture(root);
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      onTestFinished(() => confirm.mockRestore());
      httpMock.postJson.mockRejectedValueOnce(new Error("Capture deletion failed"));
      const readsBefore = httpMock.getJson.mock.calls.length;
      $(selector).click();
      await vi.advanceTimersByTimeAsync(0);

      expect(httpMock.postJson).toHaveBeenCalledExactlyOnceWith(endpoint, body);
      expect($(".header-status .badge-fail").textContent).toBe("Capture deletion failed");
      expect(
        [...$<HTMLSelectElement>("#capture-session").selectedOptions].map((option) => option.value),
      ).toEqual(["capture-1"]);
      expect(httpMock.getJson.mock.calls).toHaveLength(readsBefore);
      expect($<HTMLButtonElement>('[data-action="refresh"]').disabled).toBe(false);
    },
  );

  it.each([
    { shiftKey: false, expectedIds: [1, 2] },
    { shiftKey: true, expectedIds: [1, 2, 3] },
  ])(
    "keeps the complete sparkline drag window across renders (shift=$shiftKey)",
    async ({ shiftKey, expectedIds }) => {
      const root = await mountRunner(createRunnerSelection());
      await mountCapture(
        root,
        [0, 600, 1200, 1800].map((ts, index) => ({
          id: index + 1,
          ts,
          kind: "request",
          host: "example.test",
          flowId: `flow-${index + 1}`,
          direction: "outbound",
          protocol: "https",
        })),
      );
      setValue(root, "#capture-view-mode", "timeline");

      const bins = () =>
        root.querySelectorAll<HTMLButtonElement>("[data-capture-sparkline-window]");
      bins()[0]!.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
      bins()[6]!.dispatchEvent(new MouseEvent("mouseenter"));
      window.dispatchEvent(new MouseEvent("mouseup", { shiftKey }));

      const visibleIds = () =>
        [...root.querySelectorAll<HTMLElement>(".capture-timeline-marker")].map((marker) =>
          Number(marker.dataset.captureEvent!.split(":")[0]),
        );
      expect(visibleIds()).toEqual(expectedIds);
      expect(root.querySelector(".capture-timeline-window-draft")).toBeNull();
      window.dispatchEvent(new MouseEvent("mouseup", { shiftKey: !shiftKey }));
      expect(visibleIds()).toEqual(expectedIds);
    },
  );

  it.each([
    ["left clipping", 0, 0, 320, 90, -20.5, 69.5],
    ["offset bordered scrollport", 200.25, 2, 320, 50, 500.75, 97.53125],
    ["already visible after scrolling", 0, 0, 320, 50, 100, 50],
  ] as const)(
    "reveals tabs after navigation replacement: %s",
    async (_name, navLeft, clientLeft, clientWidth, initialScroll, tabLeft, expected) => {
      const root = await mountRunner(createRunnerSelection());
      const $ = query(root);
      const oldNav = root.querySelector(".tab-bar");
      $('[data-tab="report"]').click();
      const tab = $<HTMLButtonElement>('[data-tab="capture"]');
      const nav = tab.parentElement!;
      expect(nav).not.toBe(oldNav);
      const main = nav.parentElement!;
      vi.spyOn(nav, "getBoundingClientRect").mockReturnValue(
        new DOMRect(navLeft, 81.5, clientWidth + 2 * clientLeft, 50.5),
      );
      vi.spyOn(tab, "getBoundingClientRect").mockReturnValue(
        new DOMRect(tabLeft, 89.5, 69.03125, 33.5),
      );
      let scrollLeft: number = initialScroll;
      const setScrollLeft = vi.fn((value: number) => {
        scrollLeft = value;
      });
      Object.defineProperties(nav, {
        clientLeft: { configurable: true, value: clientLeft },
        clientWidth: { configurable: true, value: clientWidth },
        scrollLeft: { configurable: true, get: () => scrollLeft, set: setScrollLeft },
      });
      nav.scrollTop = 17;
      main.scrollLeft = 11;
      main.scrollTop = 23;
      root.scrollLeft = 7;
      root.scrollTop = 13;

      tab.focus();

      expect(document.activeElement).toBe(tab);
      expect(nav.scrollLeft).toBe(expected);
      if (expected === initialScroll) {
        expect(setScrollLeft).not.toHaveBeenCalled();
      } else {
        expect(setScrollLeft).toHaveBeenCalledExactlyOnceWith(expected);
      }
      expect(nav.scrollTop).toBe(17);
      expect([main.scrollLeft, main.scrollTop, root.scrollLeft, root.scrollTop]).toEqual([
        11, 23, 7, 13,
      ]);
      expect($(".tab-btn.active").dataset.tab).toBe("report");
      expect(root.querySelector('[data-tab="capture"]')).toBe(tab);
      tab.click();
      expect($(".tab-btn.active").dataset.tab).toBe("capture");
    },
  );

  it("keeps header actions and the Control UI link alongside long errors", async () => {
    const selection: RunnerSelection = createRunnerSelection();
    const controlUiUrl = "https://control.example.test/";
    const root = await mountRunner(selection, undefined, null, controlUiUrl);
    const $ = query(root);
    expect($<HTMLAnchorElement>(".header-link").href).toBe(controlUiUrl);

    const message = `Request failed: <missing> ${"error-context".repeat(16)}`;
    httpMock.getJson.mockRejectedValueOnce(new Error(message));
    $('[data-action="refresh"]').click();
    await vi.waitFor(() => expect($(".header-status .badge-fail").textContent).toContain(message));
    expect($(".header-title").textContent).toBe("QA Lab");
    expect($<HTMLAnchorElement>(".header-link").href).toBe(controlUiUrl);
    expect(
      [...root.querySelectorAll<HTMLElement>(".header-right [data-action]")].map(
        (node) => node.dataset.action,
      ),
    ).toEqual(["toggle-sidebar", "refresh", "reset", "toggle-theme"]);
  });

  it("updates Control UI links only when bootstrap URLs change", async () => {
    const { root, setControlUiUrl } = await mountRunningControlUi(null);
    const readHref = () => root.querySelector(".header-link")?.getAttribute("href") ?? null;
    let previous: string | null = null;
    for (const next of [
      "http://127.0.0.1:43124/control-ui/",
      "http://127.0.0.1:43124/control-ui/?panel=chat",
      null,
    ]) {
      const header = root.querySelector(".header")!;
      const link = root.querySelector(".header-link");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(root.querySelector(".header")).toBe(header);
      expect(root.querySelector(".header-link")).toBe(link);
      expect(readHref()).toBe(previous);
      setControlUiUrl(next);
      expect(readHref()).toBe(previous);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(readHref()).toBe(next);
      expect(header.isConnected).toBe(false);
      previous = next;
    }
  });

  it("selects duplicate evidence labels independently before and after filtering", async () => {
    const originalUrl = window.location.href;
    onTestFinished(() => window.history.replaceState(null, "", originalUrl));
    window.history.replaceState(null, "", "/evidence?path=fixture/qa-evidence.json");
    const evidence: EvidenceEnvelope["evidence"] = {
      counts: { pass: 1, fail: 0, blocked: 0, skipped: 0 },
      entries: (["fail", "pass"] as const).map((status, index) => ({
        artifacts: [
          {
            exists: true,
            error: null,
            href: `/api/evidence/artifact?entryIndex=${index}&artifactIndex=0`,
            kind: "log",
            mediaKind: "text",
            path: `attempt-${index}.log`,
            preview: `observed attempt ${index}`,
            source: "synthetic-runner",
          },
        ],
        coverage: [],
        failureReason: null,
        key: String(index),
        effective: index === 1,
        id: "same-label",
        kind: "script-test",
        sourcePath: null,
        status,
        title: `Attempt ${index}`,
      })),
      evidenceMode: "full",
      evidencePath: "fixture/qa-evidence.json",
      generatedAt: "2026-06-17T12:00:00.000Z",
      producerContext: null,
      profile: null,
      schemaVersion: 3,
    };
    const root = await mountRunner(createRunnerSelection(), undefined, evidence);
    const $ = query(root);
    expect($(".evidence-inspector").textContent).toContain("observed attempt 0");
    $('[data-evidence-entry-key="1"]').click();
    expect($(".evidence-inspector").textContent).toContain("observed attempt 1");
    expect($(".evidence-inspector").textContent).not.toContain("observed attempt 0");
    expect(root.querySelectorAll(".evidence-entry-card.selected")).toHaveLength(1);
    setValue(root, "#evidence-status-filter", "fail");
    expect($(".evidence-inspector").textContent).toContain("observed attempt 0");
    expect($(".evidence-inspector").textContent).toContain("not counted");
    setValue(root, "#evidence-status-filter", "all");
    $('[data-evidence-entry-key="1"]').click();
    expect($(".evidence-inspector").textContent).toContain("observed attempt 1");
    expect(evidence.entries.map((entry) => entry.id)).toEqual(["same-label", "same-label"]);
  });

  it("sends group conversation messages from the interactive chat composer", async () => {
    const root = await mountRunner(createRunnerSelection(), {
      conversations: [{ accountId: "default", id: "qa-room", kind: "channel" }],
      cursor: 0,
      events: [],
      messages: [],
      threads: [
        {
          accountId: "default",
          conversationId: "qa-room",
          createdAt: 0,
          createdBy: "qa-operator",
          id: "owned-thread",
          title: "Owned thread",
        },
      ],
    });
    const $ = query(root);
    httpMock.postJson.mockResolvedValue({ message: { id: "group-message" } });

    $("[data-thread-select='owned-thread']").click();
    setValue(root, "#conversation-kind", "group");
    setValue(root, "#conversation-id", "qa-group", "input");
    setValue(root, "#composer-text", "hello group", "input");
    $("[data-action='send']").click();

    await vi.waitFor(() => expect(httpMock.postJson).toHaveBeenCalledTimes(1));
    expect(httpMock.postJson).toHaveBeenCalledWith(
      "/api/inbound/message",
      expect.objectContaining({
        accountId: "default",
        conversation: { id: "qa-group", kind: "group", title: "qa-group" },
        text: "hello group",
      }),
    );
    const submittedPayload = httpMock.postJson.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(submittedPayload).not.toHaveProperty("threadId");
  });

  it("keeps scenario rows from collapsing inside the scrolling list", async () => {
    const root = await mountRunner(createRunnerSelection());
    const $ = query(root);

    expect(getComputedStyle($(".scenario-scroll")).overflowY).toBe("auto");
    expect(getComputedStyle($(".scenario-item")).flexShrink).toBe("0");
  });

  it.each<{
    name: string;
    initial?: Partial<RunnerSelection>;
    changes: [string, string][];
    action?: string;
    expected: Partial<RunnerSelection>;
  }>([
    {
      name: "live-provider non-flow scenarios",
      initial: {
        alternateModel: "openai/gpt-5.6-luna",
        primaryModel: "openai/gpt-5.6-luna",
        channelDriver: "crabline",
        fastMode: true,
        providerMode: "live-frontier",
      },
      changes: [],
      action: "[data-action='select-all-scenarios']",
      expected: {
        channelDriver: "crabline",
        providerMode: "live-frontier",
        scenarioIds: ["dm-chat-baseline", "browser-talk-start-stop"],
      },
    },
    {
      name: "real channels with the mock provider",
      changes: [
        ["#channel-driver", "live"],
        ["#execution-channel", "telegram"],
      ],
      expected: { channelDriver: "live", channel: "telegram", providerMode: "mock-openai" },
    },
    {
      name: "profile, evidence, runtime pair and lane",
      initial: { channelDriver: "live" },
      changes: [
        ["#run-profile", "smoke-ci"],
        ["#execution-channel", "telegram"],
        ["#evidence-mode", "slim"],
        ["#runtime-pair", "openclaw,codex"],
        ["#runtime-pair-lane", "core"],
      ],
      expected: {
        profile: "smoke-ci",
        channel: "telegram",
        channelDriver: "crabline",
        evidenceMode: "slim",
        runtimePair: ["openclaw", "codex"],
        runtimePairLane: "core",
        scenarioIds: null,
      },
    },
    {
      name: "dirty profile overrides",
      changes: [["#run-profile", "smoke-ci"]],
      action: "[data-scenario-toggle-id='browser-talk-start-stop']",
      expected: { profile: "smoke-ci", scenarioIds: ["browser-talk-start-stop"] },
    },
  ])(
    "submits labeled configuration controls: $name",
    async ({ initial, changes, action, expected }) => {
      const root = await mountRunner({ ...createRunnerSelection(), ...initial });
      const $ = query(root);
      $("[data-sidebar-panel='config']").click();
      const selects = [...root.querySelectorAll<HTMLSelectElement>(".config-field select")];
      expect(selects).toHaveLength(9);
      expect(selects.map((select) => select.labels?.[0]?.textContent?.trim())).toEqual([
        "Profile",
        "Provider lane",
        "Channel driver",
        "Execution channel",
        "Evidence mode",
        "Runtime pair",
        "Runtime-pair lane",
        "Primary model",
        "Alternate model",
      ]);
      for (const [selector, value] of changes) {
        setValue(root, selector, value);
      }
      if (action) {
        $("[data-sidebar-panel='scenarios']").click();
        $(action).click();
      }
      $("[data-action='run-suite']").click();
      await vi.waitFor(() => expect(httpMock.postJson).toHaveBeenCalledTimes(1));
      expect(httpMock.postJson).toHaveBeenCalledWith(
        "/api/scenario/suite",
        expect.objectContaining(expected),
      );
    },
  );

  it("renders server-resolved exclusions and errors from a rejected launch", async () => {
    const root = await mountRunner(createRunnerSelection());
    const $ = query(root);
    httpMock.postJson.mockRejectedValueOnce(
      new httpMock.QaLabHttpError("selection rejected", {
        plan: {
          errors: ["Explicit QA scenario selection is not runnable."],
          exclusions: [
            {
              executionKind: "flow",
              reasons: ["channel=telegram"],
              scenarioId: "dm-chat-baseline",
            },
          ],
          executionKinds: [],
          explicitScenarioSelection: true,
          profile: "all",
          selectedScenarios: [],
          status: "invalid",
        },
      }),
    );

    $("[data-action='run-suite']").click();

    await vi.waitFor(() => expect(root.textContent).toContain("1 excluded"));
    expect(root.textContent).toContain("Explicit QA scenario selection is not runnable");

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(root.textContent).toContain("1 excluded"));
    expect(root.textContent).toContain("Explicit QA scenario selection is not runnable");

    $("[data-sidebar-panel='config']").click();
    setValue(root, "#evidence-mode", "slim");
    $("[data-sidebar-panel='run']").click();
    expect(root.textContent).not.toContain("Explicit QA scenario selection is not runnable");
    expect(root.textContent).not.toContain("Resolved plan:");
  });

  it("disables launch when an explicit override becomes empty", async () => {
    const root = await mountRunner(createRunnerSelection());
    const $ = query(root);

    $("[data-scenario-toggle-id='dm-chat-baseline']").click();
    const runButton = $<HTMLButtonElement>("[data-action='run-suite']");
    expect(runButton.disabled).toBe(true);
    expect(runButton.textContent).toContain("Run 0 scenarios");
    runButton.click();
    expect(httpMock.postJson).not.toHaveBeenCalled();
  });
});

describe("QA Lab tab navigation retention", () => {
  async function mountNavigation() {
    const snapshot: QaBusStateSnapshot = {
      conversations: [{ accountId: "default", id: "alice", kind: "direct" }],
      cursor: 0,
      events: [],
      messages: [],
      threads: [],
    };
    const root = await mountRunner(createRunnerSelection(), snapshot);
    const $ = query(root);
    return { root, snapshot, $ };
  }

  async function pollWithMessage(snapshot: QaBusStateSnapshot) {
    const message: QaBusStateSnapshot["messages"][number] = {
      accountId: "default",
      conversation: { id: "alice", kind: "direct" },
      direction: "inbound",
      id: `message-${snapshot.messages.length + 1}`,
      reactions: [],
      senderId: "alice",
      text: "new polling message",
      timestamp: 1,
    };
    snapshot.messages.push(message);
    snapshot.events.push({
      accountId: message.accountId,
      cursor: ++snapshot.cursor,
      kind: "inbound-message",
      message,
    });
    await vi.advanceTimersByTimeAsync(1_000);
  }

  function mockTabGeometry(root: HTMLElement) {
    const offsets = new WeakMap<Element, number>();
    const width = (nav: Element) =>
      nav.closest(".app-shell--evidence-focus, .app-shell--sidebar-collapsed") ? 800 : 440;
    // jsdom has no layout. Model the shell width and native clamping while the
    // actual app binding and revealTab own every focus-driven scroll adjustment.
    const clientWidth = vi
      .spyOn(Element.prototype, "clientWidth", "get")
      .mockImplementation(function (this: Element) {
        return root.contains(this) && this.matches("nav.tab-bar") ? width(this) : 0;
      });
    const scrollGet = vi.spyOn(Element.prototype, "scrollLeft", "get").mockImplementation(function (
      this: Element,
    ) {
      return offsets.get(this) ?? 0;
    });
    const scrollSet = vi.spyOn(Element.prototype, "scrollLeft", "set").mockImplementation(function (
      this: Element,
      value: number,
    ) {
      offsets.set(this, Math.max(0, Math.min(value, 600 - width(this))));
    });
    const rect = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      if (root.contains(this) && this.matches("nav.tab-bar")) {
        return new DOMRect(0, 0, width(this), 40);
      }
      const nav = this.parentElement;
      if (root.contains(this) && nav?.matches("nav.tab-bar") && this.matches("button[data-tab]")) {
        return new DOMRect([...nav.children].indexOf(this) * 100 - nav.scrollLeft, 0, 100, 40);
      }
      return new DOMRect();
    });
    onTestFinished(() => {
      rect.mockRestore();
      scrollSet.mockRestore();
      scrollGet.mockRestore();
      clientWidth.mockRestore();
    });
  }

  it.each([false, true])(
    "retains tab visibility and sidebar preference across width changes (collapsed=%s)",
    async (collapsed) => {
      localStorage.setItem("qa-lab-sidebar-collapsed", collapsed ? "1" : "0");
      const { root, snapshot, $ } = await mountNavigation();
      const tab = (id: string) => $(`[data-tab="${id}"]`);
      mockTabGeometry(root);
      expect(
        [...root.querySelectorAll<HTMLElement>("[data-tab]")].map((node) => node.dataset.tab),
      ).toEqual(["chat", "results", "evidence", "report", "events", "capture"]);
      tab("capture").focus();
      expect(tab("capture").parentElement!.scrollLeft).toBe(collapsed ? 0 : 160);
      tab("evidence").focus();
      tab("evidence").click();
      const evidence = tab("evidence");
      expect(document.activeElement).toBe(evidence);
      expect(evidence.classList.contains("active")).toBe(true);
      expect(evidence.parentElement!.clientWidth).toBe(800);
      expect(evidence.parentElement!.scrollLeft).toBe(0);
      expect(evidence.getBoundingClientRect().left).toBeGreaterThanOrEqual(0);
      expect(root.querySelector(".app-shell--evidence-focus")).not.toBeNull();
      expect(Boolean(root.querySelector(".app-shell--sidebar-collapsed"))).toBe(collapsed);
      expect(localStorage.getItem("qa-lab-sidebar-collapsed")).toBe(collapsed ? "1" : "0");
      tab("capture").focus();
      expect(tab("capture").parentElement!.clientWidth).toBe(800);
      expect(tab("capture").parentElement!.scrollLeft).toBe(0);
      tab("capture").click();
      const next = tab("capture");
      const nav = next.parentElement!;
      expect(document.activeElement).toBe(next);
      expect(next.classList.contains("active")).toBe(true);
      expect(nav.clientWidth).toBe(collapsed ? 800 : 440);
      expect(nav.scrollLeft).toBe(collapsed ? 0 : 160);
      expect(next.getBoundingClientRect().right).toBeLessThanOrEqual(nav.clientWidth);
      expect(root.querySelector(".app-shell--evidence-focus")).toBeNull();
      expect(Boolean(root.querySelector(".app-shell--sidebar-collapsed"))).toBe(collapsed);
      await pollWithMessage(snapshot);
      expect(document.activeElement).toBe(tab("capture"));
      expect(tab("capture").parentElement!.scrollLeft).toBe(nav.scrollLeft);
      $('[data-action="toggle-sidebar"]').click();
      expect(localStorage.getItem("qa-lab-sidebar-collapsed")).toBe(collapsed ? "0" : "1");
      tab("evidence").click();
      tab("chat").click();
      expect(Boolean(root.querySelector(".app-shell--sidebar-collapsed"))).toBe(!collapsed);
    },
  );

  it.each([false, true])(
    "retains focused tabs through unchanged and changed polling (activate=%s)",
    async (activate) => {
      const { root, snapshot, $ } = await mountNavigation();
      const tab = activate ? "events" : "capture";
      let nav = $("nav.tab-bar");
      let button = nav.querySelector<HTMLButtonElement>(`[data-tab="${tab}"]`)!;
      button.focus();
      nav.scrollLeft = 137.25;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(root.querySelector("nav.tab-bar")).toBe(nav);
      expect(document.activeElement).toBe(button);
      expect(nav.scrollLeft).toBe(137.25);
      expect(httpMock.getJson.mock.calls.filter(([url]) => url === "/api/state")).toHaveLength(2);
      if (activate) {
        button.click();
        expect(button.isConnected).toBe(false);
        nav = $("nav.tab-bar");
        button = nav.querySelector<HTMLButtonElement>(`[data-tab="${tab}"]`)!;
        expect(document.activeElement).toBe(button);
        expect(button.classList.contains("active")).toBe(true);
        expect(nav.scrollLeft).toBe(137.25);
      }
      const focusReveals: number[] = [];
      root.addEventListener(
        "focus",
        (event) => {
          if (event.target instanceof HTMLButtonElement && event.target.dataset.tab === tab) {
            const focusedNav = event.target.parentElement!;
            focusedNav.scrollLeft = 243.75;
            focusReveals.push(focusedNav.scrollLeft);
          }
        },
        true,
      );
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      onTestFinished(() => focus.mockRestore());
      await pollWithMessage(snapshot);
      const nextNav = $("nav.tab-bar");
      const nextButton = nextNav.querySelector<HTMLButtonElement>(`[data-tab="${tab}"]`)!;
      expect(nextNav).not.toBe(nav);
      expect(button.isConnected).toBe(false);
      expect(document.activeElement).toBe(nextButton);
      expect(nextNav.scrollLeft).toBe(137.25);
      expect(focusReveals).toEqual([243.75]);
      expect(focus).toHaveBeenCalledTimes(1);
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(nextNav.querySelector<HTMLElement>(".active")?.dataset.tab).toBe(
        activate ? "events" : "chat",
      );
      expect($(activate ? ".events-scroll" : "#chat-messages").textContent).toContain(
        "new polling message",
      );
      expect(httpMock.getJson.mock.calls.filter(([url]) => url === "/api/state")).toHaveLength(3);
      nextButton.blur();
      nextButton.focus();
      expect(document.activeElement).toBe(nextButton);
      expect(nextNav.scrollLeft).toBe(243.75);
      expect(focusReveals).toEqual([243.75, 243.75]);
    },
  );

  it.each([false, true])(
    "retains scroll without stealing non-tab focus (outside=%s)",
    async (outside) => {
      const { root, snapshot, $ } = await mountNavigation();
      mockTabGeometry(root);
      if (outside) {
        $('[data-tab="report"]').focus();
        const outsideNav = document.createElement("nav");
        outsideNav.className = "tab-bar";
        const button = document.createElement("button");
        button.dataset.tab = "report";
        button.id = "composer-text";
        outsideNav.append(button);
        document.body.append(outsideNav);
        button.focus();
      }
      const focused = document.activeElement;
      const nav = $("nav.tab-bar");
      nav.scrollLeft = 64.5;
      await pollWithMessage(snapshot);
      expect(root.querySelector("nav.tab-bar")).not.toBe(nav);
      expect($("nav.tab-bar").scrollLeft).toBe(64.5);
      expect(document.activeElement).toBe(focused);
      for (const tab of ["evidence", "capture"]) {
        $(`[data-tab="${tab}"]`).click();
        expect($("nav.tab-bar").scrollLeft).toBe(0);
        expect(document.activeElement).toBe(focused);
      }
    },
  );

  it.each(["#conversation-id", "#composer-text"])(
    "preserves %s focus and draft while retaining navigation scroll",
    async (selector) => {
      const { root, snapshot, $ } = await mountNavigation();
      const nav = $("nav.tab-bar");
      const input = $<HTMLInputElement | HTMLTextAreaElement>(selector);
      setValue(root, selector, "unfinished draft", "input");
      input.focus();
      nav.scrollLeft = 48.5;

      await pollWithMessage(snapshot);

      const nextInput = $<HTMLInputElement | HTMLTextAreaElement>(selector);
      expect(input.isConnected).toBe(false);
      expect(document.activeElement).toBe(nextInput);
      expect(nextInput.value).toBe("unfinished draft");
      expect($("nav.tab-bar").scrollLeft).toBe(48.5);
    },
  );

  it("defers changed polling while a select is focused and renders after it blurs", async () => {
    const { root, snapshot, $ } = await mountNavigation();
    const select = $<HTMLSelectElement>("#conversation-kind");
    const nav = root.querySelector("nav.tab-bar");
    select.focus();

    await pollWithMessage(snapshot);

    expect(root.querySelector("nav.tab-bar")).toBe(nav);
    expect(document.activeElement).toBe(select);
    expect($("#chat-messages").textContent).not.toContain("new polling message");
    select.blur();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(root.querySelector("nav.tab-bar")).not.toBe(nav);
    expect(select.isConnected).toBe(false);
    expect($("#chat-messages").textContent).toContain("new polling message");
    expect(document.activeElement).toBe(document.body);
  });
});
