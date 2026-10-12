import { isIP } from "node:net";
import { z } from "zod";

const blockedSuffixes = [
  ".localhost", ".local", ".internal", ".lan", ".home", ".home.arpa",
  ".arpa", ".onion", ".test", ".invalid", ".example",
];

export function parseWebsiteUrl(value: string): { url: string; host: string } | null {
  if (value.length > 2048 || !/^https:\/\//i.test(value)) return null;

  try {
    const parsed = new URL(value);
    const authority = value.match(/^https:\/\/([^/?#]+)/i)?.[1];
    const host = parsed.hostname.toLowerCase();
    if (
      !authority || authority.includes(":") || authority.includes("@") ||
      parsed.protocol !== "https:" || parsed.username || parsed.password ||
      parsed.hash || parsed.search || parsed.port || isIP(host) !== 0 ||
      host.endsWith(".") || host === "localhost" ||
      host === "localhost.localdomain" || host.endsWith(".localhost.localdomain") ||
      !host.includes(".") ||
      blockedSuffixes.some((suffix) => host.endsWith(suffix)) ||
      !/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/.test(host)
    ) return null;

    return { url: parsed.toString(), host };
  } catch {
    return null;
  }
}

export const websiteUrlSchema = z.string().trim().min(1).max(2048).refine(
  (value) => parseWebsiteUrl(value) !== null,
  "Enter a public HTTPS domain without credentials, a port, or a fragment",
);

export const monitoringConfigSchema = z.strictObject({
  monitor_interval_seconds: z.number().int().min(60).max(86400),
  failure_threshold: z.number().int().min(1).max(5),
  recovery_threshold: z.number().int().min(1).max(5),
  is_enabled: z.boolean(),
});

export const websiteRegistrationSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  url: websiteUrlSchema,
  monitor_interval_seconds: monitoringConfigSchema.shape.monitor_interval_seconds.default(300),
  failure_threshold: monitoringConfigSchema.shape.failure_threshold.default(2),
  recovery_threshold: monitoringConfigSchema.shape.recovery_threshold.default(2),
  is_enabled: monitoringConfigSchema.shape.is_enabled.default(true),
});

export const websiteUpdateSchema = z.strictObject({
  name: z.string().trim().min(1).max(100).optional(),
  monitor_interval_seconds: monitoringConfigSchema.shape.monitor_interval_seconds.optional(),
  failure_threshold: monitoringConfigSchema.shape.failure_threshold.optional(),
  recovery_threshold: monitoringConfigSchema.shape.recovery_threshold.optional(),
  is_enabled: monitoringConfigSchema.shape.is_enabled.optional(),
}).refine((value) => Object.keys(value).length > 0, "Provide at least one setting");
