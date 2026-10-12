import { resolve4, resolve6 } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { parseWebsiteUrl } from "@/lib/validation/website";
import type { FailureKind, MonitorObservation } from "./types";

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 16 * 1024;

export class MonitorNetworkError extends Error {
  constructor(public readonly kind: FailureKind, public readonly safeCode: string, message: string) {
    super(message);
  }
}

export type HopResult = { statusCode: number; location?: string };
export type NetworkDependencies = {
  resolve: (hostname: string) => Promise<string[]>;
  requestHop: (url: URL, address: string, timeoutMs: number, maxBytes: number) => Promise<HopResult>;
};

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 0) return false;
  try {
    // Reject all special-use ranges, including mapped IPv4, carrier NAT and metadata ranges.
    return ipaddr.parse(address).range() === "unicast";
  } catch {
    return false;
  }
}

function safeUrl(raw: string): URL {
  let candidate: URL;
  try {
    candidate = new URL(raw);
  } catch {
    throw new MonitorNetworkError("unsafe_destination", "UNSAFE_URL", "Unsafe website URL");
  }
  if (candidate.protocol !== "https:" && candidate.protocol !== "http:") {
    throw new MonitorNetworkError("unsafe_destination", "UNSAFE_URL", "Unsupported URL protocol");
  }
  // Registration is HTTPS-only; controlled HTTP targets and redirects use the same host rules.
  const equivalentHttps = candidate.protocol === "http:"
    ? `https://${raw.slice("http://".length)}` : raw;
  if (!parseWebsiteUrl(equivalentHttps)) {
    throw new MonitorNetworkError("unsafe_destination", "UNSAFE_URL", "Unsafe website URL");
  }
  return candidate;
}

export async function resolvePublicAddresses(hostname: string): Promise<string[]> {
  const results = await Promise.allSettled([resolve4(hostname), resolve6(hostname)]);
  const addresses: string[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      addresses.push(...result.value);
    } else {
      const code = (result.reason as NodeJS.ErrnoException).code;
      if (code !== "ENODATA" && code !== "ENOTFOUND") {
        throw new MonitorNetworkError("dns_error", "DNS_FAILED", "DNS resolution failed");
      }
    }
  }
  if (addresses.length === 0) {
    throw new MonitorNetworkError("dns_error", "DNS_FAILED", "DNS resolution failed");
  }
  if (addresses.some((address) => !isPublicAddress(address))) {
    throw new MonitorNetworkError("unsafe_destination", "UNSAFE_ADDRESS", "DNS returned an unsafe address");
  }
  return addresses;
}

export function createPinnedLookup(hostname: string, address: string): LookupFunction {
  const family = isIP(address);
  if (!family || !isPublicAddress(address)) {
    throw new MonitorNetworkError("unsafe_destination", "UNSAFE_ADDRESS", "Unsafe destination address");
  }
  return (requestedHost, options, callback) => {
    const emptyResult = options.all ? [] : "";
    if (requestedHost !== hostname) {
      callback(Object.assign(new Error("Hostname changed"), { code: "EHOSTUNREACH" }), emptyResult, 0);
      return;
    }
    const requestedFamily = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family ?? 0;
    if (requestedFamily !== 0 && requestedFamily !== family) {
      callback(Object.assign(new Error("Address family changed"), { code: "EAI_ADDRFAMILY" }), emptyResult, 0);
      return;
    }
    // Node's connect path may request all:true; return only the validated, pinned IP.
    callback(null, options.all ? [{ address, family }] : address, family);
  };
}

export function requestPinnedHop(url: URL, address: string, timeoutMs: number, maxBytes: number): Promise<HopResult> {
  return new Promise((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(url, {
      method: "GET",
      agent: false,
      lookup: createPinnedLookup(url.hostname, address),
      servername: url.hostname,
      timeout: timeoutMs,
      headers: {
        "User-Agent": "SiteGuard-Monitor/1.0",
        "Accept-Encoding": "identity",
        Range: `bytes=0-${maxBytes - 1}`,
        Connection: "close",
      },
    }, (res) => {
      const statusCode = res.statusCode ?? 0;
      const location = res.headers.location;
      if (statusCode >= 300 && statusCode < 400) {
        res.destroy();
        resolve({ statusCode, location });
        return;
      }

      let received = 0;
      res.on("data", (chunk: Buffer) => {
        received += chunk.byteLength;
        if (received > maxBytes) {
          res.destroy();
          reject(new MonitorNetworkError("response_too_large", "RESPONSE_TOO_LARGE", "Response body limit exceeded"));
        }
      });
      res.on("end", () => resolve({ statusCode }));
      res.on("error", reject);
    });
    // A socket inactivity timeout alone does not bound a slow streaming response.
    const deadline = setTimeout(() => req.destroy(Object.assign(new Error("Timed out"), { code: "MONITOR_TIMEOUT" })), timeoutMs);
    req.on("close", () => clearTimeout(deadline));
    req.on("timeout", () => req.destroy(Object.assign(new Error("Timed out"), { code: "MONITOR_TIMEOUT" })));
    req.on("error", reject);
    req.end();
  });
}

