import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SECRET_FILE_MAX_BYTES } from "openclaw/plugin-sdk/secret-file-runtime";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspaceSync,
  type TempWorkspaceSync,
} from "openclaw/plugin-sdk/temp-path";
import { build } from "tsdown";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createStateSchemaInlinePlugin } from "../../../scripts/lib/state-schema-inline-plugin.mjs";
import { encodeOnePasswordSecretId } from "../onepassword-secret-id.js";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };
import { createTrustedNodeFixture } from "./trusted-node.test-support.js";

const sourceResolverPath = fileURLToPath(
  new URL("../onepassword-secret-ref-resolver.js", import.meta.url),
);
const sourceStaticAssetPaths = [
  sourceResolverPath,
  fileURLToPath(new URL("../onepassword-op-path.js", import.meta.url)),
  fileURLToPath(new URL("../onepassword-secret-id.js", import.meta.url)),
];
const rootTsconfigPath = path.resolve("tsconfig.json");
// Shorten the staged resolver's deadline without changing its production timeout.
const TEST_OP_READ_TIMEOUT_MS = process.platform === "win32" ? 5_000 : 1_500;
const secretId = "op://Engineering/OpenRouter/apiKey";
const serviceToken = "not-a-real-service-account-token";
let fixtureWorkspace: TempWorkspaceSync;
let stateWorkspace: TempWorkspaceSync;
let resolverPath = sourceResolverPath;
let timeoutResolverPath: string;
let stagedResolverRoot: string | undefined;
let trustedNodeRoot: string | undefined;
let trustedNodePath: string;

