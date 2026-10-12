// Optional manual gateway check. Requires SITEGUARD_LLM_* in .env.local.
import { ChatOpenAI } from "@langchain/openai";
import { modelAssessmentSchema } from "../src/lib/agents/diagnosis-schema";

try {
  const model = new ChatOpenAI({
    apiKey: process.env.SITEGUARD_LLM_API_KEY,
    model: process.env.SITEGUARD_LLM_MODEL,
    configuration: { baseURL: process.env.SITEGUARD_LLM_BASE_URL },
    useResponsesApi: false,
    maxTokens: 500,
    timeout: 8_000,
    maxRetries: 1,
  });
  const result = await model.invoke([
    { role: "system", content: "Return only a JSON object with observed_symptoms (strings), probable_causes (objects with cause and evidence_refs), unknowns (strings), confidence (low, medium, high), and next_tool (http_error_analysis, response_time_analysis, incident_history, or null). Use only supplied evidence refs. Do not claim a root cause is confirmed." },
    { role: "user", content: JSON.stringify({
      incident_id: "integration-smoke",
      failure_kind: "http_error",
      evidence: [{ ref: "check:test", observation: "One HTTP 500 health check" }],
    }) },
  ]);
  if (typeof result.content !== "string") throw new Error("Non-text response");
  const text = result.content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const assessment = modelAssessmentSchema.parse(JSON.parse(text));
  console.log(JSON.stringify({ ok: true, valid_assessment: true, next_tool: assessment.next_tool }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error_type: error instanceof Error ? error.name : "unknown" }));
  process.exitCode = 1;
}
