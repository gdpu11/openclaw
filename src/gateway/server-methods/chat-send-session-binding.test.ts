import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import * as dispatch from "../../auto-reply/dispatch.js";
import {
  createQueueTestRun,
  createQueueSettings,
} from "../../auto-reply/reply/queue.test-helpers.js";
import { enqueueFollowupRun } from "../../auto-reply/reply/queue/enqueue.js";
import {
  admitFollowupRunLifecycle,
  completeFollowupRunLifecycle,
} from "../../auto-reply/reply/queue/lifecycle.js";
import { getRuntimeConfig } from "../../config/config.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  commitReplySessionInitialization,
  loadReplySessionInitializationSnapshot,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { listSessionReactions } from "../../config/sessions/session-reaction-store.test-support.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.native.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { loadOrCreateProcessDeviceIdentityAsync } from "../../infra/device-identity-async.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import {
  bindSessionControllerSource,
  claimSessionControllerTask,
  releaseSessionControllerClaim,
} from "../../sessions/session-controller.mailbox.js";
import {
  getRpcSourceIdentity,
  isRpcSourceQueued,
} from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { readUserTurnPromptReactionSource } from "../../sessions/user-turn-transcript-admission.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createChatRunState } from "../server-chat-state.js";
import { handleGatewayRequest } from "../server-methods.js";
import { gatewayConnect, gatewayProfile } from "../server/client-fixtures.test-support.js";
import { resolveSessionMutationAuthorizationAsync } from "../session-sharing-authorization-async.js";
import * as chatDispatch from "./chat-send-agent-dispatch.js";
import { handleDirectExternalChatSend } from "./chat-send-external-entry.js";
import { handleChatSend } from "./chat-send-handler.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

type DispatchOptions = Parameters<typeof dispatch.dispatchInboundMessageWithProjectedDispatcher>[0];
type OwnedDispatch = Parameters<typeof chatDispatch.startChatDispatch>[0];

function inBindingState<T>(run: (scenario: T) => Promise<void>) {
  return (scenario: T) =>
    withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      await loadOrCreateProcessDeviceIdentityAsync();
      setRuntimeConfigSnapshot({});
      await run(scenario);
    });
}

function createBindingContext() {
  return {
    chatRunState: createChatRunState(),
    dedupe: new Map(),
    agentRunSeq: new Map(),
    getRuntimeConfig,
    addChatRun: vi.fn(),
    removeChatRun: vi.fn(),
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    nodeSendToSession: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set<string>(),
    logGateway: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  } as unknown as GatewayRequestContext;
}

function createBindingClient(options: {
  profileId: string;
  signal: AbortSignal;
  scopes: string[];
  dashboard: boolean;
  attested?: boolean;
  admin?: boolean;
}): GatewayClient {
  return {
    connId: "authoring-binding",
    connectionSignal: options.signal,
    ...(options.dashboard && options.attested !== false
      ? {
          internal: {
            authenticatedControlUi: true as const,
            ...(options.admin ? { controlUiAdmin: true as const } : {}),
          },
        }
      : {}),
    authenticatedUserProfile: gatewayProfile(options.profileId),
    connect: gatewayConnect(
      options.scopes,
      options.dashboard ? { platform: "web" } : { id: "cli", mode: "cli" },
    ),
  };
}

async function prepareBindingRequest(
  params: { sessionKey: string; message: string; idempotencyKey: string },
  client: GatewayClient,
  context: GatewayRequestContext,
) {
  const authorization = await resolveSessionMutationAuthorizationAsync({
    client,
    context,
    method: "chat.send",
    requestParams: params,
  });
  expect(authorization.error).toBeNull();
  return {
    params,
    client,
    context,
    respond: vi.fn(),
    req: { type: "req" as const, id: params.idempotencyKey, method: "chat.send", params },
    sessionMutationAuthorization: authorization.authorization,
    isWebchatConnect: () => false,
  };
}

