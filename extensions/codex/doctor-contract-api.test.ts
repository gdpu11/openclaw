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
import { afterEach, expect, it } from "vitest";
import { normalizeCompatibilityConfig, stateMigrations } from "./doctor-contract-api.js";
import { createDoctorContext } from "./doctor-contract-api.test-support.js";
import {
  bindingStoreKey,
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
  createStoredCodexAppServerBinding,
  hashCodexAppServerBindingFingerprint as hashFingerprint,
  type StoredCodexAppServerBinding,
} from "./src/app-server/session-binding.js";
import { legacyCodexConversationBindingId } from "./src/conversation-binding-data.js";

const id = "legacy";
const key = "agent:main:legacy";
const stateKey = (owner = "main", sessionKey = key) =>
  bindingStoreKey({ kind: "session", agentId: owner, sessionId: id, sessionKey });
const dirs: string[] = [];
const unchanged = { changes: [], warnings: [] };
const readJson = async (file: string): Promise<Record<string, unknown>> =>
  JSON.parse(await fs.readFile(file, "utf8"));
const writeJson = (file: string, value: unknown) => fs.writeFile(file, JSON.stringify(value));
const session = (sessionId = id, fields: Record<string, unknown> = {}) => ({
  sessionId,
  sessionFile: `${sessionId}.jsonl`,
  ...fields,
});

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-doctor-"));
  dirs.push(dir);
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

function explicitOwners(system: string, agents: string[], store?: string) {
  return {
    ownership: "explicit" as const,
    defaults: {
      systemAgent: { agentId: system },
      ...(store ? { sessionStore: { agentId: store } } : {}),
    },
    entries: Object.fromEntries(agents.map((agent) => [agent, {}])),
  };
}

