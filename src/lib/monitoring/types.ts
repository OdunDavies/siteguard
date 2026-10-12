export type FailureKind =
  | "http_error" | "dns_error" | "connection_error" | "timeout"
  | "unsafe_destination" | "redirect_error" | "response_too_large";

export type MonitorObservation = {
  status: "healthy" | "unhealthy" | "error";
  httpStatus: number | null;
  latencyMs: number;
  failureKind: FailureKind | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type RecordedCheck = {
  check_id: string;
  incident_id: string | null;
  incident_status: string | null;
};
