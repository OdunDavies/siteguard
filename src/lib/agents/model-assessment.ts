import { agentTelemetry, type AgentTelemetry } from "@/lib/observability/agent-telemetry";
import { modelAssessmentSchema, type ModelAssessment } from "./diagnosis-schema";

type ModelResponse = { content: unknown; usage_metadata?: {
  input_tokens?: number; output_tokens?: number; total_tokens?: number;
} | null };

export async function assessWithModelTelemetry(input: string, modelId: string,
  invoke: () => Promise<ModelResponse>, telemetry: AgentTelemetry = agentTelemetry): Promise<ModelAssessment> {
  if (input.length > 12_000) throw new Error("Diagnosis context exceeds limit");
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await telemetry.stage("diagnosis.model_call", "LLM", {
        "llm.model_name": modelId,
        "siteguard.model_attempt": attempt,
      }, async (span) => {
        const response = await invoke();
        const usage = response.usage_metadata;
        if (typeof usage?.input_tokens === "number") span?.setAttribute("llm.token_count.prompt", usage.input_tokens);
        if (typeof usage?.output_tokens === "number") span?.setAttribute("llm.token_count.completion", usage.output_tokens);
        if (typeof usage?.total_tokens === "number") span?.setAttribute("llm.token_count.total", usage.total_tokens);
        if (typeof response.content !== "string" || response.content.length > 6_000) {
          throw new Error("InvalidModelResponse");
        }
        const value = response.content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
        return modelAssessmentSchema.parse(JSON.parse(value));
      });
    } catch {
      if (attempt === 2) throw new Error("ModelAssessmentFailed");
    }
  }
  throw new Error("ModelAssessmentFailed");
}
