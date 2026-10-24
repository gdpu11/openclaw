import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { installSessionPlacementAdmissionProvider } from "../../agents/session-placement-admission.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SpawnResult } from "../../process/exec.js";
import { waitForSessionRunEnd } from "../../sessions/session-controller.native-runtime.js";
import { result as processResult } from "./bootstrap.test-support.js";
import { placementTurnOwner } from "./placement-record.js";
import { completeWorkerWorkspaceTeardown } from "./placement-teardown.js";
import type { WorkerTurnTunnelHandle } from "./tunnel-contract.js";
import { createWorkerGatewayTools } from "./worker-session-tool-executor.js";
import {
  completeTurn,
  createLauncher,
  environmentForTunnel,
  expectUncalled,
  installLauncherTest,
  executeTurn,
  localResult,
  runIdentity,
} from "./worker-turn-launcher-flow.test-support.js";
import {
  createWorkerTurnTunnel,
  reconcileUnchangedLocalWorkspace,
  ENVIRONMENT_ID,
  MANIFEST_REF,
  OWNER_EPOCH,
  SESSION_ID,
  attachedEnvironment,
  database,
  dispatchInitialWorkerPlacement,
  credential,
  placements,
  seedActivePlacement,
  sessionTarget,
  turn,
  withWorkerCompactionAdoption,
} from "./worker-turn-launcher.test-support.js";

function activePlacement() {
  const placement = placements.get(SESSION_ID);
  if (placement?.state !== "active") {
    throw new Error("expected active placement");
  }
  return placement;
}

function workerTarget() {
  const placement = activePlacement();
  return {
    sessionId: placement.sessionId,
    environmentId: placement.environmentId,
    ownerEpoch: placement.activeOwnerEpoch,
    expectedGeneration: placement.generation,
  };
}

async function rejectSuccessor(adopt: (sessionId: string) => Promise<unknown>) {
  const before = placements.get(SESSION_ID);
  const entryBefore = loadSessionEntry(sessionTarget);
  const successorId = "session-unsupported-successor";
  await expect(adopt(successorId), before?.state).rejects.toThrow(
    /worker placement.*same session ID/u,
  );
  expect(placements.get(SESSION_ID)).toEqual(before);
  expect(loadSessionEntry(sessionTarget)).toEqual(entryBefore);
  expect(await placements.getAsync(successorId)).toBeUndefined();
}

function launchWorker(
  launchTurn: WorkerTurnTunnelHandle["launchTurn"],
  overrides: Partial<Parameters<typeof environmentForTunnel>[0]> = {},
) {
  const environments = environmentForTunnel({
    startTunnel: vi.fn(async () =>
      createWorkerTurnTunnel({
        launchTurn,
        reconcileWorkspace: vi.fn(reconcileUnchangedLocalWorkspace),
      }),
    ),
    ...overrides,
  });
  return { environments, provider: createLauncher({ environments }) };
}

async function claimActiveTurn(
  prefix: string,
  mode: "worker-turn" | "remote-exec" = "worker-turn",
) {
  await seedActivePlacement(mode);
  const active = activePlacement();
  const claim = await placements.claimTurn({
    ...runIdentity(`${prefix}-run`),
    claimId: `${prefix}-claim`,
    owner: placementTurnOwner(active),
  });
  return { active, claim };
}

