import type { ApiContext } from "@/lib/api/context";
import { agentTelemetry, type AgentTelemetry } from "@/lib/observability/agent-telemetry";
import { requireOwnedWebsite } from "@/lib/database/repository";
import type { HealthCheck, Incident } from "@/types/domain";
import type { DiagnosticToolId } from "./diagnosis-schema";

export type ToolName = DiagnosticToolId | "monitoring_history" | "service_metadata";
export type DiagnosticToolResult = {
  tool: ToolName;
  ok: boolean;
  code: "OK" | "NO_DATA" | "TOOL_FAILED" | "TOOL_TIMEOUT";
  evidence: Array<{ ref: string; observation: string }>;
  data: Record<string, string | number | boolean | null | undefined>;
  checks?: HealthCheck[];
};

const toolFailure = (tool: ToolName, code: "TOOL_FAILED" | "TOOL_TIMEOUT"): DiagnosticToolResult => ({
  tool, ok: false, code, evidence: [], data: {},
});

async function bounded<T>(operation: () => Promise<T>, timeoutMs = 4_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("Tool timed out"), { code: "TOOL_TIMEOUT" })), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createDiagnosticTools(ctx: ApiContext, websiteId: string,
  telemetry: AgentTelemetry = agentTelemetry) {
  async function execute(tool: ToolName, history: HealthCheck[] = []): Promise<DiagnosticToolResult> {
    return telemetry.stage(`diagnosis.tool.${tool}`, "TOOL", {
      "siteguard.website_id": websiteId,
      "neatlogs.tool.name": tool,
    }, async (span) => {
      try {
        const result = await bounded<DiagnosticToolResult>(async () => {
        await requireOwnedWebsite(ctx, websiteId);
        switch (tool) {
          case "monitoring_history": {
            const { data, error } = await ctx.supabase.from("health_checks")
              .select("*")
              .eq("website_id", websiteId).order("checked_at", { ascending: false }).limit(20);
            if (error) throw error;
            const rows = (data ?? []) as HealthCheck[];
            return {
              tool, ok: true, code: rows.length ? "OK" : "NO_DATA",
              evidence: rows.slice(0, 5).map((row) => ({
                ref: `check:${row.id}`,
                observation: `${row.status}; HTTP ${row.http_status ?? "unknown"}; ${row.failure_kind ?? "no failure category"}; ${row.latency_ms ?? "unknown"} ms`,
              })),
              data: { count: rows.length },
              checks: rows,
            };
          }
          case "service_metadata": {
            const website = await requireOwnedWebsite(ctx, websiteId);
            return {
              tool, ok: true, code: "OK", evidence: [{
                ref: `site:${websiteId}`,
                observation: `Interval ${website.monitor_interval_seconds} s; failure threshold ${website.failure_threshold}; recovery threshold ${website.recovery_threshold}; enabled ${website.is_enabled}`,
              }],
              data: { interval_seconds: website.monitor_interval_seconds, failure_threshold: website.failure_threshold, recovery_threshold: website.recovery_threshold, is_enabled: website.is_enabled },
            };
          }
          case "http_error_analysis": {
            const counts = new Map<number, number>();
            for (const row of history) if (row.http_status !== null) counts.set(row.http_status, (counts.get(row.http_status) ?? 0) + 1);
            const summary = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5)
              .map(([status, count]) => `${status}: ${count}`).join(", ");
            return {
              tool, ok: true, code: summary ? "OK" : "NO_DATA",
              evidence: summary ? [{ ref: "pattern:http", observation: `Recent HTTP status counts: ${summary}` }] : [],
              data: { statuses: counts.size, checks: history.length },
            };
          }
          case "response_time_analysis": {
            const latencies = history.map((row) => row.latency_ms).filter((value): value is number => value !== null && value >= 0);
            const recent = latencies.slice(0, 5);
            const older = latencies.slice(5, 15);
            const average = (values: number[]) => values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
            const recentAverage = average(recent);
            const olderAverage = average(older);
            return {
              tool, ok: true, code: recentAverage === null ? "NO_DATA" : "OK",
              evidence: recentAverage === null ? [] : [{ ref: "pattern:latency", observation: `Recent mean ${recentAverage} ms; earlier mean ${olderAverage ?? "unavailable"} ms; ${latencies.length} measurements` }],
              data: { recent_mean_ms: recentAverage, earlier_mean_ms: olderAverage, samples: latencies.length },
            };
          }
          case "incident_history": {
            const { data, error } = await ctx.supabase.from("incidents")
              .select("id,website_id,status,started_at,resolved_at,failure_kind,consecutive_failures")
              .eq("website_id", websiteId).order("started_at", { ascending: false }).limit(10);
            if (error) throw error;
            const rows = (data ?? []) as Incident[];
            return {
              tool, ok: true, code: rows.length ? "OK" : "NO_DATA",
              evidence: rows.slice(0, 5).map((row) => ({
                ref: `incident:${row.id}`,
                observation: `${row.status}; category ${row.failure_kind ?? "unknown"}; ${row.consecutive_failures} consecutive failures; resolved ${row.resolved_at ? "yes" : "no"}`,
              })),
              data: { count: rows.length },
            };
          }
        }
        });
        span?.setAttribute("siteguard.tool_outcome", result.code);
        return result;
      } catch (error) {
        const result = toolFailure(tool, (error as { code?: string }).code === "TOOL_TIMEOUT" ? "TOOL_TIMEOUT" : "TOOL_FAILED");
        span?.setAttribute("siteguard.tool_outcome", result.code);
        span?.setStatus({ code: 2, message: result.code });
        return result;
      }
    });
  }
  return { execute };
}
