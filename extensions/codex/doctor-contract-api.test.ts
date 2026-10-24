import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { getSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  legacyConfigRules,
  normalizeCompatibilityConfig,
  stateMigrations,
} from "./doctor-contract-api.js";
import { createDoctorContext } from "./doctor-contract-api.test-support.js";
import {
  bindingStoreKey,
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
  createStoredCodexAppServerBinding,
  hashCodexAppServerBindingFingerprint,
  type StoredCodexAppServerBinding,
} from "./src/app-server/session-binding.js";
import { legacyCodexConversationBindingId } from "./src/conversation-binding-data.js";

function openBindingStore<T = StoredCodexAppServerBinding>(env: NodeJS.ProcessEnv) {
  return createDoctorContext(env).openPluginStateKeyedStore<T>({
    namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
    maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
}

function sessionBindingKey(sessionId: string, sessionKey: string, agentId = "main") {
  return bindingStoreKey({ kind: "session", agentId, sessionId, sessionKey });
}

function legacySession(sessionId: string, fields: Record<string, unknown> = {}) {
  return { sessionId, sessionFile: `${sessionId}.jsonl`, ...fields };
}

const fixtureDirs: string[] = [];
const migrated = {
  changes: [
    "Migrated 1 Codex app-server binding sidecar(s) to plugin state and archived the legacy sources",
  ],
  warnings: [],
};
const unchanged = { changes: [], warnings: [] };
const readJson = async (file: string): Promise<Record<string, unknown>> =>
  JSON.parse(await fs.readFile(file, "utf8"));
const writeJson = (file: string, value: unknown) =>
  fs.writeFile(file, JSON.stringify(value), "utf8");

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-doctor-"));
  fixtureDirs.push(dir);
  return dir;
}

function doctorParams(stateDir: string) {
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  return {
    config: {},
    env,
    stateDir,
    oauthDir: path.join(stateDir, "oauth"),
    context: createDoctorContext(env),
  };
}

function malformedIndex(sessionId: string) {
  return Buffer.concat([
    Buffer.from(`{"agent:main:external":{"sessionId":"${sessionId}","lifecycleRevision":"`),
    Buffer.from([0xff]),
    Buffer.from('"}}'),
  ]);
}

function expectWarning(result: { changes: string[]; warnings: string[] }, reason: string) {
  expect(result.changes).toEqual([]);
  expect(result.warnings).toEqual([expect.stringContaining(reason)]);
}

async function expectRetained(sidecarPath: string) {
  await fs.access(sidecarPath);
  await expect(fs.access(`${sidecarPath}.migrated`)).rejects.toThrow();
}

async function expectArchived(sidecarPath: string) {
  await expect(fs.access(sidecarPath)).rejects.toThrow();
  await fs.access(`${sidecarPath}.migrated`);
}

function codexConfig<T extends Record<string, unknown>>(
  config: T,
  siblings: Record<string, { enabled: boolean }> = {},
) {
  return { plugins: { entries: { ...siblings, codex: { enabled: true, config } } } };
}

async function bindingFixture(
  name: string,
  options: {
    binding?: Record<string, unknown>;
    legacySharedRoot?: boolean;
    sessionIndex?: Record<string, unknown>;
    session?: readonly [key: string, fields?: Record<string, unknown>];
    storeRoot?: "agent" | "fixed";
    threadId?: string;
  } = {},
) {
  const params = doctorParams(await tempDir());
  const { env, stateDir } = params;
  const sessionsDir =
    options.storeRoot === "fixed"
      ? path.join(stateDir, "fixed-sessions")
      : options.legacySharedRoot
        ? path.join(stateDir, "sessions")
        : path.join(stateDir, "agents", "main", "sessions");
  const storePath = path.join(sessionsDir, "sessions.json");
  const transcriptPath = path.join(sessionsDir, `${name}.jsonl`);
  const sidecarPath = `${transcriptPath}.codex-app-server.json`;
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(transcriptPath, `${JSON.stringify({ type: "session", id: name })}\n`, "utf8");
  const sessionIndex = options.session
    ? { [options.session[0]]: legacySession(name, options.session[1]) }
    : options.sessionIndex;
  if (sessionIndex !== undefined) {
    await writeJson(storePath, sessionIndex);
  }
  await writeJson(sidecarPath, {
    schemaVersion: 2,
    threadId: options.threadId ?? `thread-${name}`,
    sessionFile: transcriptPath,
    updatedAt: "2026-01-01T00:00:00.000Z",
    pluginAppPolicyContext: {
      fingerprint: "policy-1",
      apps: {},
      pluginAppIds: {},
    },
    ...options.binding,
  });
  const migration = stateMigrations[0];
  assert(migration, "missing Codex binding migration");
  return {
    env,
    migration,
    params,
    migrate: (overrides: Partial<Parameters<typeof migration.migrateLegacyState>[0]> = {}) =>
      migration.migrateLegacyState({ ...params, ...overrides }),
    sessionsDir,
    sidecarPath,
    stateDir,
    storePath,
    transcriptPath,
    conversationKey: bindingStoreKey({
      kind: "conversation",
      bindingId: legacyCodexConversationBindingId(transcriptPath),
    }),
    readBinding: async () => {
      const binding = await createStoredCodexAppServerBinding(await readJson(sidecarPath));
      assert(binding, "missing imported Codex binding");
      return binding;
    },
    readSession: (sessionKey: string, agentId = "main", from = storePath) =>
      getSessionEntry({ agentId, env, sessionKey, storePath: from }),
  };
}

type BindingFixture = Awaited<ReturnType<typeof bindingFixture>>;

async function expectUnimported(fixture: BindingFixture, sidecar = fixture.sidecarPath) {
  await expectRetained(sidecar);
  await expect(openBindingStore(fixture.env).entries()).resolves.toEqual([]);
}

async function expectPreservedInput(
  fixture: BindingFixture,
  file: string,
  contents: string | Buffer,
  sidecar = fixture.sidecarPath,
) {
  expect(await fs.readFile(file)).toEqual(
    typeof contents === "string" ? Buffer.from(contents) : contents,
  );
  await expectUnimported(fixture, sidecar);
}

async function externalIndex(fixture: BindingFixture, contents: string | Buffer) {
  const dir = await tempDir();
  const file = path.join(dir, "sessions.json");
  await fs.writeFile(file, contents);
  return { dir, file, params: { ...fixture.params, config: { session: { store: file } } } };
}

afterEach(async () => {
  // Agent leases depend on shared state. Close in this order before removing Windows fixtures.
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawAgentDatabasesForTest();
  resetPluginStateStoreForTests();
  for (const stateDir of fixtureDirs.splice(0)) {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

describe("codex doctor contract", () => {
  const appServer = { requestTimeoutMs: 120_000, mode: "guardian", headers: { "X-Test": "kept" } };
  const policy = (allow_destructive_actions: string | boolean) => ({
    enabled: true,
    allow_destructive_actions,
  });
  const pluginPolicies = (value: string) => ({
    ...policy(value),
    plugins: { "google-calendar": policy(value), slack: policy(false) },
  });

  it.each([
    {
      name: "turn idle settings",
      input: {
        codexDynamicToolsLoading: "direct",
        appServer: { ...appServer, turnCompletionIdleTimeoutMs: 123_456 },
      },
      output: { codexDynamicToolsLoading: "direct", appServer },
      changes: [
        "Removed retired plugins.entries.codex.config.appServer.turnCompletionIdleTimeoutMs; native Codex owns provider liveness and turn completion. agents.defaults.timeoutSeconds was not changed.",
      ],
    },
    {
      name: "destructive plugin policy",
      input: {
        codexDynamicToolsProfile: "openclaw-compat",
        codexPlugins: pluginPolicies("on-request"),
      },
      output: { codexPlugins: pluginPolicies("auto") },
      changes: [
        "Removed retired plugins.entries.codex.config.codexDynamicToolsProfile; Codex app-server always keeps Codex-native workspace tools native.",
        'Renamed plugins.entries.codex.config.codexPlugins allow_destructive_actions="on-request" values to "auto".',
      ],
    },
    {
      name: "untrusted approval policy",
      input: { appServer: { approvalPolicy: "untrusted", sandbox: "workspace-write" } },
      output: { appServer: { approvalPolicy: "on-request", sandbox: "workspace-write" } },
      changes: [
        'Renamed retired plugins.entries.codex.config.appServer.approvalPolicy to "on-request".',
      ],
    },
  ])(
    "repairs $name without mutating input, siblings or the run budget",
    ({ name, input, output, changes }) => {
      const wrap = (config: Record<string, unknown>) => ({
        ...codexConfig(config, { unrelated: { enabled: false } }),
        agents: { defaults: { timeoutSeconds: 42 } },
      });
      const original = wrap(input);
      const before = structuredClone(original);
      const result = normalizeCompatibilityConfig({ cfg: original });
      expect(result).toEqual({ config: wrap(output), changes });
      expect(original).toEqual(before);
      expect(normalizeCompatibilityConfig({ cfg: result.config })).toEqual({
        config: result.config,
        changes: [],
      });
      if (name === "turn idle settings") {
        const rule = legacyConfigRules.find((candidate) => candidate.match(input.appServer));
        expect(rule?.path).toEqual(["plugins", "entries", "codex", "config", "appServer"]);
        expect(rule?.message).toContain("openclaw doctor --fix");
        expect(rule?.match(output.appServer)).toBe(false);
      }
    },
  );

  it.each(["fixed-store-owner", "system-agent-owner"])(
    "migrates %s to its configured session owner",
    async (name) => {
      const fixed = name === "fixed-store-owner";
      const owner = fixed ? "ops" : "main";
      const sessionKey = fixed ? "legacy-fixed-store" : "legacy";
      const fixture = await bindingFixture(name, {
        session: [sessionKey, { updatedAt: 1 }],
        storeRoot: fixed ? "fixed" : "agent",
        legacySharedRoot: !fixed,
      });
      const result = await fixture.migrate({
        config: {
          ...(fixed ? { session: { store: fixture.storePath } } : {}),
          agents: {
            ownership: "explicit",
            defaults: {
              systemAgent: { agentId: "main" },
              ...(fixed ? { sessionStore: { agentId: "ops" } } : {}),
            },
            entries: Object.fromEntries(
              (fixed ? ["main", "ops"] : ["main", "blocker", "digest"]).map((id) => [id, {}]),
            ),
          },
        },
      });
      expect(result).toMatchObject(migrated);
      await expect(
        openBindingStore(fixture.env).lookup(sessionBindingKey(name, sessionKey, owner)),
      ).resolves.toMatchObject({ state: "active", sessionId: name });
      expect(fixture.readSession(sessionKey, owner)).toMatchObject({ agentHarnessId: "codex" });
      await fs.access(`${fixture.sidecarPath}.migrated`);
    },
  );

  it("imports and archives shipped binding sidecars", async () => {
    const fixture = await bindingFixture("session-current", {
      session: ["agent:main:session-1", { updatedAt: 1 }],
      threadId: "thread-1",
      binding: {
        pluginAppPolicyContext: {
          fingerprint: "policy-1",
          apps: {
            app: {
              configKey: "app",
              marketplaceName: "openai-curated",
              pluginName: "plugin",
              allowDestructiveActions: true,
              destructiveApprovalMode: "ask",
              mcpServerNames: [],
            },
          },
          pluginAppIds: {},
        },
      },
    });

    await expect(fixture.migration.detectLegacyState(fixture.params)).resolves.toMatchObject({
      preview: [expect.stringContaining("legacy sidecar")],
    });
    await expect(fixture.migrate()).resolves.toMatchObject(migrated);

    const store = openBindingStore(fixture.env);
    await expect(
      store.lookup(sessionBindingKey("session-current", "agent:main:session-1")),
    ).resolves.toMatchObject({
      state: "active",
      sessionId: "session-current",
      binding: {
        threadId: "thread-1",
        pluginAppPolicyContext: {
          apps: { app: { destructiveApprovalMode: "ask" } },
        },
      },
    });
    await expect(store.lookup(fixture.conversationKey)).resolves.toMatchObject({
      state: "active",
      binding: { threadId: "thread-1" },
    });
    await fs.access(`${fixture.sidecarPath}.migrated`);
    expect(fixture.readSession("agent:main:session-1")).toMatchObject({
      sessionId: "session-current",
      agentHarnessId: "codex",
    });
    expect(await readJson(fixture.storePath)).not.toHaveProperty(
      "agent:main:session-1.agentHarnessId",
    );
  });

  it("preserves ambiguous shared-root bindings with a missing system agent", async () => {
    const defaults = { systemAgent: { agentId: "missing" } };
    const fixture = await bindingFixture("explicit-owner", {
      legacySharedRoot: true,
      session: ["legacy", { updatedAt: 1 }],
    });
    const params = {
      ...fixture.params,
      config: {
        agents: { ownership: "explicit" as const, defaults, entries: { main: {}, ops: {} } },
      },
    };

    await expect(fixture.migration.detectLegacyState(params)).resolves.toMatchObject({
      preview: [expect.stringContaining("legacy sidecar")],
    });
    const result = await fixture.migration.migrateLegacyState(params);

    expectWarning(result, "session ownership is indeterminate");
    await expectRetained(fixture.sidecarPath);
    await expect(openBindingStore(fixture.env).entries()).resolves.toEqual([]);
  });

  it("normalizes a partial raw conversation import before copying the session row", async () => {
    const threadId = "thread-partial-import";
    const sessionId = "partial-import";
    const sessionKey = "agent:main:partial-import";
    const rawUserMcpServersFingerprint = JSON.stringify({
      mcp_servers: { legacy: { http_headers: { authorization: "Bearer legacy-secret" } } },
    });
    const rawConversation: StoredCodexAppServerBinding = {
      version: 1,
      state: "active",
      binding: {
        threadId,
        cwd: "",
        dynamicToolsFingerprint: "",
        userMcpServersFingerprint: rawUserMcpServersFingerprint,
      },
    };
    const rawFingerprint = "dynamic-marker"
      .repeat(8_000)
      .slice(0, 65_535 - Buffer.byteLength(JSON.stringify(rawConversation)));
    rawConversation.binding.dynamicToolsFingerprint = rawFingerprint;
    expect(Buffer.byteLength(JSON.stringify(rawConversation))).toBe(65_535);
    expect(Buffer.byteLength(JSON.stringify({ ...rawConversation, sessionId }))).toBeGreaterThan(
      65_536,
    );

    const fixture = await bindingFixture(sessionId, {
      session: [sessionKey],
      threadId,
      binding: {
        dynamicToolsFingerprint: rawFingerprint,
        userMcpServersFingerprint: rawUserMcpServersFingerprint,
      },
    });
    const sessionStateKey = sessionBindingKey(sessionId, sessionKey);
    const store = openBindingStore(fixture.env);
    await store.register(fixture.conversationKey, rawConversation);

    await expect(fixture.migrate()).resolves.toEqual(migrated);

    const expectedBinding = {
      dynamicToolsFingerprint: hashCodexAppServerBindingFingerprint(rawFingerprint),
      userMcpServersFingerprint: hashCodexAppServerBindingFingerprint(rawUserMcpServersFingerprint),
    };
    await expect(store.lookup(fixture.conversationKey)).resolves.toMatchObject({
      state: "active",
      binding: expectedBinding,
    });
    const stored = await store.lookup(sessionStateKey);
    expect(stored).toMatchObject({
      state: "active",
      sessionId,
      binding: expectedBinding,
    });
    expect(Buffer.byteLength(JSON.stringify(stored))).toBeLessThan(65_536);
    expect(JSON.stringify(stored)).not.toContain("dynamic-marker");
    expect(JSON.stringify(stored)).not.toContain("legacy-secret");
    await expectArchived(fixture.sidecarPath);
    await expect(fixture.migrate()).resolves.toEqual(unchanged);
  });

  it.each([false, true])(
    "deduplicates store aliases and resolves their locators (relative: %s)",
    async (relative) => {
      const sessionKey = "agent:main:aliased-store";
      const fixture = await bindingFixture("aliased-store", { session: [sessionKey] });
      const configuredDir = path.join(fixture.stateDir, "configured-sessions");
      const configuredStore = path.join(configuredDir, "sessions.json");
      await fs.mkdir(configuredDir);
      let sidecarPath = fixture.sidecarPath;
      if (relative) {
        const transcript = path.join(configuredDir, "aliased-store.jsonl");
        sidecarPath = `${transcript}.codex-app-server.json`;
        await fs.rename(fixture.transcriptPath, transcript);
        await fs.rename(fixture.sidecarPath, sidecarPath);
        await writeJson(sidecarPath, { ...(await readJson(sidecarPath)), sessionFile: transcript });
      } else {
        await writeJson(fixture.storePath, {
          [sessionKey]: legacySession("aliased-store", { sessionFile: fixture.transcriptPath }),
        });
      }
      await fs.symlink(fixture.storePath, configuredStore);
      const result = await fixture.migrate({ config: { session: { store: configuredStore } } });
      expect(result.warnings).toEqual([]);
      await fs.access(`${sidecarPath}.migrated`);
      expect(fixture.readSession(sessionKey, "main", configuredStore)).toMatchObject({
        agentHarnessId: "codex",
      });
      const configuredIndex = await readJson(configuredStore);
      if (relative) {
        expect(configuredIndex).not.toHaveProperty(`${sessionKey}.agentHarnessId`);
      } else {
        expect(configuredIndex[sessionKey]).not.toHaveProperty("agentHarnessId");
        expect((await readJson(fixture.storePath))[sessionKey]).not.toHaveProperty(
          "agentHarnessId",
        );
      }
    },
  );

  it.each([
    { label: "unleased", leaseConflict: false },
    { label: "concurrently leased", leaseConflict: true },
  ])(
    "revalidates a $label session row when its owner rebinds during migration",
    async ({ leaseConflict }) => {
      const sessionKey = "agent:main:session-1";
      const fixture = await bindingFixture("session-current", {
        session: [sessionKey, { lifecycleRevision: "rev-1" }],
        threadId: "thread-1",
      });
      const sessionStateKey = sessionBindingKey("session-current", sessionKey);
      const imported = await fixture.readBinding();
      const store = openBindingStore(fixture.env);
      const sessionRow = { ...imported, sessionId: "session-current" };
      await store.register(sessionStateKey, sessionRow);
      let rebound = false;
      let leased = false;
      const context = createDoctorContext(
        fixture.env,
        async () => {
          if (rebound) {
            return;
          }
          rebound = true;
          await upsertSessionEntry({
            agentId: "main",
            env: fixture.env,
            sessionKey,
            storePath: fixture.storePath,
            entry: {
              sessionId: "session-current",
              lifecycleRevision: "rev-2",
              updatedAt: Date.now(),
            },
          });
        },
        async (key) => {
          if (!leaseConflict || leased || key !== sessionStateKey) {
            return;
          }
          leased = true;
          await store.register(key, {
            ...sessionRow,
            lease: { token: "concurrent-owner", expiresAt: Date.now() + 60_000 },
          });
        },
      );

      const result = await fixture.migrate({ context });

      if (leaseConflict) {
        expect(result.warnings).toEqual([
          expect.stringContaining("its stale session binding could not be retired"),
        ]);
        expect(result.notices ?? []).toEqual([]);
      } else {
        expect(result.warnings).toEqual([]);
        expect(result.notices).toEqual([
          expect.stringContaining("session owner changed before Codex ownership could be recorded"),
        ]);
      }
      await expectRetained(fixture.sidecarPath);
      expect(await readJson(fixture.storePath)).not.toHaveProperty(`${sessionKey}.agentHarnessId`);
      expect(fixture.readSession(sessionKey)).toMatchObject({ lifecycleRevision: "rev-2" });
      await expect(store.lookup(sessionStateKey)).resolves.toMatchObject(
        leaseConflict
          ? { ...sessionRow, lease: { token: "concurrent-owner" } }
          : { version: 1, state: "cleared", sessionId: "session-current", retired: true },
      );
    },
  );

  it("does not resurrect a retired session generation from its legacy sidecar", async () => {
    const sessionKey = "agent:main:retired";
    const fixture = await bindingFixture("retired", {
      session: [sessionKey],
    });
    const store = openBindingStore(fixture.env);
    const active = await fixture.readBinding();
    await store.register(fixture.conversationKey, active);
    const sessionStateKey = sessionBindingKey("retired", sessionKey);
    const retired: StoredCodexAppServerBinding = {
      version: 1,
      state: "cleared",
      sessionId: "retired",
      retired: true,
    };
    await store.register(sessionStateKey, retired);

    const result = await fixture.migrate();

    expectWarning(result, `current plugin state changed at ${sessionStateKey}`);
    await fs.access(fixture.sidecarPath);
    await expect(store.lookup(sessionStateKey)).resolves.toEqual(retired);
    expect(await readJson(fixture.storePath)).not.toHaveProperty(`${sessionKey}.agentHarnessId`);
  });

  it.each([false, true])(
    "archives metadata-only zero-owner sidecars (cleared state: %s)",
    async (cleared) => {
      const fixture = await bindingFixture("orphan-cleared", {
        sessionIndex: {
          "agent:main:metadata-only": { label: "Waiting for first turn", updatedAt: 1 },
        },
      });
      const existing: StoredCodexAppServerBinding = { version: 1, state: "cleared", retired: true };
      const store = openBindingStore(fixture.env);
      if (cleared) {
        await store.register(fixture.conversationKey, existing);
      }

      await expect(fixture.migrate()).resolves.toEqual(migrated);
      await expectArchived(fixture.sidecarPath);
      if (cleared) {
        await expect(store.lookup(fixture.conversationKey)).resolves.toEqual(existing);
      }
      await expect(fixture.migration.detectLegacyState(fixture.params)).resolves.toBeNull();
      await expect(fixture.migrate()).resolves.toEqual(unchanged);
    },
  );

  it("retains a zero-owner sidecar when canonical plugin state is malformed", async () => {
    const fixture = await bindingFixture("orphan-invalid-state");
    const store = openBindingStore<unknown>(fixture.env);
    const malformed = { version: 1, state: "active" };
    await store.register(fixture.conversationKey, malformed);

    const result = await fixture.migrate();

    expectWarning(result, `current plugin state is invalid at ${fixture.conversationKey}`);
    await fs.access(fixture.sidecarPath);
    await expect(store.lookup(fixture.conversationKey)).resolves.toEqual(malformed);
  });

  it.each([
    ["stale-locator", "invalid locator"],
    ["shared", "2 matching session owners make ownership ambiguous"],
    ["foreign", "owned by agent harness pi"],
  ])("retains %s sidecars without importing plugin state", async (name, reason) => {
    const fixture = await bindingFixture(
      name,
      name === "shared"
        ? {
            sessionIndex: Object.fromEntries(
              ["codex", "pi"].map((agentHarnessId, i) => [
                `agent:main:owner-${i}`,
                legacySession(`owner-${i}`, { sessionFile: "shared.jsonl", agentHarnessId }),
              ]),
            ),
          }
        : {
            session: [
              `agent:main:${name}`,
              name === "foreign" ? { agentHarnessId: "pi" } : { sessionFile: "../outside.jsonl" },
            ],
          },
    );
    const result = await fixture.migrate();
    if (name === "foreign") {
      expect(result).toEqual({
        changes: [],
        warnings: [],
        notices: [expect.stringContaining(reason)],
      });
    } else {
      expectWarning(result, reason);
    }
    await expectUnimported(fixture);
    if (name === "stale-locator") {
      expect(fixture.readSession("agent:main:stale-locator")).toBeUndefined();
    }
  });

  it.each([
    { contents: "{", detail: "invalid JSON", label: "invalid JSON" },
    { contents: malformedIndex("unknown-owner"), detail: "UTF-8", label: "malformed UTF-8" },
    {
      contents: JSON.stringify({
        "agent:main:invalid": { sessionId: "invalid", agentHarnessId: 42 },
      }),
      detail: "invalid entries",
      label: "malformed harness metadata",
    },
    {
      contents: JSON.stringify({
        "agent:main:unsafe": { sessionId: "../unsafe", sessionFile: "unsafe.jsonl" },
      }),
      detail: "invalid entries",
      label: "unsafe session id",
    },
  ])("retains binding sidecars for an indeterminate $label index", async ({ contents, detail }) => {
    const fixture = await bindingFixture("unknown-owner");
    const { file, params } = await externalIndex(fixture, contents);
    const result = await fixture.migration.migrateLegacyState(params);
    expectWarning(result, "session index");
    expect(result.warnings[0]).toContain(detail);
    if (detail === "UTF-8") {
      expect(result.warningDisposition).toBe("recoverable");
    }
    await expectPreservedInput(fixture, file, contents);
  });

  it("retains malformed UTF-8 binding sidecars without importing replacement characters", async () => {
    const fixture = await bindingFixture("utf8-sidecar", { threadId: "corrupt-thread" });
    const source = await fs.readFile(fixture.sidecarPath);
    source[source.indexOf("corrupt-thread")] = 0xff;
    await fs.writeFile(fixture.sidecarPath, source);

    const result = await fixture.migrate();

    expectWarning(result, "UTF-8");
    expect(result.warningDisposition).toBe("recoverable");
    await expectPreservedInput(fixture, fixture.sidecarPath, source);
  });

  it("reports malformed UTF-8 external indexes when no sidecar can be discovered", async () => {
    const fixture = await bindingFixture("utf8-external-index");
    const source = malformedIndex("utf8-external-index");
    const { dir, file, params } = await externalIndex(fixture, source);
    const externalSidecar = path.join(dir, path.basename(fixture.sidecarPath));
    await fs.rename(fixture.sidecarPath, externalSidecar);
    await fs.rename(fixture.transcriptPath, path.join(dir, "utf8-external-index.jsonl"));
    const detected = await fixture.migration.detectLegacyState(params);
    const result = await fixture.migration.migrateLegacyState(params);

    expect(detected?.preview.join("\n")).toContain("UTF-8");
    expectWarning(result, "UTF-8");
    expect(result.warningDisposition).toBe("recoverable");
    await expectPreservedInput(fixture, file, source, externalSidecar);
  });

  it("does not scan above stateDir or follow escaped external store locators", async () => {
    const outerDir = await tempDir();
    const outsideDir = await tempDir();
    const stateDir = path.join(outerDir, "state");
    await fs.mkdir(stateDir, { recursive: true });
    const strayDir = path.join(outerDir, "unrelated");
    await fs.mkdir(strayDir, { recursive: true });
    const externalStore = path.join(outerDir, "sessions.json");
    await writeJson(path.join(strayDir, "foreign.jsonl.codex-app-server.json"), {
      schemaVersion: 2,
      threadId: "thread-foreign",
    });
    await writeJson(path.join(outsideDir, "foreign.jsonl.codex-app-server.json"), {
      schemaVersion: 2,
      threadId: "thread-escaped",
    });
    await fs.symlink(outsideDir, path.join(outerDir, "escaped"));
    // A missing transcript through an escaping symlink must resolve its existing ancestor.
    await writeJson(externalStore, {
      "agent:main:foreign": legacySession("foreign", { sessionFile: "escaped/foreign.jsonl" }),
    });
    const params = {
      // The store directory is exactly stateDir's parent. It stays indexed-only,
      // and its explicit locator cannot escape that directory.
      ...doctorParams(stateDir),
      config: { session: { store: externalStore } },
    };
    const migration = stateMigrations[0];
    assert(migration, "missing Codex binding migration");

    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
  });
});
