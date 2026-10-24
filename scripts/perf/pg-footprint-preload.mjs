// Synthetic Gateway instrumentation: no query bindings, result rows, or task payloads.
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import {
  BroadcastChannel,
  getEnvironmentData,
  setEnvironmentData,
  threadId,
  workerData,
} from "node:worker_threads";

const configuration = getEnvironmentData("pg-footprint") ?? {
  output: process.env.PGFOOTPRINT_OUTPUT,
  channel: process.env.PGFOOTPRINT_CHANNEL,
};
const { output, channel } = configuration;
if (!output || !channel) {
  throw new Error("PG footprint preload requires its synthetic output and channel");
}
setEnvironmentData("pg-footprint", configuration);
const file = path.join(output, `workers-${process.pid}-${threadId}.jsonl`);
const record = (event) =>
  appendFileSync(
    file,
    `${JSON.stringify({ at: Date.now(), pid: process.pid, threadId, ...event })}\n`,
  );
const phase = () => readFileSync(path.join(output, "phase"), "utf8").trim();
const workers = createRequire(import.meta.url)("node:worker_threads");
const NativeWorker = workers.Worker;
workers.Worker = class extends NativeWorker {
  constructor(filename, options = {}) {
    const execArgv = options.execArgv ?? process.execArgv;
    super(filename, {
      ...options,
      execArgv: execArgv.includes(import.meta.filename)
        ? execArgv
        : [...execArgv, "--import", import.meta.filename],
    });
    const workerId = this.threadId;
    record({ type: "spawn", workerId, script: String(filename), phase: phase() });
    this.once("exit", (code) => record({ type: "exit", workerId, code, phase: phase() }));
  }
};
syncBuiltinESMExports();

// Import the driver only where production already loads it; other isolates stay untouched.
const script = process.argv[1];
if (/[/\\]postgres-sync[/\\]bridge\.worker\.[cm]?[jt]s$/.test(script ?? "")) {
  const pg = createRequire(import.meta.url)("pg");
  const digest = (value) => createHash("sha256").update(value).digest("hex").slice(0, 12);
  const schema = digest(workerData.schema);
  for (const method of ["connect", "end", "query"]) {
    const original = pg.Client.prototype[method];
    pg.Client.prototype[method] = function (...args) {
      if (method === "query") {
        record({
          type: "pg-query",
          schema,
          phase: phase(),
          sql: typeof args[0] === "string" ? args[0] : args[0].text,
        });
      } else {
        record({
          type: `pg-${method}`,
          schema,
          database: digest(this.connectionParameters.database),
          phase: phase(),
        });
      }
      return Reflect.apply(original, this, args);
    };
  }
}

const bus = new BroadcastChannel(channel);
bus.unref();
const sample = (label) => {
  record({
    type: "sample",
    sample: label,
    phase: phase(),
    memory: process.memoryUsage(),
    cpu: process.threadCpuUsage(),
    processCpu: threadId === 0 ? process.cpuUsage() : undefined,
  });
};
bus.addEventListener("message", ({ data }) => {
  if (data.type === "sample") {
    sample(data.sample);
  }
});
if (threadId === 0) {
  process.on("message", (data) => {
    if (data?.type !== "pg-footprint:sample") {
      return;
    }
    sample(data.sample);
    // Node BroadcastChannel has no targetOrigin argument.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    bus.postMessage({ type: "sample", sample: data.sample });
  });
  process.channel?.unref();
}
record({ type: "start", script });
