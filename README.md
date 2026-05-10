# openclaw-channel-minion-patched

ESP32 voice device channel for [OpenClaw](https://docs.openclaw.ai), with three patches on top of the
vanilla `openclaw-channel-minion` plugin to fix bugs discovered while running EchoEar / ESP-VoCat
hardware in production.

> **If you don't have these specific bugs, use the upstream plugin instead.** This fork is a snapshot
> from 2026-05-10 — upstream may have fixed/changed some of these by the time you read this. Diff
> before assuming the patches are still relevant.

## What this plugin does

Implements the `xiaozhi-esp32` WebSocket protocol so an ESP32 voice device (EchoEar, ESP-VoCat,
bread-compact, etc.) can:

- authenticate to OpenClaw with a bearer token + HMAC + per-device secret
- stream Opus-encoded mic audio for ASR
- receive TTS audio frames back as the agent speaks
- emit emoji/expression hints alongside the text channel

Identical surface to the upstream plugin — only the 3 patches below differ.

## The 3 patches (vs upstream)

### 1. `openclaw.plugin.json`: `activation` + `channelConfigs`

OpenClaw 5.7+ requires every plugin manifest to declare:

```json
{
  "activation": { "onStartup": true },
  "channelConfigs": {
    "<channel-id>": {
      "schema": <copy of configSchema>,
      "label": "...",
      "description": "..."
    }
  }
}
```

Without `activation: { onStartup: true }` the plugin appears in `openclaw plugins list` as enabled
but **silently never registers its runtime** — no port binding, no `register()` call, no error log.
Without `channelConfigs.<id>.{schema,label,description}` the plugin loads but channels can't be
configured.

If you are on OpenClaw < 5.7 you can remove these blocks; with 5.7+ you need them.

### 2. `src/asr/aliyun-paraformer.ts`: per-task WebSocket

Upstream caches a single WebSocket connection to Aliyun DashScope and reuses it across many
ASR tasks ("save 100-200ms TLS+WS handshake per utterance"). This works most of the time, but when
DashScope occasionally closes a connection mid-task with `1007 Invalid payload data` (a chronic
server-side rotation behavior), the cached socket's state — half-closed handle, half-released
mutex, accumulated `once` listeners — sometimes corrupts the next task. The auto-restart loop
appears healthy in logs but the next user utterance silently never returns text. Recovery requires
restarting the entire gateway.

This patch removes the cache: each ASR task opens its own fresh WebSocket and closes it on
completion (success, failure, or timeout). Cost: ~100-200ms extra TLS+WS handshake per utterance,
which is well below the device's own VAD/buffering latency and not perceptible. Benefit: server-side
errors can no longer accumulate state; each conversation is isolated.

Specifics:

- `ensureWs()`: removed the `sharedWs` cache; always returns `await this.openSocket()`.
- `settle()` in `startStream()`: after `release()`, explicitly `activeWs.close()`.

### 3. `src/plugin.ts`: `gateway.startAccount` lifecycle hook

Upstream's `minionPlugin` object has no `gateway` property. OpenClaw's channel manager checks
`plugin.gateway.startAccount` per account at startup — if absent, it returns early **before**
setting `account.running = true`. The downstream effect is that the framework's
`channel-health-monitor` evaluates every device account as `not-running` and tries to restart the
channel every 5 minutes. The restart action is idempotent (no-op if channel is actually running),
so this is harmless **functionally** — but the gateway log fills up with `restarting (reason: stopped)`
spam, and on misconfigurations the spurious restart can interfere with active sessions.

This patch adds a minimal `gateway.startAccount` that just `await`s the abort signal — a long-lived
no-op promise. It exists solely to keep the per-account `running` flag set to `true` in the channel
manager's runtime snapshot.

## Installation

```bash
git clone https://github.com/orange001/openclaw-channel-minion-patched.git \
  ~/.openclaw/extensions/openclaw-channel-minion
cd ~/.openclaw/extensions/openclaw-channel-minion
pnpm install
pnpm run build

# Register with openclaw
openclaw plugins install --local .
openclaw config set plugins.entries.openclaw-channel-minion.enabled true

# Restart your gateway (or bootout/bootstrap on macOS launchd)
launchctl bootout gui/$(id -u)/ai.openclaw.gateway
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.gateway.plist
```

You'll also need to configure an `asr` provider (`aliyun-paraformer`, `openai-whisper-api`, or
`local-whisper`) and register at least one device MAC under
`plugins.entries.openclaw-channel-minion.config.devices` in your `openclaw.json`. **Use lowercase
MAC addresses only** — registering both case variants triggers a known orphan-restart bug
(see commit history / issue tracker).

Example device entry:

```json
{
  "plugins": {
    "entries": {
      "openclaw-channel-minion": {
        "enabled": true,
        "config": {
          "asr": { "provider": "aliyun-paraformer", "apiKey": "${env.DASHSCOPE_API_KEY}" },
          "devices": {
            "ac:a7:04:e4:5c:f0": {
              "secret": { "source": "file", "id": "/path/to/secret-file" },
              "sessionKey": "agent:xiaozhi:my-device"
            }
          }
        }
      }
    }
  }
}
```

## Compatibility

- OpenClaw `>= 2026.3.24` (per `package.json`)
- Tested on `2026.5.7` with EchoEar / ESP-VoCat firmware `v2.2.6` (xiaozhi-esp32 mainline)
- Node `>= 22.16.0`

## License

Apache-2.0. See [LICENSE](./LICENSE).

## Upstream

If/when these patches are merged upstream or the underlying issues are otherwise fixed, switch
back to the upstream plugin — that's the canonical home and will keep getting feature work.
