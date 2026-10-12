import { flush, init, trace } from "neatlogs";
import { logEvent } from "@/lib/logging";

type Sdk = Pick<typeof import("neatlogs"), "init" | "trace" | "flush">;
type ActiveSpan = Parameters<Parameters<typeof trace>[1]>[0];
type StageKind = "WORKFLOW" | "AGENT" | "CHAIN" | "TOOL" | "GUARDRAIL" | "LLM";
type AttributeValue = string | number | boolean;
type Attributes = Record<string, AttributeValue>;

const defaultSdk: Sdk = { init, trace, flush };
type InitState = { initialized: boolean; initFailed: boolean; pendingInit: Promise<boolean> | null };
const runtime = globalThis as typeof globalThis & { __siteguardNeatlogsState?: InitState };
const runtimeState = runtime.__siteguardNeatlogsState ??= {
  initialized: false, initFailed: false, pendingInit: null,
};

function errorType(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  return /^[A-Za-z]{1,60}$/.test(name) ? name : "UnknownError";
}

export function createAgentTelemetry(
  sdk: Sdk = defaultSdk,
  apiKey: () => string | undefined = () => process.env.NEATLOGS_API_KEY,
  state: InitState = { initialized: false, initFailed: false, pendingInit: null },
) {
  async function ready(): Promise<boolean> {
    if (!apiKey()) return false;
    if (state.initialized) return true;
    if (state.initFailed) return false;
    if (!state.pendingInit) {
      state.pendingInit = sdk.init({ apiKey: apiKey(), workflowName: "siteguard-agent",
        captureLogs: false, registerShutdownHandlers: false }).then(() => {
        state.initialized = true;
        return true;
      }).catch(() => {
        state.initFailed = true;
        logEvent("warn", "neatlogs.init_failed");
        return false;
      }).finally(() => { state.pendingInit = null; });
    }
    return state.pendingInit;
  }

  async function stage<T>(name: string, kind: StageKind, attributes: Attributes,
    work: (span?: ActiveSpan) => Promise<T>): Promise<T> {
    if (!await ready()) return work();
    let started: Promise<T> | undefined;
    try {
      await sdk.trace({ name, kind, attributes }, async (span) => {
        started = work(span);
        try {
          await started;
          span.setAttribute("siteguard.outcome", "ok");
          return { outcome: "ok" };
        } catch (error) {
          span.setAttribute("siteguard.outcome", "error");
          span.setAttribute("siteguard.error_type", errorType(error));
          span.setStatus({ code: 2, message: errorType(error) });
          return { outcome: "error", error_type: errorType(error) };
        }
      });
    } catch {
      // A telemetry fault must never execute a recovery step twice.
      logEvent("warn", "neatlogs.span_failed", { stage: name });
    }
    return started ?? work();
  }

  async function flushRequest(): Promise<void> {
    if (!state.initialized) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        sdk.flush(),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 8000); }),
      ]);
      if (!result) logEvent("warn", "neatlogs.flush_incomplete");
    } catch {
      logEvent("warn", "neatlogs.flush_failed");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function run<T>(mode: "diagnosis" | "recovery", identifiers: {
    runId: string; incidentId: string;
  }, work: () => Promise<T>, saveTraceId?: (traceId: string) => Promise<void>): Promise<T> {
    try {
      return await stage("siteguard.agent_run", "WORKFLOW", {
        "siteguard.run_id": identifiers.runId,
        "siteguard.incident_id": identifiers.incidentId,
        "siteguard.mode": mode,
      }, async (span) => {
        const traceId = span?.spanContext().traceId;
        if (traceId && saveTraceId) {
          try { await saveTraceId(traceId); }
          catch { logEvent("warn", "neatlogs.trace_link_failed", { run_id: identifiers.runId }); }
        }
        const result = await work();
        if (result && typeof result === "object" && "outcome" in result &&
          typeof result.outcome === "string") {
          span?.setAttribute("siteguard.final_outcome", result.outcome);
        }
        return result;
      });
    } finally {
      await flushRequest();
    }
  }

  return { ready, stage, run, flushRequest };
}

export const agentTelemetry = createAgentTelemetry(defaultSdk,
  () => process.env.NEATLOGS_API_KEY, runtimeState);
export type AgentTelemetry = ReturnType<typeof createAgentTelemetry>;
