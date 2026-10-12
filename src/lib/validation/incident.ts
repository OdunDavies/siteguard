import { z } from "zod";

export const uuidSchema = z.uuid();

export const incidentRecordSchema = z.strictObject({
  id: uuidSchema,
  website_id: uuidSchema,
  status: z.enum(["open", "recovering", "recovered", "escalated", "closed"]),
  started_at: z.iso.datetime({ offset: true }),
  resolved_at: z.iso.datetime({ offset: true }).nullable(),
  failure_kind: z.string().max(100).nullable(),
  summary: z.string().max(2000).nullable(),
  consecutive_failures: z.number().int().min(1),
  last_check_id: uuidSchema.nullable(),
});

// The executable recovery registry accepts only this fixed controlled action.
export const recoveryActionRequestSchema = z.strictObject({
  incident_id: uuidSchema,
  authorization_id: uuidSchema,
  action_id: z.literal("reset_demo_service"),
  resource_id: uuidSchema,
  idempotency_key: uuidSchema,
});
