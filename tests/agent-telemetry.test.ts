import assert from "node:assert/strict";
import test from "node:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { createAgentTelemetry } from "../src/lib/observability/agent-telemetry";
import { assessWithModelTelemetry } from "../src/lib/agents/model-assessment";

type Recorded = { name: string; kind: string; parent: string | null;
  attributes: Record<string, string | number | boolean>; output?: unknown };

function fakeSdk(options: { failInit?: boolean; failTraceBeforeWork?: boolean;
  failTraceAfterWork?: boolean; flushResult?: boolean } = {}) {
  const scope = new AsyncLocalStorage<string>();
  const spans: Recorded[] = [];
  let inits = 0;
  let flushes = 0;
  const sdk = {
    async init() { inits++; if (options.failInit) throw new Error("secret initialization error"); },
    async trace<T>(config: { name: string; kind?: string; attributes?: Record<string, string | number | boolean> },
      callback: (span: { spanContext(): { traceId: string }; setAttribute(key: string, value: string | number | boolean): void;
        setStatus(value: { code: number; message?: string }): void }) => Promise<T>): Promise<T> {
      if (options.failTraceBeforeWork) throw new Error("telemetry unavailable");
      const record: Recorded = { name: config.name, kind: config.kind ?? "CHAIN",
        parent: scope.getStore() ?? null, attributes: { ...config.attributes } };
      spans.push(record);
      const output = await scope.run(config.name, () => callback({
        spanContext: () => ({ traceId: "a".repeat(32) }),
        setAttribute: (key, value) => { record.attributes[key] = value; },
        setStatus: ({ code }) => { record.attributes["test.status_code"] = code; },
      }));
      record.output = output;
      if (options.failTraceAfterWork) throw new Error("telemetry export error");
      return output;
    },
    async flush() { flushes++; return options.flushResult ?? true; },
  } as unknown as Parameters<typeof createAgentTelemetry>[0];
  return { sdk, spans, get inits() { return inits; }, get flushes() { return flushes; } };
}

test("initializes once, nests stage spans, correlates run and flushes after root", async () => {
  const fake = fakeSdk();
  const telemetry = createAgentTelemetry(fake.sdk, () => "test-key");
  let savedTraceId = "";
  const result = await telemetry.run("recovery", {
    runId: "run-1", incidentId: "incident-1",
  }, () => telemetry.stage("recovery.execute", "TOOL", {
    "siteguard.attempt_number": 1,
  }, async (span) => {
    span?.setAttribute("siteguard.tool_result", "RESET_APPLIED");
    return { outcome: "recovered" };
  }), async (traceId) => { savedTraceId = traceId; });
  assert.deepEqual(result, { outcome: "recovered" });
  assert.equal(savedTraceId, "a".repeat(32));
  assert.equal(fake.inits, 1);
  assert.equal(fake.flushes, 1);
  assert.deepEqual(fake.spans.map((span) => [span.name, span.parent]), [
    ["siteguard.agent_run", null], ["recovery.execute", "siteguard.agent_run"],
  ]);
  assert.equal(fake.spans[0].attributes["siteguard.run_id"], "run-1");
  assert.equal(fake.spans[0].attributes["siteguard.final_outcome"], "recovered");
  assert.equal(fake.spans[1].attributes["siteguard.tool_result"], "RESET_APPLIED");
  assert.deepEqual(fake.spans[1].output, { outcome: "ok" });
});

test("records model attempt, usage attributes and sanitized failure without raw error", async () => {
  const fake = fakeSdk();
  const telemetry = createAgentTelemetry(fake.sdk, () => "test-key");
  await assert.rejects(telemetry.run("diagnosis", {
    runId: "run-2", incidentId: "incident-2",
  }, () => telemetry.stage("diagnosis.model_call", "LLM", {
    "llm.model_name": "demo-model", "siteguard.model_attempt": 2,
  }, async (span) => {
    span?.setAttribute("llm.token_count.prompt", 11);
    throw new TypeError("secret prompt or credential should stay local");
  })));
  const model = fake.spans.find((span) => span.kind === "LLM");
  assert.ok(model);
  assert.equal(model.attributes["llm.token_count.prompt"], 11);
  assert.equal(model.attributes["siteguard.error_type"], "TypeError");
  assert.equal(JSON.stringify(fake.spans).includes("secret prompt"), false);
  assert.equal(fake.flushes, 1);
});

test("initialization failure and missing credentials leave the action runnable once", async () => {
  for (const key of [undefined, "test-key"]) {
    const fake = fakeSdk({ failInit: true });
    const telemetry = createAgentTelemetry(fake.sdk, () => key);
    let executions = 0;
    await telemetry.run("recovery", { runId: "run", incidentId: "incident" }, async () => {
      executions++;
      return "done";
    });
    assert.equal(executions, 1);
    assert.equal(fake.inits, key ? 1 : 0);
    assert.equal(fake.flushes, 0);
  }
});

test("telemetry faults before or after a callback never replay a recovery action", async () => {
  for (const options of [{ failTraceBeforeWork: true }, { failTraceAfterWork: true },
    { flushResult: false }]) {
    const fake = fakeSdk(options);
    const telemetry = createAgentTelemetry(fake.sdk, () => "test-key");
    let executions = 0;
    await telemetry.run("recovery", { runId: "run", incidentId: "incident" }, async () => {
      executions++;
      return { outcome: "escalated" };
    });
    assert.equal(executions, 1);
  }
});

test("model adapter traces each explicit retry and available token usage", async () => {
  const fake = fakeSdk();
  const telemetry = createAgentTelemetry(fake.sdk, () => "test-key");
  let calls = 0;
  const result = await telemetry.run("diagnosis", { runId: "run", incidentId: "incident" },
    () => assessWithModelTelemetry("safe bounded input", "test-model", async () => {
      calls++;
      if (calls === 1) throw new Error("provider details are private");
      return { content: JSON.stringify({ observed_symptoms: ["HTTP 500"],
        probable_causes: [{ cause: "Possible application fault", evidence_refs: ["check:1"] }],
        unknowns: [], confidence: "medium", next_tool: null }),
        usage_metadata: { input_tokens: 11, output_tokens: 7, total_tokens: 18 } };
    }, telemetry));
  assert.equal(result.confidence, "medium");
  assert.equal(calls, 2);
  const callsTraced = fake.spans.filter((span) => span.kind === "LLM");
  assert.equal(callsTraced.length, 2);
  assert.deepEqual(callsTraced.map((span) => span.attributes["siteguard.model_attempt"]), [1, 2]);
  assert.equal(callsTraced[1].attributes["llm.token_count.total"], 18);
  assert.equal(JSON.stringify(fake.spans).includes("provider details"), false);
});
