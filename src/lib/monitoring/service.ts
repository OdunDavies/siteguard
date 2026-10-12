import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "@/lib/api/errors";
import { logEvent } from "@/lib/logging";
import { performHealthCheck } from "./network";
import type { MonitorObservation, RecordedCheck } from "./types";

type Claim = { lease_token: string; website_url: string; claimed_at: string };

export async function runMonitoringCheck(
  worker: SupabaseClient,
  websiteId: string,
  mode: "manual" | "scheduled",
  ownerId: string | null,
  check?: (url: string) => Promise<MonitorObservation>,
): Promise<{ observation: MonitorObservation; record: RecordedCheck }> {
  const timeoutMs = configuredTimeoutMs();
  const allowedHosts = process.env.MONITOR_ALLOWLIST_HOSTS?.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (process.env.MONITOR_ALLOWLIST_HOSTS !== undefined && !allowedHosts?.length) {
    throw new ApiError(500, "MONITOR_CONFIG_ERROR", "Monitoring allowlist is invalid");
  }
  const execute = check ?? ((url: string) => performHealthCheck(url, { timeoutMs, allowedHosts }));
  const { data: claimData, error: claimError } = await worker.rpc("monitor_claim_check", {
    p_website_id: websiteId,
    p_mode: mode,
    p_owner_id: ownerId,
  });
  if (claimError) throw new ApiError(500, "DATABASE_ERROR", "Could not claim monitoring check");
  const claim = (claimData as Claim[] | null)?.[0];
  if (!claim) {
    throw new ApiError(mode === "manual" ? 429 : 409, "CHECK_NOT_DUE", "Check is unavailable or rate limited");
  }

  let observation: MonitorObservation;
  let hostname: string | null = null;
  try { hostname = new URL(claim.website_url).hostname.toLowerCase(); } catch { /* The checker will reject it. */ }
  if (allowedHosts && (!hostname || !allowedHosts.includes(hostname))) {
    observation = {
      status: "error", httpStatus: null, latencyMs: 0,
      failureKind: "unsafe_destination", errorCode: "HOST_NOT_ALLOWED",
      errorMessage: "Host is outside the monitoring allowlist",
    };
  } else {
    try {
      observation = await execute(claim.website_url);
    } catch {
      observation = {
        status: "error", httpStatus: null, latencyMs: 0,
        failureKind: "connection_error", errorCode: "CHECK_FAILED",
        errorMessage: "Monitoring check failed",
      };
    }
  }

  const { data: recordData, error: recordError } = await worker.rpc("monitor_record_check", {
    p_website_id: websiteId,
    p_lease_token: claim.lease_token,
    p_claimed_at: claim.claimed_at,
    p_status: observation.status,
    p_http_status: observation.httpStatus,
    p_latency_ms: observation.latencyMs,
    p_failure_kind: observation.failureKind,
    p_error_code: observation.errorCode,
    p_error_message: observation.errorMessage,
  });
  if (recordError) throw new ApiError(500, "DATABASE_ERROR", "Could not record monitoring check");
  const record = (recordData as RecordedCheck[] | null)?.[0];
  if (!record) throw new ApiError(500, "DATABASE_ERROR", "Monitoring result was not returned");

  logEvent("info", "monitor.check_recorded", {
    website_id: websiteId,
    check_id: record.check_id,
    incident_id: record.incident_id,
    status: observation.status,
    failure_kind: observation.failureKind,
  });
  return { observation, record };
}

function configuredTimeoutMs(): number {
  const raw = process.env.MONITOR_TIMEOUT_MS;
  if (!raw) return 8_000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1_000 || value > 20_000) {
    throw new ApiError(500, "MONITOR_CONFIG_ERROR", "Monitoring timeout is invalid");
  }
  return value;
}