function withDeadline<T>(operation: Promise<T>, remainingMs: number): Promise<T> {
  if (remainingMs <= 0) {
    throw new MonitorNetworkError("timeout", "MONITOR_TIMEOUT", "Monitoring deadline exceeded");
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new MonitorNetworkError("timeout", "MONITOR_TIMEOUT", "Monitoring deadline exceeded")), remainingMs);
    operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

const defaultDependencies: NetworkDependencies = {
  resolve: resolvePublicAddresses,
  requestHop: requestPinnedHop,
};

export async function performHealthCheck(
  rawUrl: string,
  options: { timeoutMs?: number; maxResponseBytes?: number; maxRedirects?: number; allowedHosts?: string[] } = {},
  dependencies: NetworkDependencies = defaultDependencies,
): Promise<MonitorObservation> {
  const started = Date.now();
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
  const maxBytes = Math.min(Math.max(options.maxResponseBytes ?? MAX_RESPONSE_BYTES, 1), MAX_RESPONSE_BYTES);
  const maxRedirects = Math.min(Math.max(options.maxRedirects ?? MAX_REDIRECTS, 0), MAX_REDIRECTS);
  const deadline = started + timeoutMs;
  let current = rawUrl;

  try {
    for (let redirects = 0; redirects <= maxRedirects; redirects++) {
      const url = safeUrl(current);
      if (options.allowedHosts && !options.allowedHosts.includes(url.hostname.toLowerCase())) {
        throw new MonitorNetworkError("unsafe_destination", "HOST_NOT_ALLOWED", "Host is outside the monitoring allowlist");
      }
      const addresses = await withDeadline(dependencies.resolve(url.hostname), deadline - Date.now());
      if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
        throw new MonitorNetworkError("unsafe_destination", "UNSAFE_ADDRESS", "Unsafe destination address");
      }
      // The request adapter receives the validated address. The production adapter pins
      // its socket lookup to that IP and keeps the original hostname for Host/TLS checks.
      const hop = await withDeadline(
        dependencies.requestHop(url, addresses[0], deadline - Date.now(), maxBytes),
        deadline - Date.now(),
      );
      if (hop.statusCode >= 300 && hop.statusCode < 400) {
        if (!hop.location || redirects === maxRedirects) {
          throw new MonitorNetworkError("redirect_error", "REDIRECT_LIMIT", "Redirect limit reached");
        }
        current = new URL(hop.location, url).toString();
        continue;
      }
      const healthy = hop.statusCode >= 200 && hop.statusCode < 400;
      return {
        status: healthy ? "healthy" : "unhealthy",
        httpStatus: hop.statusCode || null,
        latencyMs: Date.now() - started,
        failureKind: healthy ? null : "http_error",
        errorCode: healthy ? null : "HTTP_ERROR",
        errorMessage: healthy ? null : `HTTP ${hop.statusCode}`,
      };
    }
    throw new MonitorNetworkError("redirect_error", "REDIRECT_LIMIT", "Redirect limit reached");
  } catch (error) {
    const known = error instanceof MonitorNetworkError ? error : null;
    const code = (error as NodeJS.ErrnoException).code;
    const timeout = code === "MONITOR_TIMEOUT" || code === "ETIMEDOUT";
    return {
      status: "error",
      httpStatus: null,
      latencyMs: Date.now() - started,
      failureKind: known?.kind ?? (timeout ? "timeout" : "connection_error"),
      errorCode: known?.safeCode ?? (timeout ? "MONITOR_TIMEOUT" : "CONNECTION_FAILED"),
      errorMessage: known?.message ?? (timeout ? "Monitoring timed out" : "Connection failed"),
    };
  }
}
