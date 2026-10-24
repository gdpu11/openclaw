import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { seedUnindexedTranscriptForTest } from "../../config/sessions/session-accessor.sqlite-import.test-support.js";
import { replaceTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { runWithSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { serializeCacheTtlToolResultProjections } from "../embedded-agent-runner/cache-ttl-checkpoint.js";
import {
  createToolResultPromptProjectionState,
  persistToolResultProjections,
} from "../embedded-agent-runner/session-prompt-state.js";
import {
  restoreCacheTtlToolResultProjections,
  truncateOversizedToolResultsInMessages,
} from "../embedded-agent-runner/tool-result-truncation.js";
import type { AgentMessage } from "../runtime/index.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { sessionScope } from "./session-manager-fixtures.test-support.js";
import { SessionManager } from "./session-manager.js";

const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-session-cache-ttl-");

const branchIds = (manager: SessionManager) => manager.getBranch().map((entry) => entry.id);
const projection = (manager: SessionManager) =>
  serializeCacheTtlToolResultProjections(restore(manager));

async function createSessionScope(sessionId: string) {
  const dir = tempDirs.make();
  const scope = sessionScope(path.join(dir, "sessions.json"), sessionId);
  await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
  return { dir, scope };
}

function tool(text: string): Extract<AgentMessage, { role: "toolResult" }> {
  return {
    role: "toolResult",
    toolCallId: "reused",
    toolName: "read",
    content: [{ type: "text", text: `${text}:${"x".repeat(5_000)}` }],
    isError: false,
    timestamp: 42,
  };
}

async function seedProjection(sessionId: string, afterReset = false, cacheTouches = 0) {
  const { dir, scope } = await createSessionScope(sessionId);
  const source = await SessionManager.openAsync(scope, dir);
  const olderId = await source.appendMessageAsync(makeUserMessage("read files", 1));
  if (!olderId) {
    throw new Error("Missing fixture user entry");
  }
  if (afterReset) {
    await source.appendResetBoundaryAsync("new");
  }
  await source.appendMessageAsync(tool("older-one"));
  await source.appendMessageAsync(tool("older-two"));
  const state = createToolResultPromptProjectionState();
  const project = () =>
    truncateOversizedToolResultsInMessages(
      source.buildSessionContext().messages,
      128_000,
      1_000,
      20_000,
      state,
    ).messages;
  const persist = () =>
    persistToolResultProjections(state, (customType, data) =>
      source.appendCustomEntryAsync(customType, data),
    );
  project();
  await persist();
  const checkpointId = source.getLeafId()!;
  for (let index = 0; index < cacheTouches; index++) {
    await persistToolResultProjections(
      state,
      (customType, data) => source.appendCustomEntryAsync(customType, data),
      { timestamp: index, provider: "anthropic", modelId: "claude-sonnet-4-6" },
    );
  }
  const retainedId = await source.appendMessageAsync(tool("retained"));
  if (!retainedId) {
    throw new Error("Missing retained fixture tool result");
  }
  const expected = project().at(-1)!;
  await persist();
  const deltaId = source.getLeafId()!;
  const tail = source.getBranch().slice(-2);
  const tailBytes = [source.getHeader(), ...tail].reduce(
    (bytes, entry) => bytes + Buffer.byteLength(JSON.stringify(entry)) + 1,
    0,
  );
  return {
    dir,
    scope,
    source,
    state,
    olderId,
    checkpointId,
    retainedId,
    deltaId,
    expected,
    tailBytes,
    options: (maxEvents = 2, maxBytes = 64_000) => ({ cwd: dir, maxEvents, maxBytes }),
    prefix: () => [
      source.getHeader(),
      ...source.getBranch().filter((entry) => entry.id !== retainedId && entry.id !== deltaId),
    ],
  };
}

function restore(manager: SessionManager) {
  const state = createToolResultPromptProjectionState();
  restoreCacheTtlToolResultProjections(state, manager.getToolResultProjectionEntries());
  return state;
}

function replay(manager: SessionManager) {
  return truncateOversizedToolResultsInMessages(
    manager.buildSessionContext().messages,
    128_000,
    4_000,
    20_000,
    restore(manager),
  ).messages;
}

function projectionEntries(fixture: Awaited<ReturnType<typeof seedProjection>>) {
  const checkpoint = fixture.source.getEntry(fixture.checkpointId);
  const retained = fixture.source.getEntry(fixture.retainedId);
  const delta = fixture.source.getEntry(fixture.deltaId);
  if (
    checkpoint?.type !== "custom" ||
    retained?.type !== "message" ||
    retained.message.role !== "toolResult" ||
    delta?.type !== "custom"
  ) {
    throw new Error("Missing fixture projection entries");
  }
  return { checkpoint, retained, delta };
}

it.each(["events", "bytes"] as const)(
  "preserves projected text and pre-cutoff ambiguity beyond the bounded %s window",
  async (cutoff) => {
    const fixture = await seedProjection(`projection-cutoff-${cutoff}`);
    const bounded = await SessionManager.openBoundedAsync(fixture.scope, {
      cwd: fixture.dir,
      maxEvents: cutoff === "events" ? 2 : 100,
      maxBytes: cutoff === "bytes" ? fixture.tailBytes : 64_000,
    });
    expect(branchIds(bounded)).toEqual([fixture.retainedId, fixture.deltaId]);
    expect(bounded.getEntry(fixture.checkpointId)).toBeUndefined();
    expect(bounded.getToolResultProjectionEntries().map((entry) => entry.id)).toContain(
      fixture.checkpointId,
    );
    expect(replay(bounded)).toEqual([fixture.expected]);
    expect(bounded.getBranch()).toHaveLength(2);
  },
);

it("keeps the projection prefix behind the admitted-turn read fence", async () => {
  const fixture = await seedProjection("projection-fence");
  const admission = await fixture.source.appendMessageWithTranscriptAnchorAsync(
    makeUserMessage("next turn", 2),
  );
  if (!admission.anchor) {
    throw new Error("missing admission anchor");
  }
  for (const [key, replacement] of fixture.state.replacements) {
    fixture.state.replacements.set(key, {
      ...replacement,
      content: [{ type: "text", text: "later replacement outside the fence" }],
    });
  }
  const laterCheckpointId = await fixture.source.appendCustomEntryAsync(
    "openclaw.cache-ttl",
    serializeCacheTtlToolResultProjections(fixture.state),
  );
  const bounded = await runWithSessionTranscriptReadFence(
    { ...admission.anchor, logicalTurnId: "projection-fence", role: "user" },
    () => SessionManager.openBoundedAsync(fixture.scope, fixture.options()),
  );
  expect(branchIds(bounded)).toEqual([fixture.retainedId, fixture.deltaId]);
  expect(bounded.getToolResultProjectionEntries().map((entry) => entry.id)).not.toContain(
    laterCheckpointId,
  );
  expect(replay(bounded)).toEqual([fixture.expected]);
});

it.each(["delta", "checkpoint"] as const)(
  "restores distinct compaction and tail projections with a retained %s",
  async (marker) => {
    const fixture = await seedProjection(`projection-compaction-${marker}`);
    const { checkpoint, retained, delta } = projectionEntries(fixture);
    const laterState = serializeCacheTtlToolResultProjections(fixture.state);
    const compaction = {
      type: "compaction",
      id: "injected-compaction",
      parentId: checkpoint.id,
      timestamp: checkpoint.timestamp,
      summary: "Earlier conversation summarized.",
      firstKeptEntryId: fixture.olderId,
      tokensBefore: 10_000,
    };
    expect(
      replaceTranscriptEventsSync(fixture.scope, [
        ...fixture.prefix(),
        compaction,
        { ...retained, parentId: compaction.id },
        marker === "checkpoint" ? { ...delta, data: laterState } : delta,
      ]),
    ).toBe(true);
    const options = fixture.options(2);
    const bounded = await SessionManager.openBoundedAsync(fixture.scope, options);
    const detached = await SessionManager.openDetachedBoundedAsync(fixture.scope, options);
    for (const manager of [bounded, detached]) {
      expect(branchIds(manager)).toEqual([compaction.id, retained.id, delta.id]);
      expect(manager.buildSessionContext().messages.map((message) => message.role)).toEqual([
        "compactionSummary",
        "toolResult",
      ]);
      expect(projection(manager)).toEqual(laterState);

      await manager.branchAsync(compaction.id);
      expect(branchIds(manager)).toEqual([compaction.id]);
      expect(projection(manager)).toEqual(checkpoint.data);
      expect(manager.buildSessionContext().messages).toHaveLength(1);

      await manager.branchAsync(delta.id);
      expect(projection(manager)).toEqual(laterState);
      expect(replay(manager).at(-1)).toEqual(fixture.expected);
    }
  },
);

it("reconstructs cold forks from pre-compaction projections without crossing a branch or reset", async () => {
  const { prepareEmbeddedSessionForkContext } =
    await import("../embedded-agent-runner/session-fork-context.js");
  const fixture = await seedProjection("cold-fork-projections");
  await fixture.source.appendCompactionAsync(
    "Earlier work summarized.",
    fixture.retainedId,
    10_000,
  );
  const model = makeProviderModelFixture({
    provider: "openai",
    id: "gpt-4o",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
  });
  const fork = () =>
    prepareEmbeddedSessionForkContext({
      target: fixture.scope,
      sessionFile: fixture.scope.sessionKey,
      model,
      workspaceDir: fixture.dir,
      agentDir: fixture.dir,
      agentId: fixture.scope.agentId,
      config: { plugins: { enabled: false }, agents: { defaults: { workspace: fixture.dir } } },
      assertCurrent() {},
    });
  const lastToolContent = async () =>
    (await fork()).messages.findLast((message) => message.role === "toolResult")?.content;

  // Both the checkpoint and its delta precede compaction and are absent from model messages.
  if (fixture.expected.role !== "toolResult") {
    throw new Error("Missing projected fixture tool result");
  }
  const compactedContent = await lastToolContent();
  expect(compactedContent).toEqual(fixture.expected.content);
  expect(JSON.stringify(compactedContent).length).toBeLessThan(1_100);

  // The sibling branch ends before the delta that first projected this same canonical result.
  await fixture.source.branchAsync(fixture.retainedId);
  await fixture.source.appendMessageAsync(makeUserMessage("Review the selected branch", 2));
  expect(await lastToolContent()).toEqual(tool("retained").content);

  await fixture.source.appendResetBoundaryAsync("new");
  await fixture.source.appendMessageAsync(tool("retained"));
  expect(await lastToolContent()).toEqual(tool("retained").content);
});

it("preserves checkpoint metadata in synchronous detached views", async () => {
  const fixture = await seedProjection("projection-detached-sync");
  const options = fixture.options(2);
  const detached = SessionManager.openDetachedBounded(fixture.scope, options);
  expect(detached.getSessionTarget()).toBeUndefined();
  expect(branchIds(detached)).toEqual([fixture.retainedId, fixture.deltaId]);
  expect(replay(detached)).toEqual([fixture.expected]);
});

it.each([
  ["label", false, false],
  ["model_change", false, false],
  ["label", true, false],
  ["model_change", false, true],
] as const)(
  "preserves hidden %s anchors (reset=%s, forward parents=%s)",
  async (kind, afterReset, reordered) => {
    const fixture = await seedProjection(`projection-hidden-${kind}`, afterReset);
    const { checkpoint, retained, delta } = projectionEntries(fixture);
    const hidden = {
      id: "hidden-anchor",
      parentId: checkpoint.id,
      timestamp: checkpoint.timestamp,
      ...(kind === "label"
        ? { type: "label", targetId: fixture.olderId, label: "earlier message" }
        : { type: "model_change", provider: "openai" }),
    };
    const retainedWithParent = { ...retained, parentId: hidden.id };
    const entries = reordered
      ? [
          fixture.source.getHeader(),
          retainedWithParent,
          delta,
          { ...checkpoint, parentId: null },
          hidden,
          {
            type: "leaf",
            id: "imported-active-leaf",
            parentId: hidden.id,
            targetId: delta.id,
            timestamp: checkpoint.timestamp,
          },
        ]
      : [...fixture.prefix(), hidden, retainedWithParent, delta];
    expect(replaceTranscriptEventsSync(fixture.scope, entries)).toBe(true);
    const options = fixture.options(3);
    const bounded = await SessionManager.openBoundedAsync(fixture.scope, options);
    const detached = await SessionManager.openDetachedBoundedAsync(fixture.scope, options);
    for (const manager of [bounded, detached]) {
      expect(manager.getEntry(hidden.id)).toBeUndefined();
      expect(manager.getEntry(checkpoint.id)).toBeUndefined();
      expect(branchIds(manager)).toEqual([retained.id, delta.id]);
      expect(replay(manager)).toEqual([fixture.expected]);
    }
    expect(detached.getSessionTarget()).toBeUndefined();
  },
);

it.each([
  ["bounded", "continue", false],
  ["detached", "continue", false],
  ["bounded", "reset", false],
  ["detached", "reset", false],
  ["bounded", "summary", false],
  ["detached", "summary", false],
  ["bounded", "continue", true],
  ["detached", "continue", true],
  ["bounded", "leaf", false],
  ["detached", "leaf", false],
  ["bounded", "summary", true],
  ["detached", "refused summary", true],
] as const)(
  "restores an opaque-only %s suffix through %s navigation (reset=%s)",
  async (mode, action, afterReset) => {
    const fixture = await seedProjection(`projection-opaque-only-${mode}-${action}`, afterReset);
    await fixture.source.appendLabelChangeAsync(fixture.olderId, "earlier message");
    const expected = serializeCacheTtlToolResultProjections(fixture.state);
    const options = fixture.options(1);
    const manager =
      mode === "bounded"
        ? await SessionManager.openBoundedAsync(fixture.scope, options)
        : await SessionManager.openDetachedBoundedAsync(fixture.scope, options);
    expect(manager.buildSessionContext().messages).toEqual([]);
    expect(projection(manager)).toEqual(expected);
    if (action === "continue") {
      const id = await manager.appendMessageAsync(makeUserMessage("continue", 3));
      if (!id) {
        throw new Error("Missing continuation fixture entry");
      }
      expect(projection(manager)).toEqual(expected);
      await manager.branchAsync(id);
      expect(projection(manager)).toEqual(expected);
    }
    if (action === "summary" || action === "refused summary") {
      const boundary = afterReset
        ? fixture.source.getBranch().find((entry) => entry.type === "reset")
        : undefined;
      if (afterReset && !boundary) {
        throw new Error("Missing fixture reset boundary");
      }
      if (action === "refused summary" && boundary) {
        expect(manager.getEntry(fixture.olderId)).toBeUndefined();
        await expect(
          manager.branchWithSummaryAsync(fixture.olderId, "unavailable branch"),
        ).rejects.toThrow("not found");
        expect(projection(manager)).toEqual(expected);
        return;
      }
      if (boundary) {
        expect(manager.getEntry(boundary.id)).toMatchObject({ type: "reset", id: boundary.id });
      }
      await manager.branchWithSummaryAsync(boundary?.id ?? null, "new branch");
    } else if (action === "leaf") {
      await manager.appendLeafControlAsync({ targetId: null, appendParentId: null });
    } else {
      await manager.resetLeafAsync();
    }
    expect(projection(manager)).toEqual({
      prunedToolResults: [],
      ambiguousToolResultBaseKeys: [],
      frozenToolResults: [],
    });
  },
);

it.each(["delta", "checkpoint", "no marker"] as const)(
  "preserves earlier detached branches with a retained %s suffix",
  async (suffix) => {
    const fixture = await seedProjection(`projection-earlier-branch-${suffix}`);
    const checkpoint = fixture.source.getEntry(fixture.checkpointId);
    if (checkpoint?.type !== "custom") {
      throw new Error("Missing fixture checkpoint");
    }
    const branch = fixture.source
      .getBranch()
      .filter((entry) => suffix === "delta" || entry.id !== fixture.deltaId);
    if (suffix !== "no marker") {
      branch.push({
        ...checkpoint,
        id: "latest-checkpoint",
        parentId: suffix === "delta" ? fixture.deltaId : fixture.retainedId,
        data: serializeCacheTtlToolResultProjections(fixture.state),
      });
    }
    expect(
      replaceTranscriptEventsSync(fixture.scope, [fixture.source.getHeader(), ...branch]),
    ).toBe(true);
    const detached = await SessionManager.openDetachedBoundedAsync(fixture.scope, {
      cwd: fixture.dir,
      maxEvents: suffix === "delta" ? 3 : suffix === "checkpoint" ? 2 : 1,
      maxBytes: 64_000,
    });
    await detached.branchAsync(suffix === "delta" ? fixture.deltaId : fixture.retainedId);
    expect(projection(detached)).toEqual(
      suffix === "delta" ? serializeCacheTtlToolResultProjections(fixture.state) : checkpoint.data,
    );
  },
);

it("preserves projection dependencies when a rewrite replaces the bounded anchor", async () => {
  const fixture = await seedProjection("projection-rewritten-anchor");
  const bounded = await SessionManager.openBoundedAsync(fixture.scope, fixture.options());
  const rewrite = await bounded.prepareTranscriptRewriteAsync();
  const branch = rewrite.sessionManager.getBranch();
  await rewrite.sessionManager.resetLeafAsync();
  const rewrittenIds = new Map<string, string>();
  for (const entry of branch) {
    if (entry.type === "message") {
      if (entry.message.role !== "toolResult") {
        throw new Error("Unexpected non-tool message in projection rewrite fixture");
      }
      const replacementId = await rewrite.sessionManager.appendMessageAsync(entry.message);
      if (!replacementId) {
        throw new Error("Missing rewritten fixture message");
      }
      rewrittenIds.set(entry.id, replacementId);
    } else if (entry.type === "custom") {
      rewrittenIds.set(
        entry.id,
        await rewrite.sessionManager.appendCustomEntryAsync(entry.customType, entry.data),
      );
    }
  }
  await rewrite.commit(rewrittenIds);
  expect(bounded.getBranch()[0]?.id).not.toBe(fixture.retainedId);
  expect(replay(bounded)).toEqual([fixture.expected]);
  await bounded.branchAsync(fixture.deltaId);
  expect(replay(bounded)).toEqual([fixture.expected]);
});

it("recovers projection dependencies without retaining intervening cache touches", async () => {
  const fixture = await seedProjection("projection-many-touches", false, 40);
  const bounded = await SessionManager.openBoundedAsync(fixture.scope, fixture.options());
  expect(bounded.getToolResultProjectionEntries().map((entry) => entry.id)).toEqual([
    fixture.checkpointId,
    fixture.retainedId,
    fixture.deltaId,
  ]);
  expect(replay(bounded)).toEqual([fixture.expected]);
});

it.each([{ cacheTtlDelta: null }, { prunedToolResults: null }, null, "damaged marker"])(
  "preserves an omitted malformed projection barrier %j before a retained delta",
  async (data) => {
    const fixture = await seedProjection("projection-malformed");
    const { checkpoint, retained, delta } = projectionEntries(fixture);
    const damaged = {
      type: "custom",
      id: "damaged-projection",
      parentId: checkpoint.id,
      timestamp: checkpoint.timestamp,
      customType: "openclaw.cache-ttl",
      data,
    };
    const entries = [
      fixture.source.getHeader()!,
      ...fixture.source
        .getBranch()
        .filter((entry) => entry.id !== retained.id && entry.id !== delta.id),
      damaged,
      { ...retained, parentId: damaged.id },
      delta,
    ];
    expect(replaceTranscriptEventsSync(fixture.scope, entries)).toBe(true);
    const bounded = await SessionManager.openBoundedAsync(fixture.scope, fixture.options());
    expect(branchIds(bounded)).toEqual([retained.id, delta.id]);
    expect(bounded.getEntry(damaged.id)).toBeUndefined();
    expect(bounded.getEntry(checkpoint.id)).toBeUndefined();
    expect(projection(bounded)).toEqual(checkpoint.data);
  },
);

it.each([
  ["checkpoint", "retained-anchor"],
  ["checkpoint", "prefix-scan"],
  ["reset", "retained-anchor"],
  ["reset", "prefix-scan"],
] as const)("ignores an opaque %s envelope at the %s boundary", async (kind, position) => {
  const fixture = await seedProjection(`projection-envelope-${kind}-${position}`);
  const { checkpoint, retained, delta } = projectionEntries(fixture);
  const opaque = {
    id: "opaque-envelope",
    parentId: checkpoint.id,
    timestamp: 42,
    ...(kind === "reset"
      ? { type: "reset", reason: "new" }
      : {
          type: "custom",
          customType: "openclaw.cache-ttl",
          data: {
            prunedToolResults: [],
            ambiguousToolResultBaseKeys: [],
            frozenToolResults: [],
          },
        }),
  };
  const hasDelta = position === "prefix-scan";
  expect(
    replaceTranscriptEventsSync(fixture.scope, [
      ...fixture.prefix(),
      opaque,
      { ...retained, parentId: opaque.id },
      ...(hasDelta ? [delta] : []),
    ]),
  ).toBe(true);
  const expected = hasDelta
    ? serializeCacheTtlToolResultProjections(fixture.state)
    : checkpoint.data;
  const full = await SessionManager.openAsync(fixture.scope, fixture.dir);
  expect(full.getEntry(opaque.id)).toBeUndefined();
  expect(projection(full)).toEqual(expected);

  const options = fixture.options(2);
  const bounded = await SessionManager.openBoundedAsync(fixture.scope, options);
  const detached = await SessionManager.openDetachedBoundedAsync(fixture.scope, options);
  for (const manager of [bounded, detached]) {
    expect(manager.getEntry(opaque.id)).toBeUndefined();
    expect(manager.getEntry(checkpoint.id)).toBeUndefined();
    expect(branchIds(manager)).toEqual(hasDelta ? [retained.id, delta.id] : [retained.id]);
    expect(projection(manager)).toEqual(expected);
  }
});

it("retires the prefix on a new branch, full hydration, reset, and retarget", async () => {
  const fixture = await seedProjection("projection-prefix-lifecycle");
  const limits = fixture.options();
  const bounded = await SessionManager.openBoundedAsync(fixture.scope, limits);
  const retargeted = await SessionManager.openBoundedAsync(fixture.scope, limits);
  expect(replay(bounded)).toEqual([fixture.expected]);
  await bounded.resetLeafAsync();
  expect(bounded.getToolResultProjectionEntries()).toEqual([]);

  // The old leaf is outside the loaded window, so branching hydrates complete history.
  await bounded.branchAsync(fixture.olderId);
  expect(bounded.getToolResultProjectionEntries()).toEqual(bounded.getBranch());
  expect(restore(bounded).frozen.size).toBe(0);
  await bounded.branchAsync(fixture.deltaId);
  expect(bounded.getToolResultProjectionEntries()).toEqual(bounded.getBranch());
  expect(replay(bounded).at(-1)).toEqual(fixture.expected);
  await bounded.appendResetBoundaryAsync("reset");
  expect(restore(bounded).frozen.size).toBe(0);

  const replacement = await createSessionScope("projection-replacement");
  const replacementSource = await SessionManager.openAsync(replacement.scope, replacement.dir);
  await replacementSource.appendMessageAsync(makeUserMessage("different transcript", 3));
  await retargeted.setSessionTargetAsync(replacement.scope);
  expect(retargeted.getToolResultProjectionEntries()).toEqual(retargeted.getBranch());
  expect(restore(retargeted).frozen.size).toBe(0);
  expect(replay(retargeted)).toEqual([makeUserMessage("different transcript", 3)]);
});

it("preserves a retained checkpoint through a forward label with an omitted target", async () => {
  const fixture = await seedProjection("projection-forward-label");
  const { checkpoint, retained, delta } = projectionEntries(fixture);
  const label = {
    type: "label",
    id: "forward-label",
    parentId: checkpoint.id,
    timestamp: checkpoint.timestamp,
    targetId: fixture.olderId,
    label: "older message",
    appendMode: "side",
  };
  // A rewritten side path may store descendants before their checkpoint ancestor.
  expect(
    replaceTranscriptEventsSync(fixture.scope, [
      fixture.source.getHeader(),
      ...fixture.source
        .getBranch()
        .filter(
          (entry) =>
            entry.id !== checkpoint.id && entry.id !== retained.id && entry.id !== delta.id,
        ),
      { ...retained, parentId: label.id, appendMode: "side" },
      label,
      checkpoint,
      delta,
    ]),
  ).toBe(true);
  const expected = serializeCacheTtlToolResultProjections(fixture.state);
  const full = await SessionManager.openAsync(fixture.scope, fixture.dir);
  expect(
    full
      .getBranch()
      .slice(-4)
      .map((entry) => entry.id),
  ).toEqual([checkpoint.id, label.id, retained.id, delta.id]);
  expect(projection(full)).toEqual(expected);
  expect(replay(full).at(-1)).toEqual(fixture.expected);

  const options = fixture.options(4);
  const bounded = await SessionManager.openBoundedAsync(fixture.scope, options);
  const detached = await SessionManager.openDetachedBoundedAsync(fixture.scope, options);
  expect(bounded.getEntry(fixture.olderId)).toBeUndefined();
  expect(bounded.getEntry(label.id)).toBeUndefined();
  expect(bounded.getEntry(checkpoint.id)).toBeDefined();
  for (const manager of [bounded, detached]) {
    expect(projection(manager)).toEqual(expected);
    expect(replay(manager)).toEqual([fixture.expected]);
  }
});

it.each([
  { firstType: "message", lastType: "reset" },
  { firstType: "reset", lastType: "custom" },
  { firstType: "message", lastType: "custom" },
] as const)(
  "restores legacy duplicate kinds $firstType → $lastType",
  async ({ firstType, lastType }) => {
    const { dir, scope } = await createSessionScope(
      `projection-duplicate-${firstType}-${lastType}`,
    );
    const snapshot = (key: string) => ({
      prunedToolResults: [{ key, mode: "soft" }],
      ambiguousToolResultBaseKeys: [],
      frozenToolResults: [],
    });
    const marker = "omitted-reset-details:";
    const boundary = {
      id: "boundary",
      parentId: "before",
      type: lastType,
      customType: "openclaw.cache-ttl",
      reason: "new",
      data: snapshot("tool:after:1"),
      details: marker + "x".repeat(4_096),
    };
    await seedUnindexedTranscriptForTest({
      ...scope,
      entry: { sessionId: scope.sessionId, updatedAt: 1 },
      events: [
        JSON.stringify({ type: "session", id: scope.sessionId, version: 3, cwd: dir }),
        JSON.stringify({
          type: "custom",
          id: "before",
          parentId: null,
          customType: "openclaw.cache-ttl",
          data: snapshot("tool:before:1"),
        }),
        `{"type":"${firstType}","customType":"other","message":"opaque",${JSON.stringify(boundary).slice(1)}`,
        JSON.stringify({
          type: "message",
          id: "tail",
          parentId: "boundary",
          message: makeUserMessage("after", 2),
        }),
      ].map((event_json, seq) => ({
        session_id: scope.sessionId,
        seq,
        created_at: seq,
        event_json,
      })),
    });
    const expected =
      lastType === "reset"
        ? { prunedToolResults: [], ambiguousToolResultBaseKeys: [], frozenToolResults: [] }
        : snapshot("tool:after:1");
    const full = await SessionManager.openAsync(scope, dir);
    expect(projection(full)).toEqual(expected);
    const bounded = await SessionManager.openBoundedAsync(scope, {
      cwd: dir,
      maxEvents: 1,
      maxBytes: 1_024,
    });
    expect(projection(bounded)).toEqual(expected);
    if (lastType === "reset") {
      expect(JSON.stringify(bounded.getToolResultProjectionEntries())).not.toContain(marker);
    }
  },
);
