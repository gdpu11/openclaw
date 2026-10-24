import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveRuntimeDependencyEntrypointUrl } from "./runtime-process-dependency-url.js";
import { runtimeProcessDependencyEntrypoints } from "./runtime-process-manifest.js";

/** Runs the packaged npm CLI with the current JavaScript runtime. */
export function resolveBundledNpmCommand(args: readonly string[]): [string, string, ...string[]] {
  let cliPath: string = runtimeProcessDependencyEntrypoints.npm.specifier;
  try {
    const resolvedCliPath = fileURLToPath(
      resolveRuntimeDependencyEntrypointUrl("npm", import.meta.url),
    );
    cliPath = resolvedCliPath;
    if (!fs.statSync(resolvedCliPath).isFile()) {
      throw new Error("Not a regular file");
    }
    return [process.execPath, resolvedCliPath, ...args];
  } catch (cause) {
    throw Object.assign(
      new Error(
        `Bundled npm CLI is missing: ${cliPath}. Reinstall OpenClaw to restore npm/bin/npm-cli.js.`,
        { cause },
      ),
      { code: "BUNDLED_NPM_CLI_NOT_FOUND", name: "BundledNpmCliNotFoundError" },
    );
  }
}

/** Bun must run the packaged CLI directly; npm's executable requires Node. */
export function resolveNpmCommand(args: readonly string[]): [string, ...string[]] {
  return process.versions.bun ? resolveBundledNpmCommand(args) : ["npm", ...args];
}
