import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../src/lib/api/errors";
import {
  createPinnedLookup, isPublicAddress, MonitorNetworkError, performHealthCheck,
  type NetworkDependencies,
} from "../src/lib/monitoring/network";
import { runMonitoringCheck } from "../src/lib/monitoring/service";
import type { SupabaseClient } from "@supabase/supabase-js";

const example = "https://example.com/health";
const publicIp = "93.184.215.14";

function fakeNetwork(statusCode: number): NetworkDependencies {
  return {
    resolve: async () => [publicIp],
    requestHop: async () => ({ statusCode }),
  };
}

test("records successful and HTTP 500 observations without downloading a real response", async () => {
  const success = await performHealthCheck(example, {}, fakeNetwork(200));
  assert.equal(success.status, "healthy");
  assert.equal(success.httpStatus, 200);
  const failed = await performHealthCheck(example, {}, fakeNetwork(500));
  assert.equal(failed.status, "unhealthy");
  assert.equal(failed.failureKind, "http_error");
  assert.equal(failed.errorMessage, "HTTP 500");
});

test("classifies a received HTTP 503 as an HTTP failure", async () => {
  const failed = await performHealthCheck(example, {}, fakeNetwork(503));
  assert.equal(failed.status, "unhealthy");
  assert.equal(failed.httpStatus, 503);
  assert.equal(failed.failureKind, "http_error");
  assert.equal(failed.errorCode, "HTTP_ERROR");
});

test("classifies timeout and connection failure without exposing transport details", async () => {
  const timeout = await performHealthCheck(example, {}, {
    resolve: async () => [publicIp],
    requestHop: async () => { throw Object.assign(new Error("private detail"), { code: "MONITOR_TIMEOUT" }); },
  });
  assert.equal(timeout.failureKind, "timeout");
  assert.equal(timeout.errorMessage?.includes("private detail"), false);

  const connection = await performHealthCheck(example, {}, {
    resolve: async () => [publicIp],
    requestHop: async () => { throw new Error("private socket detail"); },
  });
  assert.equal(connection.failureKind, "connection_error");
  assert.equal(connection.errorMessage, "Connection failed");
});

test("rejects local, private, mapped, and metadata destinations", async () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "100.64.0.1", "::1", "fc00::1", "::ffff:169.254.169.254"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("8.8.8.8"), true);

  let requested = false;
  const unsafe = await performHealthCheck("https://localhost/health", {}, {
    resolve: async () => { throw new Error("should not resolve"); },
    requestHop: async () => { requested = true; return { statusCode: 200 }; },
  });
  assert.equal(unsafe.failureKind, "unsafe_destination");
  assert.equal(requested, false);
});

test("validates every redirect before a second request", async () => {
  let requests = 0;
  const result = await performHealthCheck(example, {}, {
    resolve: async () => [publicIp],
    requestHop: async () => {
      requests++;
      return { statusCode: 302, location: "http://169.254.169.254/latest/meta-data" };
    },
  });
  assert.equal(result.failureKind, "unsafe_destination");
  assert.equal(requests, 1);
});

test("applies the configured host allowlist to redirect destinations", async () => {
  let requests = 0;
  const result = await performHealthCheck(example, { allowedHosts: ["example.com"] }, {
    resolve: async () => [publicIp],
    requestHop: async () => {
      requests++;
      return { statusCode: 302, location: "https://other-public.example.org/health" };
    },
  });
  assert.equal(result.errorCode, "HOST_NOT_ALLOWED");
  assert.equal(requests, 1);
});

test("rejects a rebinding answer and pins the selected connection address", async () => {
  let resolutions = 0;
  let requests = 0;
  const result = await performHealthCheck(example, {}, {
    resolve: async () => ++resolutions === 1 ? [publicIp] : ["10.0.0.1"],
    requestHop: async (_url, address) => {
      requests++;
      assert.equal(address, publicIp);
      return { statusCode: 302, location: example };
    },
  });
  assert.equal(result.failureKind, "unsafe_destination");
  assert.equal(requests, 1);
  assert.equal(resolutions, 2);

  const lookup = createPinnedLookup("example.com", publicIp);
  lookup("example.com", {}, (error, address, family) => {
    assert.equal(error, null);
    assert.equal(address, publicIp);
    assert.equal(family, 4);
  });
});