function createDispatchHarness() {
  const entered = createDeferred<DispatchOptions>();
  const release = createDeferred<void>();
  const finished = createDeferred<void>();
  let owned: OwnedDispatch | undefined;
  let options: DispatchOptions | undefined;
  let releaseAuthorization: (() => void) | undefined;
  let runId: string | undefined;
  const context = createBindingContext();
  context.removeChatRun = () => {
    finished.resolve();
    return undefined;
  };
  const observe = vi.spyOn(chatDispatch, "startChatDispatch");
  const hold = vi
    .spyOn(dispatch, "dispatchInboundMessageWithProjectedDispatcher")
    .mockImplementation(async (dispatchOptions) => {
      expect(dispatchOptions.ctx.MessageSid).toBe(runId);
      entered.resolve(dispatchOptions);
      await release.promise;
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    });
  return {
    context,
    async send(
      params: Parameters<typeof prepareBindingRequest>[0],
      client: GatewayClient,
      route: "direct" | "internal" | "gateway" = "direct",
      hasCurrentClientAuthority?: () => boolean,
    ) {
      runId = params.idempotencyKey;
      const request = {
        ...(await prepareBindingRequest(params, client, context)),
        hasCurrentClientAuthority,
      };
      releaseAuthorization = request.sessionMutationAuthorization?.release;
      if (route === "gateway") {
        await handleGatewayRequest({ ...request, extraHandlers: { "chat.send": handleChatSend } });
      } else {
        await (route === "direct" ? handleDirectExternalChatSend : handleChatSend)(request);
      }
      const started = { runId: params.idempotencyKey, status: "started" };
      expect(request.respond).toHaveBeenCalledWith(
        true,
        client.connect.client.id === "openclaw-control-ui"
          ? expect.objectContaining(started)
          : started,
        undefined,
        expect.anything(),
      );
      options = await entered.promise;
      owned = observe.mock.calls.at(-1)?.[0];
      assert(owned);
      return { owned, options };
    },
    async close(queued?: ReturnType<typeof createQueueTestRun>) {
      release.resolve();
      if (queued) {
        completeFollowupRunLifecycle(queued);
        await queued.controllerInput?.settlement.promise;
      }
      await options?.replyOptions?.turnAdoptionLifecycle?.onSettled?.();
      if (owned) {
        await finished.promise;
        owned.admission.cleanupAdmittedRun();
        assert(runId);
        expect(rpcSourceTesting.has(runId)).toBe(false);
        clearAgentRunContext(runId, owned.admission.lifecycleGeneration);
      }
      releaseAuthorization?.();
      hold.mockRestore();
      observe.mockRestore();
    },
  };
}

const admissionScenarios = [
  "removed",
  "aborted",
  "released",
  "terminal",
  "rotated",
  "queued",
  "narrow-first-send",
  "dashboard",
  "dashboard-writer",
  "dashboard-credential-revoked",
  "dashboard-member-revoked",
  "dashboard-unattested",
  "dashboard-internal",
] as const;

