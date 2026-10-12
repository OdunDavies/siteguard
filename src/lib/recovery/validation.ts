import { z } from "zod";
import { uuidSchema } from "@/lib/validation/incident";

export const actionIdSchema = z.literal("reset_demo_service");
export const runRequestSchema = z.strictObject({ idempotency_key: uuidSchema });
export const recoverRequestSchema = runRequestSchema.extend({ authorization_id: uuidSchema });
export const grantRequestSchema = z.strictObject({
  max_uses: z.number().int().min(1).max(2),
  expires_at: z.iso.datetime({ offset: true }).refine((value) => {
    const remaining = Date.parse(value) - Date.now();
    return remaining > 0 && remaining <= 24 * 60 * 60 * 1000;
  }, "Expiration must be within 24 hours"),
});
export const failDemoRequestSchema = z.strictObject({
  reset_behavior: z.enum(["normal", "no_effect", "permanent_failure"]).default("normal"),
});
export const actionInputSchema = z.strictObject({
  action_id: actionIdSchema,
  resource_id: uuidSchema,
  attempt_id: uuidSchema,
});
