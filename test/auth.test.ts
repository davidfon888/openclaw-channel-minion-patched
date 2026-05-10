import { describe, it, expect } from "vitest";
import type { IncomingMessage } from "node:http";
import { createHmac } from "node:crypto";
import { extractBearer, constantTimeEqual } from "../src/auth/bearer.js";
import { isTimestampFresh } from "../src/auth/timestamp.js";
import { signHandshake, verifyHandshake } from "../src/auth/hmac.js";
import { isAllowed } from "../src/auth/allowlist.js";
import { RateLimiter } from "../src/auth/rate-limit.js";
import { makeAuthGate } from "../src/auth/index.js";
import type { ResolvedConfig } from "../src/config.js";

function fakeReq(headers: Record<string, string>, ip = "127.0.0.1"): IncomingMessage {
  return {
    headers,
    socket: { remoteAddress: ip },
  } as unknown as IncomingMessage;
}

describe("bearer", () => {
  it("extracts token", () => {
    expect(extractBearer("Bearer abc123")).toBe("abc123");
    expect(extractBearer("bearer xyz")).toBe("xyz");
    expect(extractBearer("  Bearer  spaced  ")).toBe("spaced");
  });
  it("rejects malformed", () => {
    expect(extractBearer(undefined)).toBeNull();
    expect(extractBearer("Basic abc")).toBeNull();
    expect(extractBearer("")).toBeNull();
  });
  it("constant-time compares correctly", () => {
    expect(constantTimeEqual("foo", "foo")).toBe(true);
    expect(constantTimeEqual("foo", "bar")).toBe(false);
    expect(constantTimeEqual("foo", "fooo")).toBe(false);
  });
});

describe("timestamp", () => {
  it("accepts within tolerance", () => {
    const now = 1_000_000;
    expect(isTimestampFresh(String(now), 60, now)).toBe(true);
    expect(isTimestampFresh(String(now - 30), 60, now)).toBe(true);
    expect(isTimestampFresh(String(now + 30), 60, now)).toBe(true);
  });
  it("rejects stale or future-skewed", () => {
    const now = 1_000_000;
    expect(isTimestampFresh(String(now - 120), 60, now)).toBe(false);
    expect(isTimestampFresh(String(now + 120), 60, now)).toBe(false);
  });
  it("rejects garbage", () => {
    expect(isTimestampFresh(undefined, 60)).toBe(false);
    expect(isTimestampFresh("hello", 60)).toBe(false);
    expect(isTimestampFresh("", 60)).toBe(false);
  });
});

describe("hmac", () => {
  it("signs and verifies round-trip", () => {
    const sig = signHandshake("secret", "AA:BB", "uuid-1", "1000");
    expect(verifyHandshake("secret", "AA:BB", "uuid-1", "1000", sig)).toBe(true);
  });
  it("rejects wrong secret", () => {
    const sig = signHandshake("secret", "AA:BB", "uuid-1", "1000");
    expect(verifyHandshake("other", "AA:BB", "uuid-1", "1000", sig)).toBe(false);
  });
  it("rejects tampered fields", () => {
    const sig = signHandshake("secret", "AA:BB", "uuid-1", "1000");
    expect(verifyHandshake("secret", "AA:CC", "uuid-1", "1000", sig)).toBe(false);
    expect(verifyHandshake("secret", "AA:BB", "uuid-2", "1000", sig)).toBe(false);
    expect(verifyHandshake("secret", "AA:BB", "uuid-1", "1001", sig)).toBe(false);
  });
  it("rejects missing signature", () => {
    expect(verifyHandshake("secret", "AA", "u", "1", undefined)).toBe(false);
  });
});

describe("allowlist", () => {
  it("empty list allows everything", () => {
    expect(isAllowed("1.2.3.4", [])).toBe(true);
  });
  it("matches exact IPs", () => {
    expect(isAllowed("192.168.1.5", ["192.168.1.5"])).toBe(true);
    expect(isAllowed("192.168.1.6", ["192.168.1.5"])).toBe(false);
  });
  it("matches CIDR", () => {
    expect(isAllowed("192.168.1.50", ["192.168.1.0/24"])).toBe(true);
    expect(isAllowed("192.168.2.50", ["192.168.1.0/24"])).toBe(false);
    expect(isAllowed("10.0.0.1", ["10.0.0.0/8"])).toBe(true);
    expect(isAllowed("11.0.0.1", ["10.0.0.0/8"])).toBe(false);
  });
  it("strips IPv4-mapped IPv6 prefix", () => {
    expect(isAllowed("::ffff:192.168.1.5", ["192.168.1.0/24"])).toBe(true);
  });
});

