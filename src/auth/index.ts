// Combined gate that runs every check in the right order and returns a
// structured result so the WS server can pick a precise close code/reason.

import type { IncomingMessage } from "node:http";
import type { ResolvedConfig, ResolvedDevice } from "../config.js";
import { extractBearer, constantTimeEqual } from "./bearer.js";
import { isTimestampFresh } from "./timestamp.js";
import { verifyHandshake } from "./hmac.js";
import { isAllowed } from "./allowlist.js";
import { RateLimiter } from "./rate-limit.js";

export type AuthFailure =
  | "missing_device_id"
  | "missing_client_id"
  | "missing_protocol_version"
  | "unknown_device"
  | "missing_token"
  | "bad_token"
  | "stale_timestamp"
  | "missing_signature"
  | "bad_signature"
  | "ip_blocked"
  | "rate_limited";

export type AuthResult =
  | { ok: true; device: ResolvedDevice; clientId: string }
  | { ok: false; reason: AuthFailure };

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function clientIp(req: IncomingMessage): string {
  // OpenClaw daemon usually fronts with HTTP — accept x-forwarded-for first.
  const xff = header(req, "x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return req.socket.remoteAddress ?? "";
}

export function makeAuthGate(
  config: ResolvedConfig,
): (req: IncomingMessage) => AuthResult {
  const limiter = new RateLimiter(config.rateLimit.perDevicePerMinute);

  return (req: IncomingMessage): AuthResult => {
    const deviceId = header(req, "device-id");
    const clientId = header(req, "client-id");
    const proto = header(req, "protocol-version");
    if (!deviceId) return { ok: false, reason: "missing_device_id" };
    if (!clientId) return { ok: false, reason: "missing_client_id" };
    if (!proto) return { ok: false, reason: "missing_protocol_version" };

    const device = config.devices.get(deviceId);
    if (!device) return { ok: false, reason: "unknown_device" };

    if (!isAllowed(clientIp(req), device.allowedIps)) {
      return { ok: false, reason: "ip_blocked" };
    }

    const token = extractBearer(header(req, "authorization"));
    if (!token) return { ok: false, reason: "missing_token" };
    if (!constantTimeEqual(token, device.secret)) {
      return { ok: false, reason: "bad_token" };
    }

    if (config.requireHmac) {
      const ts = header(req, "x-timestamp");
      const sig = header(req, "x-signature");
      if (!isTimestampFresh(ts, config.timestampToleranceSec)) {
        return { ok: false, reason: "stale_timestamp" };
      }
      if (!sig) return { ok: false, reason: "missing_signature" };
      if (!verifyHandshake(device.secret, deviceId, clientId, ts!, sig)) {
        return { ok: false, reason: "bad_signature" };
      }
    }

    if (!limiter.hit(deviceId)) return { ok: false, reason: "rate_limited" };

    return { ok: true, device, clientId };
  };
}

export const FAILURE_CLOSE_CODES: Record<AuthFailure, number> = {
  missing_device_id: 4400,
  missing_client_id: 4400,
  missing_protocol_version: 4400,
  unknown_device: 4401,
  missing_token: 4401,
  bad_token: 4401,
  stale_timestamp: 4401,
  missing_signature: 4401,
  bad_signature: 4401,
  ip_blocked: 4403,
  rate_limited: 4429,
};
