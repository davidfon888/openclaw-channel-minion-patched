// Channel configuration loader. Resolves SecretRef ({source: env|file|exec}) to
// concrete strings at startup and fails closed when a secret cannot be read.

import { readFileSync } from "node:fs";
import type { AsrConfig } from "./asr/index.js";
import type { TtsConfig } from "./tts/index.js";

export type SecretRef =
  | string
  | { source: "env"; id: string }
  | { source: "file"; id: string };

export interface DeviceConfig {
  secret: SecretRef;
  sessionKey: string;
  allowedIps?: string[];
}

export interface ResolvedDevice {
  deviceId: string;
  secret: string;
  sessionKey: string;
  allowedIps: string[];
}

export interface ChannelConfig {
  port: number;
  path: string;
  requireHmac: boolean;
  timestampToleranceSec: number;
  rateLimit: { perDevicePerMinute: number };
  devices: Record<string, DeviceConfig>;
  asr?: AsrConfig;
  tts?: TtsConfig;
}

export interface ResolvedConfig {
  port: number;
  path: string;
  requireHmac: boolean;
  timestampToleranceSec: number;
  rateLimit: { perDevicePerMinute: number };
  devices: Map<string, ResolvedDevice>;
  asr: AsrConfig | null;
  tts: TtsConfig | null;
}

export function resolveSecret(ref: SecretRef): string {
  if (typeof ref === "string") return ref;
  if (ref.source === "env") {
    const v = process.env[ref.id];
    if (!v) throw new Error(`Secret env var "${ref.id}" is not set`);
    return v;
  }
  if (ref.source === "file") {
    return readFileSync(ref.id, "utf8").trim();
  }
  throw new Error(`Unknown secret source`);
}

export function resolveConfig(raw: ChannelConfig): ResolvedConfig {
  const devices = new Map<string, ResolvedDevice>();
  for (const [deviceId, dev] of Object.entries(raw.devices ?? {})) {
    let secret: string;
    try {
      secret = resolveSecret(dev.secret);
    } catch (err) {
      console.warn(
        `[minion] skipping device "${deviceId}": ${(err as Error).message}`,
      );
      continue;
    }
    devices.set(deviceId, {
      deviceId,
      secret,
      sessionKey: dev.sessionKey,
      allowedIps: dev.allowedIps ?? [],
    });
  }
  return {
    port: raw.port ?? 8788,
    path: raw.path ?? "/minion",
    requireHmac: raw.requireHmac ?? true,
    timestampToleranceSec: raw.timestampToleranceSec ?? 60,
    rateLimit: raw.rateLimit ?? { perDevicePerMinute: 60 },
    devices,
    asr: raw.asr ?? null,
    tts: raw.tts ?? null,
  };
}
