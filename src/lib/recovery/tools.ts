import type { SupabaseClient } from "@supabase/supabase-js";
import { actionInputSchema } from "./validation";

export type RecoveryToolResult = {
  action_id: "reset_demo_service";
  attempt_id: string;
  result_code: string;
  retryable: boolean;
};

async function resetDemoService(worker: SupabaseClient, attemptId: string): Promise<{ result_code: string; retryable: boolean }> {
  const operation = worker.rpc("demo_execute_reset", { p_attempt_id: attemptId });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("RECOVERY_TIMEOUT")), 5_000);
      }),
    ]);
    if (result.error) throw new Error("RECOVERY_UNCERTAIN");
    const outcome = (result.data as Array<{ result_code: string; retryable: boolean }> | null)?.[0];
    if (!outcome) throw new Error("RECOVERY_UNCERTAIN");
    return outcome;
  } catch {
    // The RPC may have committed despite a lost response. Mark ambiguity and never replay it.
    await worker.rpc("recovery_mark_unknown", { p_attempt_id: attemptId });
    return { result_code: "UNKNOWN_OUTCOME", retryable: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const registry = { reset_demo_service: resetDemoService } as const;

export async function executeRecoveryTool(worker: SupabaseClient, rawInput: unknown): Promise<RecoveryToolResult> {
  const input = actionInputSchema.parse(rawInput);
  // The database RPC independently ties the attempt, resource, action and grant together.
  const result = await registry[input.action_id](worker, input.attempt_id);
  return { action_id: input.action_id, attempt_id: input.attempt_id, ...result };
}
