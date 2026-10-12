type LogLevel = "info" | "warn" | "error";
type LogFields = Record<string, string | number | boolean | null | undefined>;

// Callers pass identifiers and codes only; never pass request bodies, tokens, or URLs.
export function logEvent(level: LogLevel, event: string, fields: LogFields = {}) {
  const line = JSON.stringify({ level, event, timestamp: new Date().toISOString(), ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}
