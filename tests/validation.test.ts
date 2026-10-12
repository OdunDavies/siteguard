import assert from "node:assert/strict";
import test from "node:test";
import {
  monitoringConfigSchema, parseWebsiteUrl, websiteRegistrationSchema,
  websiteUpdateSchema, websiteUrlSchema,
} from "../src/lib/validation/website";
import { incidentRecordSchema, recoveryActionRequestSchema } from "../src/lib/validation/incident";

test("accepts a normalized public HTTPS website", () => {
  assert.deepEqual(parseWebsiteUrl("https://Example.COM/status"), {
    url: "https://example.com/status",
    host: "example.com",
  });
  assert.equal(websiteRegistrationSchema.parse({ name: "Demo", url: "https://example.com" }).failure_threshold, 2);
});

test("rejects URL forms that cannot be admitted for monitoring", () => {
  for (const url of [
    "http://example.com", "https://localhost", "https://localhost.localdomain",
    "https://127.0.0.1", "https://10.0.0.1", "https://169.254.169.254",
    "https://[::1]", "https://metadata.google.internal", "https://service.local",
    "https://example.com:444", "https://user:pass@example.com", "https://example.com/#part",
    "https://example.com?token=secret", "https://example.com.evil.test",
  ]) {
    assert.equal(websiteUrlSchema.safeParse(url).success, false, url);
  }
});

test("enforces bounded monitoring configuration and nonempty updates", () => {
  assert.equal(monitoringConfigSchema.safeParse({ monitor_interval_seconds: 59, failure_threshold: 2, is_enabled: true }).success, false);
  assert.equal(websiteUpdateSchema.safeParse({}).success, false);
  assert.equal(websiteUpdateSchema.safeParse({ is_enabled: false }).success, true);
  assert.equal(websiteUpdateSchema.safeParse({ owner_user_id: crypto.randomUUID() }).success, false);
});

test("incident and recovery records require known states and actions", () => {
  const id = crypto.randomUUID();
  assert.equal(incidentRecordSchema.safeParse({
    id, website_id: id, status: "open", started_at: new Date().toISOString(),
    resolved_at: null, failure_kind: null, summary: null, consecutive_failures: 1,
    last_check_id: null,
  }).success, true);
  assert.equal(recoveryActionRequestSchema.safeParse({
    incident_id: id, authorization_id: id, action_id: "shell_exec",
    resource_id: "demo", idempotency_key: id,
  }).success, false);
});
