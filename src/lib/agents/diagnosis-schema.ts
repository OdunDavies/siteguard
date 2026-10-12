import { z } from "zod";

const shortText = z.string().trim().min(1).max(300);
const evidenceRef = z.string().trim().min(1).max(100);

export const diagnosticToolIdSchema = z.enum([
  "http_error_analysis", "response_time_analysis", "incident_history",
]);

export const modelAssessmentSchema = z.strictObject({
  observed_symptoms: z.array(shortText).max(8),
  probable_causes: z.array(z.strictObject({
    cause: shortText,
    evidence_refs: z.array(evidenceRef).max(8),
  })).max(5),
  unknowns: z.array(shortText).max(8),
  confidence: z.enum(["low", "medium", "high"]),
  next_tool: diagnosticToolIdSchema.nullable(),
});

export const recommendationSchema = z.strictObject({
  action_id: z.enum([
    "retry_health_check", "continue_monitoring", "investigate_deployment",
    "inspect_application_logs", "escalate_human", "request_controlled_reset_approval",
  ]),
  rationale: shortText,
  requires_human_approval: z.boolean(),
});

export const diagnosisSchema = z.strictObject({
  agent_run_id: z.uuid(),
  incident_id: z.uuid(),
  website_id: z.uuid(),
  incident_summary: shortText,
  observed_symptoms: z.array(shortText).max(8),
  probable_causes: z.array(z.strictObject({
    cause: shortText,
    evidence_refs: z.array(evidenceRef).max(8),
  })).max(5),
  supporting_evidence: z.array(z.strictObject({
    ref: evidenceRef,
    observation: shortText,
  })).max(12),
  unknowns: z.array(shortText).max(8),
  confidence: z.enum(["low", "medium", "high"]),
  status: z.enum(["conclusive", "inconclusive"]),
  recommended_recovery_actions: z.array(recommendationSchema).max(4),
  risk_assessment: shortText,
  human_approval_required: z.boolean(),
  diagnosed_at: z.iso.datetime({ offset: true }),
});

export type ModelAssessment = z.infer<typeof modelAssessmentSchema>;
export type Diagnosis = z.infer<typeof diagnosisSchema>;
export type DiagnosticToolId = z.infer<typeof diagnosticToolIdSchema>;
