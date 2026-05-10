// Tracks live minion sessions by deviceId.
//
// Why this exists (this is plugin-local state OpenClaw cannot provide):
//   The WebSocket connection to an ESP32 is OUR transport — OpenClaw never
//   sees it directly, so it has no built-in registry that maps a target
//   device back to a live socket handle. When core invokes outbound.sendText
//   with a target like {accountId: "minion-001"}, we need this map to find
//   the in-process WS handle and write to it.
//
//   Same pattern as dingtalk/src/connection-manager.ts — DingTalk Stream
//   connections are also plugin-local, not host-managed.

import type { MinionSession } from "./transport/ws-server.js";

const live = new Map<string, MinionSession>();

export function registerSession(session: MinionSession): void {
  // Only one live session per device — replace any previous handle silently.
  live.set(session.device.deviceId, session);
}

export function unregisterSession(deviceId: string): void {
  live.delete(deviceId);
}

export function getSession(deviceId: string): MinionSession | undefined {
  return live.get(deviceId);
}

export function listDevices(): string[] {
  return Array.from(live.keys());
}
