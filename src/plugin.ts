// Minimum ChannelPlugin object. OpenClaw's defineChannelPluginEntry wraps
// this and registers the channel so:
//   - core can route messages from other channels TO us (outbound.sendText)
//   - our channel id appears in plugins list / channel routing tables
//
// We implement only the four required adapters (id, meta, capabilities,
// config) plus outbound.sendText. Everything else stays optional / undefined
// — the SDK has sensible defaults for groups/threading/mentions/etc., and
// we don't need them for a single-user voice channel.

import type {
  ChannelPlugin,
  OpenClawConfig,
} from "openclaw/plugin-sdk/core";
import { getSession } from "./session-registry.js";

// "Resolved account" for our channel = a single device. accountId == deviceId.
// We don't need a richer shape because we don't currently support per-account
// extra config — config lives on the channel plugin entry, not per-account.
export interface MinionResolvedAccount {
  accountId: string; // == deviceId (MAC)
}

const CHANNEL_ID = "minion" as const;

export const minionPlugin: ChannelPlugin<MinionResolvedAccount> = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: "Minion",
    selectionLabel: "Minion Robot (ESP32 / xiaozhi-esp32)",
    docsPath: "https://github.com/orange001/openclaw-channel-minion",
    blurb: "ESP32-based AI robot device speaking xiaozhi-esp32 WebSocket protocol.",
    order: 80,
    aliases: ["xiaozhi", "esp32-robot"],
  },
  capabilities: {
    chatTypes: ["dm"],
    media: false,
    threads: false,
    polls: false,
    reactions: false,
    edit: false,
    unsend: false,
    reply: false,
    effects: false,
    groupManagement: false,
    nativeCommands: false,
    blockStreaming: false,
  },
  config: {
    // Each device id we resolved at config-load time is one "account".
    // For now we read straight from openclaw.json — the channel plugin entry
    // owns its own config under plugins.entries[].config; it does NOT live
    // under cfg.channels.minion.* the way bundled channels do.
    listAccountIds: (_cfg: OpenClawConfig): string[] => {
      const entry = readMinionEntry(_cfg);
      const devices = (entry?.config?.devices ?? {}) as Record<string, unknown>;
      return Object.keys(devices);
    },
    resolveAccount: (
      _cfg: OpenClawConfig,
      accountId?: string | null,
    ): MinionResolvedAccount => {
      return { accountId: accountId ?? "default" };
    },
    isEnabled: (_account: MinionResolvedAccount, cfg: OpenClawConfig): boolean => {
      const entry = readMinionEntry(cfg);
      return entry?.enabled !== false;
    },
    isConfigured: (account: MinionResolvedAccount, cfg: OpenClawConfig): boolean => {
      const entry = readMinionEntry(cfg);
      const devices = (entry?.config?.devices ?? {}) as Record<string, unknown>;
      return Boolean(devices[account.accountId]);
    },
  },
  outbound: {
    deliveryMode: "direct",
    // Core calls this when:
    //   - we ourselves dispatched via subagent.run({ deliver: true })
    //   - another channel routed a message at our minion target
    sendText: async (ctx) => {
      const accountId = (ctx as unknown as { accountId?: string }).accountId
        ?? (ctx as unknown as { to?: string }).to
        ?? "";
      const text = (ctx as unknown as { text?: string }).text ?? "";
      const session = getSession(accountId);
      if (!session) {
        return {
          ok: false,
          error: `no live minion session for device ${accountId}`,
        } as never;
      }
      // For now we forward as a `llm` event — TTS layer will replace this
      // with audio frames in P3.
      session.send({
        type: "llm",
        session_id: session.sessionId,
        emotion: "neutral",
        text,
      });
      return {
        ok: true,
        delivered: true,
        target: accountId,
      } as never;
    },
  },

  // Long-lived account "lifecycle" hook so OpenClaw's channel manager
  // marks each device account as running:true. Without this, openclaw's
  // health-monitor sees account.running=false and tries to restart the
  // channel every 5 min (harmless but log-spammy). The minion WS server
  // is shared across all accounts (it lives in bootstrapServer at
  // registerFull), so per-account start is just "wait for shutdown".
  gateway: {
    startAccount: async (ctx: unknown): Promise<void> => {
      const sig = (ctx as { abortSignal?: AbortSignal }).abortSignal;
      if (!sig) return;
      if (sig.aborted) return;
      await new Promise<void>((resolve) => {
        const onAbort = () => resolve();
        sig.addEventListener("abort", onAbort, { once: true });
      });
    },
  },
};

// Helper: read our entry from openclaw.json-shaped config without depending
// on internal types we don't have.
function readMinionEntry(cfg: OpenClawConfig): {
  enabled?: boolean;
  config?: { devices?: Record<string, unknown> };
} | undefined {
  const plugins = (cfg as unknown as { plugins?: { entries?: Record<string, unknown> } }).plugins;
  const entry = plugins?.entries?.["openclaw-channel-minion"]
    ?? plugins?.entries?.["minion"];
  return entry as never;
}