beforeAll(async () => {
  const tempRoot = path.join(process.cwd(), ".tmp");
  fs.mkdirSync(tempRoot, { recursive: true });
  stagedResolverRoot = fs.mkdtempSync(path.join(tempRoot, "onepassword-resolver-"));
  for (const sourcePath of sourceStaticAssetPaths) {
    const stagedPath = path.join(stagedResolverRoot, path.basename(sourcePath));
    fs.copyFileSync(sourcePath, stagedPath);
  }
  resolverPath = path.join(stagedResolverRoot, path.basename(sourceResolverPath));
  const resolverSource = fs.readFileSync(sourceResolverPath, "utf8");
  const timeoutResolverSource = resolverSource.replace(
    "const OP_READ_TIMEOUT_MS = 7_000;",
    `const OP_READ_TIMEOUT_MS = ${TEST_OP_READ_TIMEOUT_MS};`,
  );
  if (timeoutResolverSource === resolverSource) {
    throw new Error("failed to shorten the staged 1Password resolver timeout");
  }
  timeoutResolverPath = path.join(stagedResolverRoot, "onepassword-timeout-resolver.js");
  fs.writeFileSync(timeoutResolverPath, timeoutResolverSource);
  // Build the real SDK once; each request still gets a fresh process and real op execution.
  // Keep native dependencies external and use the production schema-asset transform.
  const compiledRoot = path.join(stagedResolverRoot, "compiled");
  await build({
    config: false,
    entry: [resolverPath, timeoutResolverPath],
    outDir: compiledRoot,
    tsconfig: rootTsconfigPath,
    format: "esm",
    outExtensions: () => ({ js: ".js" }),
    dts: false,
    deps: {
      neverBundle: true,
      alwaysBundle: [/^openclaw\//, /^@openclaw\/(?!fs-safe(?:\/|$))/],
    },
    plugins: [createStateSchemaInlinePlugin()],
  });
  resolverPath = path.join(compiledRoot, path.basename(resolverPath));
  timeoutResolverPath = path.join(compiledRoot, path.basename(timeoutResolverPath));
  // The fake op paths remain per-test; only their trusted Node interpreter is shared.
  // Re-copying the runtime does not strengthen path-ownership coverage.
  trustedNodeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-1password-node-"));
  trustedNodePath = createTrustedNodeFixture(trustedNodeRoot);
});

afterAll(() => {
  if (stagedResolverRoot) {
    fs.rmSync(stagedResolverRoot, { recursive: true, force: true });
  }
  if (trustedNodeRoot) {
    fs.rmSync(trustedNodeRoot, { recursive: true, force: true });
  }
});

function writeOpScript(opPath: string, body: string): void {
  fs.writeFileSync(opPath, `#!${trustedNodePath}\n${body}`, { mode: 0o755 });
}

function writeToken(stateDir: string, token: string): void {
  const tokenDir = path.join(stateDir, "credentials", "onepassword");
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(path.join(tokenDir, "service-account-token"), token, { mode: 0o600 });
}

function runOp(body: string, params: Parameters<typeof runResolver>[0] = {}) {
  const windows = process.platform === "win32";
  const opPath = windows ? process.execPath : path.join(fixtureWorkspace.dir, "op");
  if (windows) {
    fs.writeFileSync(path.join(fixtureWorkspace.dir, "read"), body);
  } else {
    writeOpScript(opPath, body);
  }
  return runResolver({
    cwd: fixtureWorkspace.dir,
    ...params,
    env: { CLAW_1PASSWORD_OP: opPath, ...params.env },
  });
}

function expectFailure(result: Awaited<ReturnType<typeof runResolver>>) {
  expect(result).toEqual({ code: 1, stdout: "", stderr: "1Password SecretRef resolver failed.\n" });
}

function expectValues(
  result: Awaited<ReturnType<typeof runResolver>>,
  values: Record<string, string>,
) {
  expect(result).toMatchObject({ code: 0, stderr: "" });
  expect(JSON.parse(result.stdout).values).toEqual(values);
}

function expectError(result: Awaited<ReturnType<typeof runResolver>>, message: string) {
  expect(JSON.parse(result.stdout).errors).toEqual({ [secretId]: { message } });
}

function runResolver(params: {
  ids?: string[];
  cwd?: string;
  env?: Record<string, string>;
  resolverExecutablePath?: string;
  token?: string | null;
}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const stateDir = params.env?.OPENCLAW_STATE_DIR || stateWorkspace.dir;
  if (params.token !== null) {
    writeToken(stateDir, params.token ?? serviceToken);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [params.resolverExecutablePath ?? resolverPath], {
      ...(params.cwd ? { cwd: params.cwd } : {}),
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        OP_SERVICE_ACCOUNT_TOKEN: "",
        CLAW_1PASSWORD_OP: "",
        OPENCLAW_STATE_DIR: stateDir,
        ...params.env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({ stdout, stderr, code });
    });
    child.stdin.end(
      `${JSON.stringify({
        protocolVersion: 1,
        provider: "onepassword",
        ids: params.ids ?? [secretId],
      })}\n`,
    );
  });
}

function workspace() {
  return tempWorkspaceSync({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-1password-test-",
  });
}

beforeEach(() => {
  fixtureWorkspace = workspace();
  // Executable fixtures can become unsafe; keep the token's parent independently trusted.
  stateWorkspace = workspace();
});

afterEach(() => {
  fixtureWorkspace.cleanup();
  stateWorkspace.cleanup();
});

