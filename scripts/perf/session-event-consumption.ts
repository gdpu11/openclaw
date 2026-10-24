import type { GatewayProtocolRequestOptions } from "@openclaw/gateway-client/browser";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { GatewayChatEvents } from "../../ui/src/api/gateway-chat-events.ts";
import {
  GatewayBrowserClient,
  type GatewayEventFrame,
  type GatewayHelloOk,
} from "../../ui/src/api/gateway.ts";
import { createSessionCapability } from "../../ui/src/lib/sessions/index.ts";
import type {
  SessionGateway,
  SessionListScope,
  SessionRowObservation,
  SessionRowTarget,
} from "../../ui/src/lib/sessions/session-types.ts";

type Request = GatewayBrowserClient["request"];
type Effect = "rosterPublication" | "rowPublication" | "rowInvalidation" | "rowApplied" | "rpc";
type EventCounts = {
  received: number;
  withObservedSynchronousEffect: number;
  withoutObservedSynchronousEffect: number;
  missingBaseline: number;
};

// The benchmark owns the connected transport. This client never starts another socket.
class ConsumptionClient extends GatewayBrowserClient {
  private readonly forward: Request;

  constructor(url: string, forward: Request) {
    super({ url });
    this.forward = forward;
  }

  override get recoveryScopeReady() {
    return true;
  }

  override request<T = unknown>(
    method: string,
    params?: unknown,
    options?: GatewayProtocolRequestOptions,
  ): Promise<T> {
    return this.forward<T>(method, params, options);
  }
}

