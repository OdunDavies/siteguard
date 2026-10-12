export type Website = {
  id: string;
  owner_user_id: string;
  name: string;
  url: string;
  normalized_host: string;
  monitor_interval_seconds: number;
  failure_threshold: number;
  recovery_threshold: number;
  consecutive_failures: number;
  consecutive_successes: number;
  is_enabled: boolean;
  next_check_at: string;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
};

export type HealthCheck = {
  id: string;
  website_id: string;
  scheduled_for: string;
  checked_at: string;
  status: "healthy" | "unhealthy" | "error";
  http_status: number | null;
  latency_ms: number | null;
  failure_kind: string | null;
  error_code: string | null;
  error_message: string | null;
  incident_id: string | null;
};

export type Incident = {
  id: string;
  website_id: string;
  status: "open" | "recovering" | "recovered" | "escalated" | "closed";
  started_at: string;
  resolved_at: string | null;
  failure_kind: string | null;
  summary: string | null;
  consecutive_failures: number;
  last_check_id: string | null;
  created_at: string;
  updated_at: string;
};
