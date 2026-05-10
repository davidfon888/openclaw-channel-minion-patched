// HMAC-SHA256 signing and verification for inbound handshakes.
// Signed payload: deviceId + "\n" + clientId + "\n" + timestamp

import { createHmac, timingSafeEqual } from "node:crypto";

export function signHandshake(
  secret: string,
  deviceId: string,
  clientId: string,
  timestamp: string,
): string {
  return createHmac("sha256", secret)
    .update(`${deviceId}\n${clientId}\n${timestamp}`)
    .digest("hex");
}

export function verifyHandshake(
  secret: string,
  deviceId: string,
  clientId: string,
  timestamp: string,
  signatureHex: string | undefined,
): boolean {
  if (!signatureHex) return false;
  const expected = signHandshake(secret, deviceId, clientId, timestamp);
  if (expected.length !== signatureHex.length) return false;
  try {
    return timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(signatureHex, "hex"),
    );
  } catch {
    return false;
  }
}
