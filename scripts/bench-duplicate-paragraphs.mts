// Run serially on baseline and candidate with Node's --cpu-prof for a profile.
// This isolates projection CPU; real Gateway turn latency needs a separate transport run.
import assert from "node:assert/strict";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { createAssistantVisibleStreamText } from "../src/agents/embedded-agent-utils.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    paragraphs: { type: "string", default: "128" },
    control: { type: "boolean", default: false },
  },
});
const paragraphs = Number(values.paragraphs);
assert(Number.isSafeInteger(paragraphs) && paragraphs > 0);
const createStream: typeof createAssistantVisibleStreamText = (
  await import(
    values.owner ? pathToFileURL(values.owner).href : "../src/agents/embedded-agent-utils.ts"
  )
).createAssistantVisibleStreamText;
const opening = "The service is ready.";
const tail = Array.from(
  { length: paragraphs },
  (_, index) =>
    `Paragraph ${String(index).padStart(4, "0")}: this service returns an ordinary explanatory sentence without code.`,
);
const source = [opening, values.control ? "A different opening." : opening, ...tail].join("\n\n");
const expected = [opening, ...(values.control ? ["A different opening."] : []), ...tail].join(
  "\n\n",
);
const chunks = Array.from({ length: Math.ceil(source.length / 4) }, (_, i) =>
  source.slice(i * 4, i * 4 + 4),
);
function run() {
  const stream = createStream("final_answer");
  let delivered = "";
  let replacements = 0;
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  for (const chunk of chunks) {
    const result = stream.append(chunk);
    replacements += Number(result.delta === null);
    delivered = result.delta === null ? result.text : delivered + result.delta;
    assert.equal(delivered, result.text);
  }
  const elapsedMs = performance.now() - start;
  const used = process.threadCpuUsage(cpu);
  assert.equal(stream.text, expected);
  return { elapsedMs, cpuMs: (used.user + used.system) / 1_000, replacements };
}
const cold = run();
run();
const warm = Array.from({ length: 5 }, run);
const maxRssKiB = process.resourceUsage().maxRSS;
let scannedCharacters = 0;
const probe = mock.method(String.prototype, "matchAll");
try {
  run();
  for (const call of probe.mock.calls) {
    if (call.arguments[0].source === "\\n+|[^\\n]+") {
      scannedCharacters += String(call.this).length;
    }
  }
} finally {
  probe.mock.restore();
}
console.log(
  JSON.stringify({
    node: process.version,
    cpu: os.cpus()[0]?.model,
    loadAverage: os.loadavg(),
    paragraphs,
    control: values.control,
    sourceCharacters: source.length,
    chunks: chunks.length,
    scannedCharacters,
    cold,
    warm,
    maxRssKiB,
    parity: true,
  }),
);