describe("plugin manifest", () => {
  it("declares the 1Password resolver as a managed Node SecretRef preset", () => {
    const resolverSource = fs.readFileSync(sourceResolverPath, "utf8");
    const readIntegerConstant = (name: string): number => {
      const match = new RegExp(`const ${name} = (\\d[\\d_]*)`, "u").exec(resolverSource);
      return Number(match?.[1]?.replaceAll("_", ""));
    };
    const opReadConcurrency = readIntegerConstant("OP_READ_CONCURRENCY");
    const opReadTimeoutMs = readIntegerConstant("OP_READ_TIMEOUT_MS");
    const maxRefsPerRequest = readIntegerConstant("MAX_SECRET_REFS_PER_REQUEST");
    const maxSecretValueBytes = readIntegerConstant("MAX_SECRET_VALUE_BYTES");
    const worstCaseBatchTimeoutMs =
      Math.ceil(maxRefsPerRequest / opReadConcurrency) * opReadTimeoutMs;
    const worstCaseEscapedValueBytes = Buffer.byteLength(
      JSON.stringify("\0".repeat(maxSecretValueBytes)),
    );
    const integration = manifest.secretProviderIntegrations?.onepassword;

    expect(manifest.commandAliases).toContainEqual({
      name: "onepassword",
      cliCommand: "onepassword",
    });
    expect(integration).toMatchObject({
      providerAlias: "onepassword",
      source: "exec",
      command: "${node}",
      args: ["./onepassword-secret-ref-resolver.js"],
      passEnv: expect.arrayContaining([
        "HOME",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "APPDATA",
        "LOCALAPPDATA",
        "TEMP",
        "TMP",
        "OPENCLAW_STATE_DIR",
        "OPENCLAW_PROFILE",
        "PATH",
        "SYSTEMROOT",
        "WINDIR",
      ]),
    });
    for (const key of [
      "OP_SERVICE_ACCOUNT_TOKEN",
      "OP_CONNECT_HOST",
      "OP_CONNECT_TOKEN",
      "OP_ACCOUNT",
      "OP_CACHE",
    ]) {
      expect(integration?.passEnv).not.toContain(key);
    }
    expect(integration).not.toHaveProperty("trustedDirs");
    expect(integration?.timeoutMs).toBeGreaterThan(worstCaseBatchTimeoutMs);
    expect(integration?.noOutputTimeoutMs).toBeGreaterThan(worstCaseBatchTimeoutMs);
    expect(integration?.maxOutputBytes).toBeGreaterThan(
      maxRefsPerRequest * worstCaseEscapedValueBytes,
    );
    expect(packageJson.openclaw.build.staticAssets).toEqual(
      expect.arrayContaining(
        sourceStaticAssetPaths.map((file) => ({
          source: `./${path.basename(file)}`,
          output: path.basename(file),
        })),
      ),
    );
  });
});

