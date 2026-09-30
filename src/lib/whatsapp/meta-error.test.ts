import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MetaApiError,
  metaErrorStatus,
  metaFetch,
  sendTextMessage,
} from "./meta-api";

// The distinction under test: did Meta *answer*? A 4xx reply is a
// definitive "your request was wrong" and must surface as a client
// error. A timeout or refused connection is the real bad-gateway case.
//
// This matters beyond correctness. Reverse proxies commonly intercept
// upstream 5xx and replace the body with their own error page, so
// returning 502 for a Meta 4xx loses the one thing the caller needs —
// Meta's message — and leaves an unexplained gateway error instead.

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const SEND_ARGS = {
  phoneNumberId: "test-phone",
  accessToken: "test-token",
  to: "1234567890",
  text: "hi",
} as const;

describe("metaErrorStatus", () => {
  it("maps a Meta 4xx onto 422", () => {
    expect(metaErrorStatus(new MetaApiError("nope", { status: 400 }))).toBe(422);
    expect(metaErrorStatus(new MetaApiError("nope", { status: 404 }))).toBe(422);
  });

  it("maps a Meta 5xx onto 502", () => {
    expect(metaErrorStatus(new MetaApiError("boom", { status: 500 }))).toBe(502);
  });

  it("maps an unanswered call onto 502", () => {
    expect(metaErrorStatus(new MetaApiError("timed out"))).toBe(502);
  });

  it("falls back to 502 for a non-Meta error", () => {
    expect(metaErrorStatus(new Error("something else"))).toBe(502);
  });
});

describe("MetaApiError.isClientError", () => {
  it("is true only for a 4xx Meta answered with", () => {
    expect(new MetaApiError("x", { status: 400 }).isClientError).toBe(true);
    expect(new MetaApiError("x", { status: 499 }).isClientError).toBe(true);
    expect(new MetaApiError("x", { status: 500 }).isClientError).toBe(false);
    // No status means Meta never replied — not a client error.
    expect(new MetaApiError("x").isClientError).toBe(false);
  });
});

describe("Graph failures carry Meta's status and code", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("surfaces Meta's message, status and numeric code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(400, {
          error: {
            message: "Template name does not exist in the translation",
            code: 132001,
          },
        }),
      ),
    );

    const err = await sendTextMessage(SEND_ARGS).catch((e) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.message).toMatch(/does not exist/);
    expect(err.status).toBe(400);
    expect(err.code).toBe(132001);
    // This is the whole point: a bad request must not read as a bad gateway.
    expect(metaErrorStatus(err)).toBe(422);
  });

  it("keeps the fallback message when the error body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>gateway</html>", { status: 503 })),
    );

    const err = await sendTextMessage(SEND_ARGS).catch((e) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.status).toBe(503);
    expect(err.code).toBeNull();
    expect(metaErrorStatus(err)).toBe(502);
  });

  it("treats a connection failure as an unanswered call", async () => {
    const connErr = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), {
        code: "ENOTFOUND",
      }),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw connErr;
      }),
    );

    const err = await metaFetch("https://graph.facebook.com/v21.0/x").catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.status).toBeNull();
    // The underlying cause is unwrapped into the message — a bare
    // "fetch failed" is useless for diagnosing an unreachable host.
    expect(err.message).toMatch(/ENOTFOUND/);
    expect(metaErrorStatus(err)).toBe(502);
  });
});