describe("worker turn launcher claim admission", () => {
  installLauncherTest();

  it.each(["worker-turn", "remote-exec"] as const)(
    "rejects compaction successors throughout the %s placement lifecycle without changing ownership",
    async (executionMode) => {
      const provider = createLauncher();
      const successorGate = vi.spyOn(provider, "assertCompactionSuccessorAllowed");
      const uninstall = installSessionPlacementAdmissionProvider(provider);
      try {
        await withWorkerCompactionAdoption("run-placement-compaction", async (adopt) => {
          const assertRejected = () => rejectSuccessor(adopt);
          const localClaim = await placements.claimTurn({
            ...sessionTarget,
            claimId: "local-before-dispatch",
            runId: "run-placement-compaction",
            owner: { kind: "local" },
          });
          const placement = await dispatchInitialWorkerPlacement({
            database,
            placements,
            identity: { ...sessionTarget, executionMode },
            workspace: "/worker/workspace",
            onTransition: async (current) => {
              if (current.state === "requested") {
                await expect(adopt(SESSION_ID)).resolves.toBeUndefined();
                expect(successorGate).not.toHaveBeenCalled();
              }
              await assertRejected();
              if (current.state === "requested") {
                expect(placements.validateTurnClaim(localClaim)).toBe(true);
                await placements.releaseTurn(localClaim);
              }
            },
          });
          const workerClaim = await placements.claimTurn({
            ...sessionTarget,
            claimId: "active-worker-compaction",
            runId: "run-placement-compaction",
            owner: placementTurnOwner(placement),
          });
          await assertRejected();
          const draining = await placements.startDrain({
            sessionId: SESSION_ID,
            environmentId: ENVIRONMENT_ID,
            ownerEpoch: OWNER_EPOCH,
            expectedGeneration: placement.generation,
          });
          await assertRejected();
          expect(placements.validateTurnClaim(workerClaim)).toBe(true);
          await placements.releaseTurn(workerClaim);
          const reconciling = await placements.startReconcile({
            sessionId: SESSION_ID,
            environmentId: ENVIRONMENT_ID,
            ownerEpoch: OWNER_EPOCH,
            expectedGeneration: draining.generation,
          });
          await assertRejected();
          await placements.transition({
            sessionId: SESSION_ID,
            from: "reconciling",
            to: "reclaimed",
            expectedGeneration: reconciling.generation,
          });
          await assertRejected();
          await placements.startDispatch({ ...sessionTarget, executionMode });
          await placements.fail({
            sessionId: SESSION_ID,
            recoveryError: "fixture dispatch failed",
          });
          await assertRejected();
        });
      } finally {
        uninstall();
      }
    },
  );

  it.each(["worker-turn", "remote-exec"] as const)(
    "holds a %s replacement across pending-result admission and reconciliation",
    async (mode) => {
      const { claim: priorClaim } = await claimActiveTurn("prior-result", mode);
      if (mode === "remote-exec") {
        const claimTurn = placements.claimTurn.bind(placements);
        vi.spyOn(placements, "claimTurn").mockImplementationOnce(async (...args) => {
          try {
            return await claimTurn(...args);
          } catch (error) {
            await placements.markWorkspaceResultPending(priorClaim);
            throw error;
          }
        });
      } else {
        await placements.markWorkspaceResultPending(priorClaim);
      }
      const waitForRelease = vi.spyOn(placements, "waitForTurnClaimRelease");
      const provider = createLauncher();

      if (mode === "worker-turn") {
        await expect(executeTurn(provider, priorClaim.runId)).rejects.toThrow(
          "already has an active turn claim",
        );
        expect(waitForRelease).not.toHaveBeenCalled();
      }

      const replacement = executeTurn(provider, "next-run");
      void replacement.catch(() => undefined);
      await vi.waitFor(() => expect(waitForRelease).toHaveBeenCalledOnce());
      expect(placements.get(SESSION_ID)?.turnClaim?.runId).toBe(priorClaim.runId);

      await placements.updateWorkspaceBaseManifest({
        claim: priorClaim,
        manifestRef: MANIFEST_REF,
      });
      await placements.acceptWorkspaceResult(priorClaim);
      await placements.completeWorkspaceResultAndReleaseTurn(priorClaim);
      await expect(replacement).rejects.toThrow(
        `Active ${mode === "worker-turn" ? "worker" : "remote-exec"} placement does not match its attached environment`,
      );
    },
  );

  it("returns a recovery outcome for restart-cleared claim retry", async () => {
    const { claim: priorClaim } = await claimActiveTurn("restart-result", "remote-exec");
    await placements.markWorkspaceResultPending(priorClaim);
    await placements.recordStagedWorkspaceResult(
      priorClaim,
      "refs/openclaw/worker-results/missing",
    );
    await placements.clearLocalTurnClaimsAfterRestartAsync();
    const pending = await placements.listPendingWorkspaceResultsAsync();
    expect(pending).toMatchObject([
      { stagedResultRef: "refs/openclaw/worker-results/missing", workspaceAcceptedAtMs: null },
    ]);
    expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();

    const runLocal = vi.fn(localResult);
    const provider = createLauncher();
    await expect(executeTurn(provider, priorClaim.runId, runLocal)).rejects.toThrow(
      "Wait for workspace recovery to finish before retrying",
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(runLocal).not.toHaveBeenCalled();
    expect(await placements.listPendingWorkspaceResultsAsync()).toEqual(pending);
    expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
  });

  it("redispatches the admitted replacement after pending-result recovery reclaims it", async () => {
    const { active, claim: priorClaim } = await claimActiveTurn("reclaimed-result");
    await placements.markWorkspaceResultPending(priorClaim);
    await placements.startWorkspaceResultDrain(priorClaim);
    vi.spyOn(placements, "waitForTurnClaimRelease").mockImplementationOnce(async () => {
      await placements.updateWorkspaceBaseManifest({
        claim: priorClaim,
        manifestRef: MANIFEST_REF,
      });
      await placements.acceptWorkspaceResult(priorClaim);
      await completeWorkerWorkspaceTeardown({
        placements,
        turnClaim: priorClaim,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      });
    });
    const redispatchPlacement = vi.fn(async () => {
      throw new Error("redispatch reached");
    });
    const provider = createLauncher({ redispatchPlacement });

    await expect(executeTurn(provider, "next-after-reclaim")).rejects.toThrow("redispatch reached");
    expect(redispatchPlacement).toHaveBeenCalledOnce();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "reclaimed", turnClaim: null });
  });

  it("waits for an exact cancelled worker turn and preserves its placement for the next run", async () => {
    await seedActivePlacement();
    const cancelled = new AbortController();
    const cancellationStarted = createDeferred();
    const transportCancelled = createDeferred();
    const finishCancellation = createDeferred();
    let launchCount = 0;
    const stopTunnel = vi.fn(async () => {});
    const destroy = vi.fn(async () => attachedEnvironment());
    const launchTurn = vi.fn<WorkerTurnTunnelHandle["launchTurn"]>(async (request) => {
      request.onDispatchReady?.();
      launchCount += 1;
      if (launchCount === 1) {
        request.signal?.addEventListener("abort", () => transportCancelled.resolve(), {
          once: true,
        });
        cancellationStarted.resolve();
        await finishCancellation.promise;
        return processResult({ code: 1, killed: true });
      }
      return completeTurn(request, "Recovered after cancellation", 41);
    });
    const { provider } = launchWorker(launchTurn, {
      acquireTurnCredential: vi.fn(async () => credential(String(launchCount + 1).repeat(43))),
      stopTunnel,
      destroy,
    });
    const firstRunId = "run-cancelled-worker";
    const first = provider.executeTurn(
      runIdentity(firstRunId),
      { ...turn(firstRunId), abortSignal: cancelled.signal },
      localResult,
    );
    void first.catch(() => undefined);
    let replacement: Promise<unknown> | undefined;

    try {
      await cancellationStarted.promise;
      // The session controller queues a follow-up while the current producer owns custody.
      replacement = executeTurn(provider, "run-after-cancellation");
      cancelled.abort(new Error("operator stopped the previous turn"));
      await transportCancelled.promise;
      let replacementSettled = false;
      const settled = () => {
        replacementSettled = true;
      };
      void replacement.then(settled, settled);
      expect(replacementSettled).toBe(false);
      expect(placements.get(SESSION_ID)?.turnClaim?.runId).toBe(firstRunId);
      expect(launchTurn).toHaveBeenCalledOnce();

      finishCancellation.resolve();
      await expect(first).rejects.toThrow("Cloud worker process failed before completing the turn");
      await expect(replacement).resolves.toMatchObject({
        payloads: [{ text: "Recovered after cancellation" }],
      });
      expect(launchTurn).toHaveBeenCalledTimes(2);
      const turnIds = launchTurn.mock.calls.map(([request]) => request.plan.assignment.turnId);
      expect(new Set(turnIds).size).toBe(2);
      await waitForSessionRunEnd(SESSION_ID, null);
      expectUncalled(stopTunnel, destroy);
      expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
    } finally {
      finishCancellation.resolve();
      await Promise.allSettled([first, replacement].filter((operation) => operation !== undefined));
    }
  });

  it.each([
    { label: "without node portal support", portalAvailable: false },
    { label: "with negotiated node portal support", portalAvailable: true },
  ])("launches one worker loop $label", async ({ portalAvailable }) => {
    await seedActivePlacement();
    const unexpectedToolCall = () => {
      throw new Error("Unexpected Gateway tool invocation while preparing the turn");
    };
    const commandStarted = createDeferred();
    const commandFinished = createDeferred<SpawnResult>();
    const launchTurn = vi.fn<WorkerTurnTunnelHandle["launchTurn"]>((request) => {
      request.onDispatchReady?.();
      commandStarted.resolve();
      return commandFinished.promise;
    });
    const { environments, provider } = launchWorker(launchTurn, {
      get: vi.fn(() => ({
        ...attachedEnvironment(),
        nodeDeviceId: "cloud-node-1",
        sshEndpoint: null,
      })),
      supportsNodePortal: vi.fn(async () => portalAvailable),
      createGatewayTools: async (params) =>
        createWorkerGatewayTools({
          ...params,
          placements,
          environments,
          resolveGatewayContext: unexpectedToolCall,
          dispatchChild: unexpectedToolCall,
          waitForInitialPlacement: unexpectedToolCall,
          portals: {
            getService: unexpectedToolCall,
            carrier: { open: unexpectedToolCall },
            onChanged: unexpectedToolCall,
          },
        }),
    });
    const claim = runIdentity("run-overlap");
    const uninstall = installSessionPlacementAdmissionProvider(provider);
    try {
      await withWorkerCompactionAdoption("run-overlap", async (adopt, workerTurn) => {
        const controller = new AbortController();
        const queuedController = new AbortController();
        const queuedTurn = turn("run-overlap");
        const runLocal = vi.fn(localResult);
        const first = provider.executeTurn(
          claim,
          { ...workerTurn, abortSignal: controller.signal },
          runLocal,
        );
        void first.catch(() => undefined);
        try {
          await Promise.race([commandStarted.promise, first]);
          const launchRequest = launchTurn.mock.calls[0]?.[0];
          if (!launchRequest) {
            throw new Error("expected worker launch request");
          }
          await rejectSuccessor(adopt);
          expect(placements.validateTurnClaim(launchRequest.turnClaim)).toBe(true);
          expect(launchRequest.signal?.aborted).toBe(false);
          expect(runLocal).not.toHaveBeenCalled();
          const queued = provider.executeTurn(
            claim,
            { ...queuedTurn, abortSignal: queuedController.signal },
            runLocal,
          );
          void queued.catch(() => undefined);
          // A second caller waits in the session mailbox; cancelling that caller
          // must not cancel or replace the already dispatched worker's exact claim.
          queuedController.abort(new Error("Queued duplicate cancelled"));
          await expect(queued).rejects.toThrow("Queued duplicate cancelled");
          expect(launchTurn).toHaveBeenCalledOnce();
          expect(launchRequest.signal?.aborted).toBe(false);
          expect(placements.validateTurnClaim(launchRequest.turnClaim)).toBe(true);

          const completed = await completeTurn(launchRequest, "Only worker reply", 31);
          expect(launchRequest.plan.assignment).toMatchObject({
            workspaceDir: "/worker/workspace",
            permissionMode: "workspace",
            workerContainmentRoot: "/worker/workspace",
          });
          expect(placements.isWorkerTurnToolAuthorized(launchRequest.turnClaim, "portal")).toBe(
            portalAvailable,
          );
          expect(environments.supportsNodePortal).toHaveBeenCalledWith(ENVIRONMENT_ID, OWNER_EPOCH);
          await expect(placements.startDrain(workerTarget())).rejects.toThrow(
            "pending cloud workspace result",
          );
          commandFinished.resolve(completed);
          await expect(first).resolves.toMatchObject({
            payloads: [{ text: "Only worker reply" }],
          });
          await waitForSessionRunEnd(SESSION_ID, null);
          await placements.startDrain(workerTarget());
          expect(placements.get(SESSION_ID)).toMatchObject({
            state: "draining",
            turnClaim: null,
          });
        } finally {
          controller.abort();
          queuedController.abort();
          queuedTurn.preparedRunAdmission.close();
          commandFinished.resolve(
            processResult({
              stderr: "fixture closed",
              code: 1,
            }),
          );
          await Promise.allSettled([first]);
        }
      });
    } finally {
      uninstall();
    }
  });
});