describe("1Password SecretRef resolver", () => {
  it("resolves shorthand references with whitespace and a noninteractive op environment", async () => {
    const id = "Engineering/OpenRouter/apiKey";
    const home = path.join(fixtureWorkspace.dir, "profile");
    const local = path.join(home, "AppData", "Local");
    const directories = {
      USERPROFILE: home,
      APPDATA: path.join(home, "AppData", "Roaming"),
      LOCALAPPDATA: local,
      TEMP: path.join(local, "Temp"),
      TMP: path.join(local, "Tmp"),
    };
    for (const directory of Object.values(directories)) {
      fs.mkdirSync(directory, { recursive: true });
    }
    const windows = process.platform === "win32";
    const expected = {
      args: [...(windows ? [] : ["read"]), "--cache=false", "--no-newline", secretId],
      biometric: "false",
      desktop: "false",
      serviceAccount: true,
      ...(windows ? directories : {}),
    };
    const result = await runOp(
      `process.stdout.write(JSON.stringify({
  args: process.argv.slice(2),
  biometric: process.env.OP_BIOMETRIC_UNLOCK_ENABLED,
  desktop: process.env.OP_LOAD_DESKTOP_APP_SETTINGS,
  serviceAccount: process.env.OP_SERVICE_ACCOUNT_TOKEN === "not-a-real-service-account-token",
  account: process.env.OP_ACCOUNT,
  ...(process.platform === "win32" ? Object.fromEntries(
    ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"].map(key => [key, process.env[key]])) : {}),
}) + " \\t");`,
      {
        ids: [id],
        env: {
          HOME: windows ? path.join(home, "wrong-home") : home,
          ...directories,
          OP_ACCOUNT: "must-not-reach-op",
        },
      },
    );
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      protocolVersion: 1,
      values: { [id]: JSON.stringify(expected) + " \t" },
      errors: {},
    });
  });
  it("escapes shorthand ids that begin with the opaque encoding prefix", async () => {
    const nativeRef = "opb64:team/item/field";
    const encodedId = encodeOnePasswordSecretId(nativeRef);

    expect(encodedId).toMatch(/^opb64:[A-Za-z0-9_-]+$/);
    expect(encodedId).not.toBe(nativeRef);
  });

  it("requires an absolute op CLI path", async () => {
    expectFailure(await runResolver({ env: { CLAW_1PASSWORD_OP: "op" } }));
  });

  it("rejects oversized batches before reading credentials or starting op", async () => {
    const ids = Array.from(
      { length: 33 },
      (_, index) => `op://Engineering/Item${index}/credential`,
    );
    const result = await runResolver({
      ids,
      env: { CLAW_1PASSWORD_OP: "/does/not/exist/op" },
      token: null,
    });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    const response = JSON.parse(result.stdout) as {
      values: Record<string, string>;
      errors: Record<string, { message: string }>;
    };
    expect(response.values).toEqual({});
    expect(Object.keys(response.errors)).toEqual(ids);
    expect(new Set(Object.values(response.errors).map((error) => error.message))).toEqual(
      new Set(["1Password SecretRef resolver supports at most 32 references per request."]),
    );
  });

  it.each([
    { name: "requires the broker token file", token: null },
    {
      name: "rejects an oversized broker token",
      token: "x".repeat(DEFAULT_SECRET_FILE_MAX_BYTES + 1),
    },
  ])("$name", async ({ token }) => {
    expectFailure(await runResolver({ env: { CLAW_1PASSWORD_OP: process.execPath }, token }));
  });

  it.each([
    {
      body: "setInterval(() => {}, 1000);",
      message: `op read timed out after ${TEST_OP_READ_TIMEOUT_MS}ms.`,
    },
    {
      body: 'process.stdout.write("x".repeat(70 * 1024));',
      message: "op read output exceeded the limit.",
    },
  ])(
    "reports $message",
    async ({ body, message }) => {
      const result = await runOp(body, { resolverExecutablePath: timeoutResolverPath });
      expectError(result, message);
    },
    process.platform === "win32" ? 30_000 : 15_000,
  );
  describe.runIf(process.platform !== "win32")("POSIX op execution", () => {
    it("rejects a symlinked broker token file", async () => {
      const stateDir = fixtureWorkspace.dir;
      const tokenDir = path.join(stateDir, "credentials", "onepassword");
      const targetPath = path.join(tokenDir, "service-account-token-target");
      const tokenPath = path.join(tokenDir, "service-account-token");
      fs.mkdirSync(tokenDir, { recursive: true });
      fs.writeFileSync(targetPath, "linked-service-account-token", { mode: 0o600 });
      fs.symlinkSync(targetPath, tokenPath);

      const result = await runResolver({
        env: { CLAW_1PASSWORD_OP: process.execPath, OPENCLAW_STATE_DIR: stateDir },
        token: null,
      });

      expectFailure(result);
    });

    it("reads the service token from the selected profile state directory", async () => {
      const home = fixtureWorkspace.dir;
      writeToken(path.join(home, ".openclaw-work"), "profile-token");
      writeToken(path.join(home, ".openclaw"), "default-token");

      const result = await runOp(`process.stdout.write(process.env.OP_SERVICE_ACCOUNT_TOKEN);\n`, {
        env: {
          HOME: home,
          OPENCLAW_HOME: "",
          OPENCLAW_PROFILE: "work",
          OPENCLAW_STATE_DIR: "",
        },
        token: null,
      });

      expectValues(result, { [secretId]: "profile-token" });
    });

    it.each([
      {
        name: "state dir",
        directory: "oc-state",
        home: "",
        state: "~/oc-state",
        token: "dollar-token",
      },
      {
        name: "OPENCLAW_HOME",
        directory: "oc-home/.openclaw",
        home: "~/oc-home",
        state: "",
        token: "home-token",
      },
    ])(
      "preserves literal $ in HOME when expanding tilde $name",
      async ({ directory, home: openclawHome, state, token }) => {
        const home = path.join(fixtureWorkspace.dir, "home$&d");
        writeToken(path.join(home, directory), token);
        const result = await runOp(
          "process.stdout.write(process.env.OP_SERVICE_ACCOUNT_TOKEN);\n",
          {
            env: {
              HOME: home,
              OPENCLAW_PROFILE: "",
              OPENCLAW_HOME: openclawHome,
              OPENCLAW_STATE_DIR: state,
            },
            token: null,
          },
        );
        expectValues(result, { [secretId]: token });
      },
    );

    it("keeps the exit-code diagnostic when failed op read has no stderr", async () => {
      const result = await runOp(
        `process.stdout.write("secret-output-must-not-escape");
process.exitCode = 1;
`,
      );
      expect(result.stdout).not.toContain("secret-output-must-not-escape");
      expectError(result, "op read failed with exit code 1.");
    });

    it("reports a bounded redacted stderr tail without exposing op read secrets", async () => {
      const result = await runOp(
        `process.stdout.write("fixture-secret-output");
process.stderr.write("discarded-prefix " + "x".repeat(2_000) + "\\n");
process.stderr.write(process.env.OP_SERVICE_ACCOUNT_TOKEN + "\\nfixture-secret-output\\n");
process.stderr.write("password=" + "fixture-private-password".repeat(40) + "\\nnot signed in; item not found\\n");
process.exitCode = 1;
`,
      );
      expect(result).toMatchObject({ code: 0, stderr: "" });
      const response = JSON.parse(result.stdout) as {
        values: Record<string, string>;
        errors: Record<string, { message: string }>;
      };
      expect(response.values).toEqual({});
      const message = response.errors[secretId]?.message;
      expect(message).toBeDefined();
      expect(message).toMatch(/^op read failed with exit code 1\./);
      expect(message).toMatch(/not signed in; item not found$/);
      expect(message?.length).toBeLessThanOrEqual("op read failed with exit code 1. ".length + 512);
      for (const hidden of [
        "discarded-prefix",
        "not-a-real-service-account-token",
        "fixture-secret-output",
        "fixture-private-password",
      ]) {
        expect(result.stdout).not.toContain(hidden);
      }
    });

    it("bounds concurrent op reads", async () => {
      const tempDir = fixtureWorkspace.dir;
      const logPath = path.join(tempDir, "events.log");

      const ids = Array.from({ length: 20 }, (_, index) => `op://Vault/Item${index}/field`);
      const result = await runOp(
        `const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logPath)}, "start " + process.pid + "\\n");
setTimeout(() => {
  fs.appendFileSync(${JSON.stringify(logPath)}, "end " + process.pid + "\\n");
  process.stdout.write("not-a-real-value");
}, 80);
`,
        { ids },
      );

      expect(Object.keys(JSON.parse(result.stdout).values)).toHaveLength(ids.length);
      let active = 0;
      let maxActive = 0;
      for (const event of fs.readFileSync(logPath, "utf8").trim().split("\n")) {
        active += event.startsWith("start ") ? 1 : -1;
        maxActive = Math.max(maxActive, active);
      }
      expect(maxActive).toBeLessThanOrEqual(4);
    });

    it("refuses to pass the token to an op CLI in an unsafe PATH directory", async () => {
      const tempDir = fixtureWorkspace.dir;
      const opPath = path.join(tempDir, "op");
      const tokenLogPath = path.join(tempDir, "token.log");
      writeOpScript(
        opPath,
        `require("node:fs").writeFileSync(${JSON.stringify(tokenLogPath)}, process.env.OP_SERVICE_ACCOUNT_TOKEN);\n`,
      );
      fs.chmodSync(tempDir, 0o777);

      const result = await runResolver({
        env: { PATH: tempDir },
      });

      expectFailure(result);
      expect(fs.existsSync(tokenLogPath)).toBe(false);
    });
  });
});