async function fixture(
  options: {
    root?: string;
    sessionKey?: string;
    fields?: Record<string, unknown>;
    index?: Record<string, unknown> | null;
    binding?: Record<string, unknown>;
  } = {},
) {
  const params = doctorParams(await tempDir());
  const dir = path.join(params.stateDir, options.root ?? "agents/main/sessions");
  const storePath = path.join(dir, "sessions.json");
  const transcript = path.join(dir, `${id}.jsonl`);
  const sidecar = `${transcript}.codex-app-server.json`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(transcript, `${JSON.stringify({ type: "session", id })}\n`);
  if (options.index !== null) {
    await writeJson(
      storePath,
      options.index ?? { [options.sessionKey ?? key]: session(id, options.fields) },
    );
  }
  await writeJson(sidecar, {
    schemaVersion: 2,
    threadId: "thread",
    sessionFile: transcript,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...options.binding,
  });
  const migration = stateMigrations[0];
  assert(migration, "missing Codex binding migration");
  return {
    ...params,
    params,
    storePath,
    transcript,
    sidecar,
    migration,
    conversationKey: bindingStoreKey({
      kind: "conversation",
      bindingId: legacyCodexConversationBindingId(transcript),
    }),
    migrate: (overrides: Partial<Parameters<typeof migration.migrateLegacyState>[0]> = {}) =>
      migration.migrateLegacyState({ ...params, ...overrides }),
    state: <T = StoredCodexAppServerBinding>() =>
      params.context.openPluginStateKeyedStore<T>({
        namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
        maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      }),
    readSession: (owner = "main", from = storePath, sessionKey = key) =>
      getSessionEntry({ agentId: owner, env: params.env, sessionKey, storePath: from }),
    readBinding: async () => {
      const binding = await createStoredCodexAppServerBinding(await readJson(sidecar));
      assert(binding, "missing imported Codex binding");
      return binding;
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function expectWarning(result: { changes: string[]; warnings: string[] }, reason: string) {
  expect(result).toMatchObject({ changes: [], warnings: [expect.stringContaining(reason)] });
}
async function expectRetained(sidecar: string) {
  await fs.access(sidecar);
  await expect(fs.access(`${sidecar}.migrated`)).rejects.toThrow();
}
async function expectArchived(sidecar: string) {
  await expect(fs.access(sidecar)).rejects.toThrow();
  await fs.access(`${sidecar}.migrated`);
}
async function expectUnimported(f: Fixture, sidecar = f.sidecar) {
  await expectRetained(sidecar);
  await expect(f.state().entries()).resolves.toEqual([]);
}
function malformedIndex() {
  return Buffer.concat([
    Buffer.from(`{"${key}":{"sessionId":"${id}","lifecycleRevision":"`),
    Buffer.from([0xff]),
    Buffer.from('"}}'),
  ]);
}
async function externalIndex(f: Fixture, source: string | Buffer) {
  const dir = await tempDir();
  const file = path.join(dir, "sessions.json");
  await fs.writeFile(file, source);
  return { dir, file, params: { ...f.params, config: { session: { store: file } } } };
}
async function expectPreservedInput(
  f: Fixture,
  file: string,
  source: string | Buffer,
  sidecar = f.sidecar,
) {
  expect(await fs.readFile(file)).toEqual(
    typeof source === "string" ? Buffer.from(source) : source,
  );
  await expectUnimported(f, sidecar);
}

afterEach(async () => {
  // Agent leases depend on shared state; close in this order before Windows cleanup.
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawAgentDatabasesForTest();
  resetPluginStateStoreForTests();
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

const policy = (value: string | boolean) => ({ enabled: true, allow_destructive_actions: value });
const pluginPolicies = (value: string) => ({
  ...policy(value),
  plugins: { calendar: policy(value), slack: policy(false) },
});
it.each([
  [
    "destructive plugin policy",
    {
      codexDynamicToolsProfile: "openclaw-compat",
      codexPlugins: pluginPolicies("on-request"),
    },
    { codexPlugins: pluginPolicies("auto") },
  ],
  [
    "untrusted approval policy",
    { appServer: { approvalPolicy: "untrusted", sandbox: "workspace-write" } },
    { appServer: { approvalPolicy: "on-request", sandbox: "workspace-write" } },
  ],
] satisfies Array<[string, Record<string, unknown>, Record<string, unknown>]>)(
  "repairs %s",
  (_name, input, output) => {
    const wrap = (config: Record<string, unknown>) => ({
      plugins: { entries: { codex: { enabled: true, config }, unrelated: { enabled: false } } },
      agents: { defaults: { timeoutSeconds: 42 } },
    });
    const original = wrap(input);
    const before = structuredClone(original);
    const result = normalizeCompatibilityConfig({ cfg: original });
    expect(result.config).toEqual(wrap(output));
    expect(result.changes.length).toBeGreaterThan(0);
    expect(original).toEqual(before);
    expect(normalizeCompatibilityConfig({ cfg: result.config })).toEqual({
      config: result.config,
      changes: [],
    });
  },
);

it.each([false, true])("imports configured owner (fixed: %s)", async (fixed) => {
  const owner = fixed ? "ops" : "main";
  const pluginAppPolicyContext = {
    fingerprint: "policy",
    pluginAppIds: {},
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
  };
  const f = await fixture({
    root: fixed ? "fixed-sessions" : "sessions",
    sessionKey: id,
    fields: { updatedAt: 1 },
    binding: { pluginAppPolicyContext },
  });
  const params = {
    config: {
      ...(fixed ? { session: { store: f.storePath } } : {}),
      agents: explicitOwners(
        "main",
        fixed ? ["main", "ops"] : ["main", "blocker", "digest"],
        fixed ? "ops" : undefined,
      ),
    },
  };
  expect((await f.migrate(params)).warnings).toEqual([]);
  const expected = {
    state: "active",
    binding: {
      threadId: "thread",
      pluginAppPolicyContext: { apps: { app: { destructiveApprovalMode: "ask" } } },
    },
  };
  await expect(f.state().lookup(stateKey(owner, id))).resolves.toMatchObject({
    ...expected,
    sessionId: id,
  });
  await expect(f.state().lookup(f.conversationKey)).resolves.toMatchObject(expected);
  expect(f.readSession(owner, f.storePath, id)).toMatchObject({
    sessionId: id,
    agentHarnessId: "codex",
  });
  expect(await readJson(f.storePath)).not.toHaveProperty(`${id}.agentHarnessId`);
  await expectArchived(f.sidecar);
});

it("normalizes a partial raw conversation import before copying the session row", async () => {
  const servers = JSON.stringify({
    mcp_servers: { legacy: { http_headers: { authorization: "Bearer legacy-secret" } } },
  });
  const raw: StoredCodexAppServerBinding = {
    version: 1,
    state: "active",
    binding: {
      threadId: "thread",
      cwd: "",
      dynamicToolsFingerprint: "",
      userMcpServersFingerprint: servers,
    },
  };
  const tools = "dynamic-marker"
    .repeat(8_000)
    .slice(0, 65_535 - Buffer.byteLength(JSON.stringify(raw)));
  raw.binding.dynamicToolsFingerprint = tools;
  expect(Buffer.byteLength(JSON.stringify(raw))).toBe(65_535);
  expect(Buffer.byteLength(JSON.stringify({ ...raw, sessionId: id }))).toBeGreaterThan(65_536);
  const f = await fixture({
    binding: { dynamicToolsFingerprint: tools, userMcpServersFingerprint: servers },
  });
  const store = f.state();
  await store.register(f.conversationKey, raw);
  expect((await f.migrate()).warnings).toEqual([]);
  const expected = {
    state: "active",
    binding: {
      dynamicToolsFingerprint: hashFingerprint(tools),
      userMcpServersFingerprint: hashFingerprint(servers),
    },
  };
  await expect(store.lookup(f.conversationKey)).resolves.toMatchObject(expected);
  const stored = await store.lookup(stateKey());
  expect(stored).toMatchObject({ ...expected, sessionId: id });
  expect(Buffer.byteLength(JSON.stringify(stored))).toBeLessThan(65_536);
  expect(JSON.stringify(stored)).not.toContain("dynamic-marker");
  expect(JSON.stringify(stored)).not.toContain("legacy-secret");
  await expectArchived(f.sidecar);
  await expect(f.migrate()).resolves.toEqual(unchanged);
});

it.each([false, true])("migrates store alias (relative: %s)", async (relative) => {
  const f = await fixture();
  const dir = path.join(f.stateDir, "configured");
  const configured = path.join(dir, "sessions.json");
  await fs.mkdir(dir);
  let sidecar = f.sidecar;
  if (relative) {
    const transcript = path.join(dir, `${id}.jsonl`);
    sidecar = `${transcript}.codex-app-server.json`;
    await fs.rename(f.transcript, transcript);
    await fs.rename(f.sidecar, sidecar);
    await writeJson(sidecar, { ...(await readJson(sidecar)), sessionFile: transcript });
  } else {
    await writeJson(f.storePath, { [key]: session(id, { sessionFile: f.transcript }) });
  }
  await fs.symlink(f.storePath, configured);
  expect((await f.migrate({ config: { session: { store: configured } } })).warnings).toEqual([]);
  await fs.access(`${sidecar}.migrated`);
  expect(f.readSession("main", configured)).toMatchObject({ agentHarnessId: "codex" });
  expect(await readJson(configured)).not.toHaveProperty(`${key}.agentHarnessId`);
  expect((await readJson(f.storePath))[key]).not.toHaveProperty("agentHarnessId");
});

it.each([false, true])("revalidates rebound owner (leased: %s)", async (leaseConflict) => {
  const f = await fixture({ fields: { lifecycleRevision: "rev-1" } });
  const store = f.state();
  const row = { ...(await f.readBinding()), sessionId: id };
  await store.register(stateKey(), row);
  let rebound = false;
  let leased = false;
  const context = createDoctorContext(
    f.env,
    async () => {
      if (rebound) {
        return;
      }
      rebound = true;
      await upsertSessionEntry({
        agentId: "main",
        env: f.env,
        sessionKey: key,
        storePath: f.storePath,
        entry: { sessionId: id, lifecycleRevision: "rev-2", updatedAt: Date.now() },
      });
    },
    async (target) => {
      if (!leaseConflict || leased || target !== stateKey()) {
        return;
      }
      leased = true;
      await store.register(target, {
        ...row,
        lease: { token: "concurrent-owner", expiresAt: Date.now() + 60_000 },
      });
    },
  );
  const result = await f.migrate({ context });
  expect(result.warnings).toEqual(
    leaseConflict
      ? [expect.stringContaining("its stale session binding could not be retired")]
      : [],
  );
  expect(result.notices ?? []).toEqual(
    leaseConflict
      ? []
      : [expect.stringContaining("session owner changed before Codex ownership could be recorded")],
  );
  await expectRetained(f.sidecar);
  expect(await readJson(f.storePath)).not.toHaveProperty(`${key}.agentHarnessId`);
  expect(f.readSession()).toMatchObject({ lifecycleRevision: "rev-2" });
  await expect(store.lookup(stateKey())).resolves.toMatchObject(
    leaseConflict
      ? { ...row, lease: { token: "concurrent-owner" } }
      : { version: 1, state: "cleared", sessionId: id, retired: true },
  );
});

it.each([false, true])("preserves canonical conflict (retired: %s)", async (retired) => {
  const f = await fixture({ index: retired ? undefined : null });
  const store = f.state<unknown>();
  const target = retired ? stateKey() : f.conversationKey;
  const existing = retired
    ? { version: 1, state: "cleared", sessionId: id, retired: true }
    : { version: 1, state: "active" };
  if (retired) {
    await store.register(f.conversationKey, await f.readBinding());
  }
  await store.register(target, existing);
  expectWarning(
    await f.migrate(),
    `current plugin state ${retired ? "changed" : "is invalid"} at ${target}`,
  );
  await fs.access(f.sidecar);
  await expect(store.lookup(target)).resolves.toEqual(existing);
  if (retired) {
    expect(await readJson(f.storePath)).not.toHaveProperty(`${key}.agentHarnessId`);
  }
});

it.each([false, true])("archives orphan (cleared: %s)", async (cleared) => {
  const f = await fixture({
    index: { "agent:main:metadata-only": { label: "Waiting for first turn", updatedAt: 1 } },
  });
  const existing: StoredCodexAppServerBinding = { version: 1, state: "cleared", retired: true };
  if (cleared) {
    await f.state().register(f.conversationKey, existing);
  }
  expect((await f.migrate()).warnings).toEqual([]);
  await expectArchived(f.sidecar);
  if (cleared) {
    await expect(f.state().lookup(f.conversationKey)).resolves.toEqual(existing);
  }
});

it.each([
  [
    "missing system agent",
    { root: "sessions", sessionKey: id },
    "session ownership is indeterminate",
  ],
  ["stale locator", { fields: { sessionFile: "../outside.jsonl" } }, "invalid locator"],
  [
    "shared",
    {
      index: Object.fromEntries(
        ["codex", "pi"].map((agentHarnessId, i) => [
          `agent:main:owner-${i}`,
          session(`owner-${i}`, { sessionFile: `${id}.jsonl`, agentHarnessId }),
        ]),
      ),
    },
    "2 matching session owners make ownership ambiguous",
  ],
  ["foreign", { fields: { agentHarnessId: "pi" } }, "owned by agent harness pi"],
] satisfies Array<[string, Parameters<typeof fixture>[0], string]>)(
  "retains %s owner sidecar",
  async (name, options, reason) => {
    const f = await fixture(options);
    const params =
      name === "missing system agent"
        ? { config: { agents: explicitOwners("missing", ["main", "ops"]) } }
        : {};
    if (name === "missing system agent") {
      await expect(
        f.migration.detectLegacyState({ ...f.params, ...params }),
      ).resolves.toMatchObject({
        preview: [expect.stringContaining("legacy sidecar")],
      });
    }
    const result = await f.migrate(params);
    if (name === "foreign") {
      expect(result).toEqual({
        changes: [],
        warnings: [],
        notices: [expect.stringContaining(reason)],
      });
    } else {
      expectWarning(result, reason);
    }
    await expectUnimported(f);
    if (name === "stale locator") {
      expect(f.readSession()).toBeUndefined();
    }
  },
);

it.each([
  { source: "{", detail: "invalid JSON", label: "invalid JSON" },
  { source: malformedIndex(), detail: "UTF-8", label: "malformed UTF-8" },
  {
    source: JSON.stringify({ [key]: { sessionId: id, agentHarnessId: 42 } }),
    detail: "invalid entries",
    label: "malformed harness metadata",
  },
  {
    source: JSON.stringify({ [key]: session("../unsafe", { sessionFile: "unsafe.jsonl" }) }),
    detail: "invalid entries",
    label: "unsafe session id",
  },
])("retains sidecars for an indeterminate $label index", async ({ source, detail }) => {
  const f = await fixture({ index: null });
  const { file, params } = await externalIndex(f, source);
  const result = await f.migration.migrateLegacyState(params);
  expectWarning(result, "session index");
  expect(result.warnings[0]).toContain(detail);
  if (detail === "UTF-8") {
    expect(result.warningDisposition).toBe("recoverable");
  }
  await expectPreservedInput(f, file, source);
});

it("retains malformed UTF-8 sidecars without importing replacement characters", async () => {
  const f = await fixture({ index: null });
  const source = await fs.readFile(f.sidecar);
  source[source.indexOf("thread")] = 0xff;
  await fs.writeFile(f.sidecar, source);
  const result = await f.migrate();
  expectWarning(result, "UTF-8");
  expect(result.warningDisposition).toBe("recoverable");
  await expectPreservedInput(f, f.sidecar, source);
});

it("reports malformed UTF-8 external indexes when no sidecar can be discovered", async () => {
  const f = await fixture({ index: null });
  const source = malformedIndex();
  const { dir, file, params } = await externalIndex(f, source);
  const sidecar = path.join(dir, path.basename(f.sidecar));
  await fs.rename(f.sidecar, sidecar);
  await fs.rename(f.transcript, path.join(dir, `${id}.jsonl`));
  expect((await f.migration.detectLegacyState(params))?.preview.join("\n")).toContain("UTF-8");
  const result = await f.migration.migrateLegacyState(params);
  expectWarning(result, "UTF-8");
  expect(result.warningDisposition).toBe("recoverable");
  await expectPreservedInput(f, file, source, sidecar);
});

it("does not scan above stateDir or follow escaped external store locators", async () => {
  const outer = await tempDir();
  const outside = await tempDir();
  const stateDir = path.join(outer, "state");
  const stray = path.join(outer, "unrelated");
  await fs.mkdir(stateDir);
  await fs.mkdir(stray);
  const file = path.join(outer, "sessions.json");
  await writeJson(path.join(stray, "foreign.jsonl.codex-app-server.json"), {
    schemaVersion: 2,
    threadId: "thread-foreign",
  });
  await writeJson(path.join(outside, "foreign.jsonl.codex-app-server.json"), {
    schemaVersion: 2,
    threadId: "thread-escaped",
  });
  await fs.symlink(outside, path.join(outer, "escaped"));
  // The store is stateDir's parent: indexed-only discovery must reject a missing file through an escaping symlink.
  await writeJson(file, {
    "agent:main:foreign": session("foreign", { sessionFile: "escaped/foreign.jsonl" }),
  });
  const migration = stateMigrations[0];
  assert(migration, "missing Codex binding migration");
  await expect(
    migration.detectLegacyState({
      ...doctorParams(stateDir),
      config: { session: { store: file } },
    }),
  ).resolves.toBeNull();
});
