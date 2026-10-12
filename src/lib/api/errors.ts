import { z } from "zod";
import { logEvent } from "@/lib/logging";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function apiResponse(body: unknown, status: number, requestId: string) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store", "X-Request-Id": requestId },
  });
}

export async function handleApi(
  operation: () => Promise<{ data: unknown; status?: number }>,
): Promise<Response> {
  const requestId = crypto.randomUUID();

  try {
    const result = await operation();
    return apiResponse({ data: result.data }, result.status ?? 200, requestId);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return apiResponse({ error: { code: "VALIDATION_ERROR", message: "Invalid request" } }, 400, requestId);
    }

    if (error instanceof ApiError) {
      return apiResponse({ error: { code: error.code, message: error.message } }, error.status, requestId);
    }

    logEvent("error", "api.unexpected_error", { request_id: requestId });
    return apiResponse({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } }, 500, requestId);
  }
}

export async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Expected application/json");
  }

  const maxBytes = 16 * 1024;
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
  }

  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "INVALID_JSON", "Request body is required");
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Malformed JSON body");
  }
}