it.each(admissionScenarios)(
  "keeps prepared-session binding with its exact admission: %s",
  inBindingState(async (scenario: (typeof admissionScenarios)[number]) => {
    const dashboard = scenario.startsWith("dashboard");
    const directDashboard = dashboard && scenario !== "dashboard-internal";
    const dashboardReadAllowed = directDashboard && scenario !== "dashboard-unattested";
    const membershipRequired = scenario === "dashboard-member-revoked";
    const createsDashboardSession = dashboardReadAllowed && !membershipRequired;
    const closure =
      scenario === "narrow-first-send"
        ? "rotated"
        : scenario === "dashboard-writer"
          ? "aborted"
          : dashboard
            ? "released"
            : scenario;
    const runId = "retained-preparation";
    const sessionKey = scenario === "dashboard" ? "agent:main:main" : "agent:main:binding";
    const scope = { agentId: "main", sessionKey };
    const profile = ensureProfileForEmail("authoring-binding@example.test");
    const owner = membershipRequired
      ? ensureProfileForEmail("authoring-owner@example.test")
      : profile;
    const initialSessionId = membershipRequired ? "member-session" : runId;
    const createdActor = { type: "human", source: "profile", id: owner.id } as const;
    if (membershipRequired) {
      await upsertSessionEntryCore(scope, {
        sessionId: initialSessionId,
        updatedAt: Date.now(),
        visibility: "suggest",
        createdActor,
      });
      addSessionMember(scope, { identityId: profile.id, addedBy: owner.id });
    }
    const connection = new AbortController();
    const hasCurrentClientAuthority = vi.fn(() => true);
    const client = createBindingClient({
      profileId: profile.id,
      signal: connection.signal,
      dashboard,
      attested: scenario !== "dashboard-unattested",
      admin: scenario !== "dashboard-writer" && !membershipRequired,
      scopes:
        scenario === "narrow-first-send"
          ? ["operator.sessions.write"]
          : scenario === "dashboard-writer" || membershipRequired
            ? ["operator.write"]
            : dashboard
              ? ["operator.admin"]
              : ["operator.read", "operator.write", "operator.admin"],
    });
    const namespaceRun = prepareSystemAgentRunAdmission({}, runId, "main", "test");
    const harness = createDispatchHarness();
    let reply: ReturnType<typeof createReplyOperation> | undefined;
    let queuedRun: ReturnType<typeof createQueueTestRun> | undefined;
    try {
      const params = {
        // Exercise the ordinary dashboard alias without an explicit agentId.
        sessionKey: scenario === "dashboard" ? "main" : sessionKey,
        message: "Keep this user turn in its session",
        idempotencyKey: runId,
      };
      const { owned, options } = await harness.send(
        params,
        client,
        scenario === "narrow-first-send" ? "gateway" : directDashboard ? "direct" : "internal",
        hasCurrentClientAuthority,
      );
      const dashboardRead = options.replyOptions?.dashboardReadAdmission;
      expect(Boolean(dashboardRead)).toBe(dashboardReadAllowed);
      expect(Boolean(readUserTurnPromptReactionSource(owned?.userTurn.recorder))).toBe(
        dashboardReadAllowed,
      );
      const prepared = options.replyOptions?.onSessionPrepared;
      const runStarted = options.replyOptions?.onAgentRunStart;
      const capability = options.replyOptions?.skillLibraryAuthoring;
      assert(prepared && runStarted && capability);
      const admittedContext = await namespaceRun.admit("embedded");
      capability.bind(admittedContext);
      const caller = createAdmittedGatewayToolCallerIdentity({
        admittedRunContext: admittedContext,
        agentId: "main",
        sessionKey,
      });
      const readLibrary = () =>
        withGatewayToolCallerIdentity(caller, () => capability.invoke({ action: "list" }));
      const { admission, userTurn } = owned;
      const original = admission.activeRunAbort.entry;
      expect(original && getRpcSourceIdentity(original).sessionId).toBe(initialSessionId);
      const preparedEntry = {
        sessionId: dashboard ? initialSessionId : "committed-session",
        updatedAt: Date.now(),
        createdActor,
        ...(membershipRequired ? { visibility: "suggest" as const } : {}),
      };
      if (createsDashboardSession) {
        const creationScope = { ...scope, storePath: owned.session.storePath };
        const snapshot = await loadReplySessionInitializationSnapshot(creationScope);
        const bindCreation = options.replyOptions?.bindSessionCreation;
        const onCreated = options.replyOptions?.onSessionCreated;
        assert(bindCreation && onCreated);
        const result = await commitReplySessionInitialization({
          ...creationScope,
          activeSessionKey: sessionKey,
          expectedRevision: snapshot.revision,
          sessionEntry: preparedEntry,
          bindCreation,
          onCreated,
        });
        expect(result.ok).toBe(true);
      } else {
        // Replacement scenarios control preparation independently of creation.
        await upsertSessionEntryCore(scope, preparedEntry);
      }
      const binding = {
        sessionKey,
        sessionId: preparedEntry.sessionId,
        storePath: owned.session.storePath,
      };
      prepared(binding);
      prepared(binding);
      prepared({ ...binding, sessionKey: "agent:main:unrelated", sessionId: "foreign" });
      if (dashboardRead) {
        expect(admission.admittedSessionId).toBe(initialSessionId);
        expect(dashboardRead.sessionId).toBe(binding.sessionId);
        await dashboardRead.prepare?.();
        dashboardRead.assertCurrent();
      }
      runStarted(runId);
      await expect(readLibrary()).resolves.toMatchObject({ profileId: profile.id });
      if (dashboardRead) {
        connection.abort();
        expect(admission.activeRunAbort.controller.signal.aborted).toBe(false);
        expect(dashboardRead.assertCurrent).not.toThrow();
        if (scenario === "dashboard-credential-revoked") {
          hasCurrentClientAuthority.mockReturnValue(false);
          expect(dashboardRead.assertCurrent).toThrow(
            "Dashboard message read admission is no longer active.",
          );
        } else if (membershipRequired) {
          removeSessionMember(scope, profile.id, undefined, binding.sessionId);
          expect(admission.activeRunAbort.controller.signal.aborted).toBe(false);
          expect(dashboardRead.assertCurrent).toThrow("session is suggest for this connection");
        }
      }

      if (closure === "queued") {
        expect(original && getRpcSourceIdentity(original).sessionId).toBe(binding.sessionId);
        expect(admission.admittedSessionId).toBe(runId);
        assert(original, "Expected accepted source");
        queuedRun = createQueueTestRun({ prompt: params.message });
        queuedRun.turnAdoptionLifecycle = options.replyOptions?.turnAdoptionLifecycle;
        bindSessionControllerSource(original.input, queuedRun);
        expect(
          enqueueFollowupRun(
            sessionKey,
            queuedRun,
            createQueueSettings(),
            "none",
            undefined,
            false,
          ),
        ).toBe(true);
        const source = rpcSourceTesting.get(runId);
        expect(source && getRpcSourceIdentity(source).sessionId).toBe(binding.sessionId);
        await userTurn.persist();
        expect(await loadTranscriptEvents({ ...scope, ...binding })).toContainEqual(
          expect.objectContaining({ message: expect.objectContaining({ role: "user" }) }),
        );
        admission.cleanupAdmittedRun();
        expect(rpcSourceTesting.has(runId)).toBe(true);
      } else if (closure === "removed") {
        admission.activeRunAbort.cleanup();
      } else if (closure === "aborted") {
        admission.activeRunAbort.controller.abort();
      } else if (closure === "released") {
        admission.gatewayWorkAdmission.release();
      } else if (closure === "terminal") {
        assert(original, "Expected accepted source");
        await claimSessionControllerTask(original.input, (claim) => {
          reply = createReplyOperation({
            mailboxClaim: claim,
            target: original.input.mailbox.owner.target,
            sessionKey,
            sessionId: binding.sessionId,
            resetTriggered: false,
            upstreamAbortSignal: admission.activeRunAbort.controller.signal,
          });
          reply.complete();
          releaseSessionControllerClaim(claim);
        });
        expect(admission.activeRunAbort.controller.signal.aborted).toBe(false);
        // The finished runtime still owns its source until the held dispatch settles.
        expect(rpcSourceTesting.get(runId)).toBe(original);
      } else {
        rotateAgentEventLifecycleGeneration();
      }
      // No await after closure: release must fence even before its promise settles.
      expect(() => prepared({ ...binding, sessionId: "late-session" })).toThrow();
      if (dashboardRead) {
        expect(dashboardRead.assertCurrent).toThrow();
      }
      expect(original && getRpcSourceIdentity(original).sessionId).toBe(binding.sessionId);
      if (closure === "queued") {
        await expect(readLibrary()).resolves.toMatchObject({ profileId: profile.id });
      } else if (closure === "released" || closure === "aborted" || closure === "rotated") {
        await expect(readLibrary()).rejects.toThrow();
      }
      if (closure !== "queued") {
        await upsertSessionEntryCore(scope, { sessionId: "late-session", updatedAt: Date.now() });
        if (membershipRequired) {
          // The pre-ACK commit survives revocation; replay cannot append to the successor.
          await expect(userTurn.persist()).resolves.toMatchObject({
            admission: { sessionId: binding.sessionId, sessionKey },
            message: { role: "user", content: "Keep this user turn in its session" },
          });
        } else if (closure === "released") {
          await expect(userTurn.persist()).rejects.toThrow("Chat input actor admission ended");
        } else {
          await userTurn.persist();
        }
        expect(
          await loadTranscriptEvents({
            ...scope,
            sessionId: "late-session",
            storePath: binding.storePath,
          }),
        ).toEqual([]);
      }
    } finally {
      namespaceRun.close();
      reply?.complete();
      await harness.close(queuedRun);
    }
  }),
);