describe("rate-limit", () => {
  it("allows up to limit per window", () => {
    const rl = new RateLimiter(3);
    const t = 1000;
    expect(rl.hit("dev", t)).toBe(true);
    expect(rl.hit("dev", t)).toBe(true);
    expect(rl.hit("dev", t)).toBe(true);
    expect(rl.hit("dev", t)).toBe(false);
  });
  it("resets at next window", () => {
    const rl = new RateLimiter(2);
    expect(rl.hit("dev", 1000)).toBe(true);
    expect(rl.hit("dev", 1000)).toBe(true);
    expect(rl.hit("dev", 1000)).toBe(false);
    expect(rl.hit("dev", 1060)).toBe(true);
  });
  it("isolates per key", () => {
    const rl = new RateLimiter(1);
    expect(rl.hit("a", 1000)).toBe(true);
    expect(rl.hit("a", 1000)).toBe(false);
    expect(rl.hit("b", 1000)).toBe(true);
  });
});

describe("auth gate", () => {
  function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
    return {
      port: 8788,
      path: "/minion",
      requireHmac: false,
      timestampToleranceSec: 60,
      rateLimit: { perDevicePerMinute: 100 },
      devices: new Map([
        ["mac-001", {
          deviceId: "mac-001",
          secret: "supersecret",
          sessionKey: "agent:main:mac-001",
          allowedIps: [],
        }],
      ]),
      ...overrides,
    };
  }

  it("accepts valid bearer-only handshake", () => {
    const gate = makeAuthGate(makeConfig());
    const r = gate(fakeReq({
      "device-id": "mac-001",
      "client-id": "uuid-aaa",
      "protocol-version": "1",
      "authorization": "Bearer supersecret",
    }));
    expect(r.ok).toBe(true);
  });

  it("rejects unknown device", () => {
    const gate = makeAuthGate(makeConfig());
    const r = gate(fakeReq({
      "device-id": "mac-999",
      "client-id": "uuid-aaa",
      "protocol-version": "1",
      "authorization": "Bearer supersecret",
    }));
    expect(r).toEqual({ ok: false, reason: "unknown_device" });
  });

  it("rejects bad token", () => {
    const gate = makeAuthGate(makeConfig());
    const r = gate(fakeReq({
      "device-id": "mac-001",
      "client-id": "uuid-aaa",
      "protocol-version": "1",
      "authorization": "Bearer wrong",
    }));
    expect(r).toEqual({ ok: false, reason: "bad_token" });
  });

  it("requires HMAC in strict mode", () => {
    const gate = makeAuthGate(makeConfig({ requireHmac: true }));
    const r = gate(fakeReq({
      "device-id": "mac-001",
      "client-id": "uuid-aaa",
      "protocol-version": "1",
      "authorization": "Bearer supersecret",
    }));
    expect(r.ok).toBe(false);
  });

  it("accepts HMAC in strict mode with valid signature", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac("sha256", "supersecret")
      .update(`mac-001\nuuid-aaa\n${ts}`)
      .digest("hex");
    const gate = makeAuthGate(makeConfig({ requireHmac: true }));
    const r = gate(fakeReq({
      "device-id": "mac-001",
      "client-id": "uuid-aaa",
      "protocol-version": "1",
      "authorization": "Bearer supersecret",
      "x-timestamp": ts,
      "x-signature": sig,
    }));
    expect(r.ok).toBe(true);
  });

  it("blocks IPs outside allowlist", () => {
    const cfg = makeConfig();
    cfg.devices.get("mac-001")!.allowedIps = ["10.0.0.0/8"];
    const gate = makeAuthGate(cfg);
    const r = gate(fakeReq({
      "device-id": "mac-001",
      "client-id": "uuid-aaa",
      "protocol-version": "1",
      "authorization": "Bearer supersecret",
    }, "192.168.1.1"));
    expect(r).toEqual({ ok: false, reason: "ip_blocked" });
  });

  it("rate limits after threshold", () => {
    const gate = makeAuthGate(makeConfig({ rateLimit: { perDevicePerMinute: 2 } }));
    const headers = {
      "device-id": "mac-001",
      "client-id": "uuid-aaa",
      "protocol-version": "1",
      "authorization": "Bearer supersecret",
    };
    expect(gate(fakeReq(headers)).ok).toBe(true);
    expect(gate(fakeReq(headers)).ok).toBe(true);
    expect(gate(fakeReq(headers))).toEqual({ ok: false, reason: "rate_limited" });
  });
});