/** Measures the real roster/row consumers without mounting a browser or a chat pane. */
export function createSessionEventConsumption(options: {
  url: string;
  request: Request;
  hello: GatewayHelloOk;
  agentId: string;
  selfUser?: SessionGateway["snapshot"]["selfUser"];
  sidebar?: SessionListScope;
  observedSessions?: readonly SessionRowTarget[];
  /** Fixture assertion: no chat pane, plugin body subscriber, or event-log consumer. */
  sidebarOnly?: boolean;
}) {
  if (options.sidebarOnly && options.observedSessions?.length) {
    throw new Error("Sidebar-only consumption cannot include selected chat row observations");
  }
  // A missing baseline is counted below; the driver rejects the run instead of reconnecting.
  const decoder = new GatewayChatEvents(() => {});
  const transport = { request: options.request };
  const eventListeners = new Set<(event: GatewayEventFrame) => void>();
  const events = new Map<string, EventCounts>();
  const requests = new Map<string, number>();
  const effects = new Map<Effect, number>();
  const rows: SessionRowObservation[] = [];
  let startedAt = performance.now();
  let activeEvent: { effect: boolean } | undefined;
  let disposed = false;
  let ready = false;
  let asynchronousEffects = 0;
  let failedRequests = 0;
  let pendingRequests = 0;
  let pendingRequestsAtReset = 0;
  let unusedMessageBodies = 0;
  let unusedMessageBodyBytes = 0;
  const recordEffect = (effect: Effect) => {
    effects.set(effect, (effects.get(effect) ?? 0) + 1);
    if (activeEvent) {
      activeEvent.effect = true;
    } else {
      asynchronousEffects += 1;
    }
  };
  const client = new ConsumptionClient(
    options.url,
    async <T>(method: string, params?: unknown, requestOptions?: GatewayProtocolRequestOptions) => {
      if (disposed) {
        throw new Error("Session consumer is disposed");
      }
      requests.set(method, (requests.get(method) ?? 0) + 1);
      recordEffect("rpc");
      pendingRequests += 1;
      try {
        return await decoder.request<T>(transport, method, params, requestOptions);
      } catch (error) {
        failedRequests += 1;
        throw error;
      } finally {
        pendingRequests -= 1;
      }
    },
  );
  const gateway: SessionGateway = {
    connection: { gatewayUrl: options.url },
    snapshot: {
      client,
      phase: "connected",
      hello: options.hello,
      assistantAgentId: options.agentId,
      selfUser: options.selfUser,
    },
    subscribe: () => () => {},
    subscribeEvents(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  };
  const sessions = createSessionCapability(gateway, {
    state: { selectedId: options.agentId },
    subscribe: () => () => {},
  });
  let previousRoster = sessions.state.result;
  const stopRoster = sessions.subscribe((state) => {
    if (state.result !== previousRoster) {
      previousRoster = state.result;
      recordEffect("rosterPublication");
    }
  });
  const initialization = (async () => {
    const subscribed = await client.request<{ subscribed?: boolean }>("sessions.subscribe", {});
    if (subscribed.subscribed !== true) {
      throw new Error("Session consumer broad subscription was not acknowledged");
    }
    await sessions.refresh({
      agentId: options.agentId,
      source: "sidebar",
      rowMode: "sidebar",
      includeDerivedTitles: true,
      includeLastMessage: true,
      ...options.sidebar,
    });
    if (disposed || !sessions.canonicalListReady || sessions.canonicalListError) {
      throw new Error(sessions.canonicalListError ?? "Session consumer roster did not initialize");
    }
    for (const target of options.observedSessions ?? []) {
      const row = sessions.observeRow(target, () => recordEffect("rowPublication"), {
        onInvalidate: () => recordEffect("rowInvalidation"),
        onEvent: (_event, result) => {
          if (result.applied) {
            recordEffect("rowApplied");
          }
        },
      });
      rows.push(row);
      const reconcile = row.captureReconcile();
      const description = await sessions.describe(target, { client });
      if (disposed) {
        throw new Error("Session consumer was disposed during initialization");
      }
      reconcile(description.session ?? undefined);
    }
    ready = true;
  })();

  return {
    ready: initialization,
    receive(event: GatewayEventFrame) {
      if (disposed) {
        return;
      }
      let counts = events.get(event.event);
      if (!counts) {
        counts = {
          received: 0,
          withObservedSynchronousEffect: 0,
          withoutObservedSynchronousEffect: 0,
          missingBaseline: 0,
        };
        events.set(event.event, counts);
      }
      counts.received += 1;
      let decoded = false;
      const current = { effect: false };
      activeEvent = current;
      try {
        decoder.dispatch(event, (projected) => {
          decoded = true;
          const message =
            options.sidebarOnly && projected.event === "session.message"
              ? asNullableRecord(projected.payload)?.message
              : undefined;
          if (message != null) {
            const body = JSON.stringify(message);
            if (body !== undefined) {
              unusedMessageBodies += 1;
              unusedMessageBodyBytes += Buffer.byteLength(body, "utf8");
            }
          }
          for (const listener of eventListeners) {
            listener(projected);
          }
        });
      } finally {
        activeEvent = undefined;
        if (!decoded) {
          counts.missingBaseline += 1;
        } else if (current.effect) {
          counts.withObservedSynchronousEffect += 1;
        } else {
          counts.withoutObservedSynchronousEffect += 1;
        }
      }
    },
    reset() {
      if (!ready) {
        throw new Error("Wait for session consumer initialization before reset");
      }
      pendingRequestsAtReset = pendingRequests;
      events.clear();
      requests.clear();
      effects.clear();
      asynchronousEffects = failedRequests = 0;
      unusedMessageBodies = unusedMessageBodyBytes = 0;
      startedAt = performance.now();
    },
    snapshot() {
      const elapsedMs = performance.now() - startedAt;
      return {
        elapsedMs,
        ready,
        pendingRequests,
        pendingRequestsAtReset,
        failedRequests,
        sidebarOnly: options.sidebarOnly === true,
        unusedMessageBodies,
        unusedMessageBodyBytes,
        unusedMessageBodiesPerSecond: (unusedMessageBodies * 1_000) / elapsedMs,
        unusedMessageBodyBytesPerSecond: (unusedMessageBodyBytes * 1_000) / elapsedMs,
        events: Object.fromEntries(
          [...events].map(([event, counts]) => [
            event,
            {
              ...counts,
              receivedPerSecond: (counts.received * 1_000) / elapsedMs,
              withoutObservedSynchronousEffectPerSecond:
                (counts.withoutObservedSynchronousEffect * 1_000) / elapsedMs,
            },
          ]),
        ),
        requests: Object.fromEntries(requests),
        effects: Object.fromEntries(effects),
        asynchronousEffects,
        limitations: [
          "No observed synchronous effect is not proof of an ignored frame: row baselines and private deferred invalidations can still change.",
          "Observes the production session capability and selected-row observers; chat transcript/outbox reducers, narration, app shell, plugins, event log, and rendering are absent.",
          "Delayed refresh RPCs/publications are counted but not attributed to an individual event; pending timers and the reported pendingRequestsAtReset can cross reset boundaries.",
          "The driver owns exact chat subscriptions, reconnects, and transport shutdown; create one consumer per connection generation.",
          "Unused bodies are counted only with the explicit sidebarOnly fixture assertion. They are message JSON UTF-8 value bytes, excluding envelope framing and compression; their row/ancestor envelopes remain consumed.",
        ],
      };
    },
    dispose() {
      disposed = true;
      stopRoster();
      rows.forEach((row) => row.dispose());
      sessions.dispose();
      decoder.clear();
      client.stop();
    },
  };
}