const reactionSourceScenarios = ["allowed", "credential-revoked", "member-revoked"] as const;

it.each(reactionSourceScenarios)(
  "keeps authenticated queued prompt reactions scoped through SQLite (%s)",
  inBindingState(async (outcome: (typeof reactionSourceScenarios)[number]) => {
    const sessionKey = "agent:main:reaction-source";
    const sessionId = "reaction-source-session";
    const scope = { agentId: "main", sessionKey, sessionId };
    const profile = ensureProfileForEmail("reaction-member@example.test");
    const owner = ensureProfileForEmail("reaction-owner@example.test");
    // Membership is necessary even in the positive/credential cases: no admin or owner bypass.
    await upsertSessionEntryCore(scope, {
      sessionId,
      updatedAt: 1,
      visibility: "suggest",
      createdActor: { type: "human", source: "profile", id: owner.id },
    });
    addSessionMember(scope, { identityId: profile.id, addedBy: owner.id });
    const connection = new AbortController();
    const client = createBindingClient({
      profileId: profile.id,
      signal: connection.signal,
      dashboard: true,
      scopes: ["operator.write"],
    });
    client.connId = "reaction-source-client";
    const harness = createDispatchHarness();
    const { broadcast } = harness.context;
    const reactionEvents = () =>
      vi.mocked(broadcast).mock.calls.filter(([event]) => event === "session.reaction");
    let queuedReaction: ReturnType<typeof createQueueTestRun> | undefined;
    let probe: ReturnType<typeof sqliteWorkerOwnerProbe.admission> | undefined;
    try {
      const { owned, options } = await harness.send(
        { sessionKey, message: "Original prompt", idempotencyKey: "reaction-original-source" },
        client,
      );
      assert(options.replyOptions?.dashboardReadAdmission);
      options.replyOptions.onSessionPrepared?.({
        sessionKey,
        sessionId,
        storePath: owned.session.storePath,
      });
      const recorder = owned.userTurn.recorder;
      const source = readUserTurnPromptReactionSource(recorder);
      assert(source);
      await source.prepare?.();
      source.assertCurrent();
      queuedReaction = createQueueTestRun({ prompt: "Original prompt" });
      queuedReaction.run = {
        ...queuedReaction.run,
        ...scope,
        config: { ...getRuntimeConfig(), session: { store: owned.session.storePath } },
      };
      queuedReaction.turnAdoptionLifecycle = options.replyOptions.turnAdoptionLifecycle;
      bindSessionControllerSource(owned.admission.sourceRef.input, queuedReaction);
      expect(enqueueFollowupRun(sessionKey, queuedReaction, createQueueSettings(), "none")).toBe(
        true,
      );
      await admitFollowupRunLifecycle(queuedReaction);
      await owned.userTurn.persist();
      const messageId = recorder.getAdmissionReceipt()?.entryId;
      assert(messageId, "Consumed prompt did not commit");
      owned.admission.cleanupAdmittedRun();
      expect(isRpcSourceQueued(owned.admission.sourceRef)).toBe(true);
      // Tool minting/steering is owned by message-tool.current-prompt-reaction.test.ts.
      const reaction = source.createReaction(recorder);
      const react = () =>
        reaction({
          emoji: "👍",
          dryRun: false,
          remove: false,
          assertCurrent: source.assertCurrent,
        });
      const before = listSessionReactions(scope, { sessionId });
      // A disconnected transport is not a revoked credential.
      connection.abort();
      source.assertCurrent();
      let commitRequests = 0;
      let preparationRevoked = false;
      probe = sqliteWorkerOwnerProbe.admission(workerAdmission, (request, grant, admit) => {
        if (request.stage === "commit") {
          commitRequests++;
          if (outcome === "credential-revoked") {
            client.invalidated = true;
          }
        }
        if (request.stage === "prepare" && outcome === "member-revoked" && !preparationRevoked) {
          // Remove membership before the reaction worker takes BEGIN IMMEDIATE;
          // deleting from the same database at its commit checkpoint would deadlock.
          preparationRevoked = true;
          expect(removeSessionMember(scope, profile.id, undefined, sessionId)).not.toBeNull();
        }
        admit(request, grant);
      });
      if (outcome === "allowed") {
        expect(await react()).toMatchObject({ messageId, changed: true });
        expect(commitRequests).toBeGreaterThan(0);
        expect(listSessionReactions(scope, { sessionId })[messageId]).toEqual([
          {
            emoji: "👍",
            count: 1,
            identities: [{ id: "agent:main", label: expect.any(String) }],
          },
        ]);
      } else {
        await expect(react()).rejects.toThrow(
          outcome === "credential-revoked"
            ? "Dashboard message read admission is no longer active."
            : "session is suggest for this connection",
        );
        if (outcome === "credential-revoked") {
          expect(commitRequests).toBeGreaterThan(0);
        } else {
          expect(preparationRevoked).toBe(true);
        }
        expect(listSessionReactions(scope, { sessionId })).toEqual(before);
        expect(reactionEvents()).toEqual([]);
      }
    } finally {
      probe?.mockRestore();
      await harness.close(queuedReaction);
    }
  }),
);