test("pinned lookup returns the single validated IPv4 or IPv6 address in Node's requested shape", () => {
  for (const [address, family] of [[publicIp, 4], ["2606:4700:4700::1111", 6]] as const) {
    const lookup = createPinnedLookup("example.com", address);
    lookup("example.com", { family }, (error, result, resultFamily) => {
      assert.equal(error, null);
      assert.equal(result, address);
      assert.equal(resultFamily, family);
    });
    lookup("example.com", { all: true, family }, (error, result) => {
      assert.equal(error, null);
      assert.deepEqual(result, [{ address, family }]);
    });
    lookup("example.com", { all: true }, (error, result) => {
      assert.equal(error, null);
      assert.deepEqual(result, [{ address, family }]);
    });
  }
});

test("pinned lookup fails closed on wrong host, family mismatch, and invalid family", () => {
  const lookup = createPinnedLookup("example.com", publicIp);
  for (const [host, options] of [
    ["other.example.com", { all: true }],
    ["example.com", { family: 6 }],
    ["example.com", { all: true, family: 7 }],
  ] as const) {
    lookup(host, options, (error, result) => {
      assert.ok(error);
      assert.deepEqual(result, options.all ? [] : "");
    });
  }
  assert.throws(() => createPinnedLookup("example.com", "10.0.0.1"), MonitorNetworkError);
  assert.throws(() => createPinnedLookup("example.com", "169.254.169.254"), MonitorNetworkError);
});

test("a mixed public and private DNS answer never reaches a socket", async () => {
  let requested = false;
  const result = await performHealthCheck(example, {}, {
    resolve: async () => [publicIp, "10.0.0.1"],
    requestHop: async () => { requested = true; return { statusCode: 503 }; },
  });
  assert.equal(result.errorCode, "UNSAFE_ADDRESS");
  assert.equal(requested, false);
});

test("enforces response size errors from the pinned request adapter", async () => {
  const result = await performHealthCheck(example, {}, {
    resolve: async () => [publicIp],
    requestHop: async () => { throw new MonitorNetworkError("response_too_large", "RESPONSE_TOO_LARGE", "Response body limit exceeded"); },
  });
  assert.equal(result.failureKind, "response_too_large");
});

test("manual claims carry the owner identity and persist the result", async () => {
  const websiteId = crypto.randomUUID();
  const ownerId = crypto.randomUUID();
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const worker = { async rpc(name: string, args: Record<string, unknown>) {
    calls.push({ name, args });
    if (name === "monitor_claim_check") return { data: [{
      lease_token: crypto.randomUUID(), website_url: example, claimed_at: new Date().toISOString(),
    }], error: null };
    return { data: [{ check_id: crypto.randomUUID(), incident_id: null, incident_status: null }], error: null };
  } } as unknown as SupabaseClient;
  const result = await runMonitoringCheck(worker, websiteId, "manual", ownerId, async () => ({
    status: "healthy", httpStatus: 200, latencyMs: 12,
    failureKind: null, errorCode: null, errorMessage: null,
  }));
  assert.equal(result.observation.status, "healthy");
  assert.equal(calls[0].name, "monitor_claim_check");
  assert.equal(calls[0].args.p_owner_id, ownerId);
  assert.equal(calls[1].name, "monitor_record_check");
  assert.equal(calls[1].args.p_status, "healthy");
});

test("a refused claim rate-limits manual checks without making a request", async () => {
  const worker = { async rpc() { return { data: [], error: null }; } } as unknown as SupabaseClient;
  let requested = false;
  await assert.rejects(
    runMonitoringCheck(worker, crypto.randomUUID(), "manual", crypto.randomUUID(), async () => {
      requested = true;
      throw new Error("unreachable");
    }),
    (error: unknown) => error instanceof ApiError && error.status === 429,
  );
  assert.equal(requested, false);
});
