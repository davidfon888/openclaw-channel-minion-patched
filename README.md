# openclaw-channel-minion-patched

ESP32 voice device channel for [OpenClaw](https://docs.openclaw.ai), with four patches on top of the
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

Identical surface to the upstream plugin — only the 4 patches below differ, plus an optional
Volcengine TTS provider added in [Extras](#extras-volcengine-seedtts-20-tts-provider).

## The 4 patches (vs upstream)

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

### 4. `src/index.ts` + `src/asr/aliyun-paraformer.ts`: abort handling + paraformer lock leak

Two related fixes for a "device stops responding" failure mode we hit in production
(2026-05-11). Symptom: after the user pressed the abort button several times to interrupt a long
TTS reply, subsequent sessions opened cleanly, audio frames flowed in normally, but `paraformer
task-started` never fired — recoverable only by restarting the gateway. Root cause turned out
to be two independent bugs that compounded:

**(a) `abort` message was a no-op.** The xiaozhi-esp32 protocol defines `{type:"abort"}` for
the device's cancel button, but the upstream plugin's `onMessage` just logged it and dropped
the per-turn state (in-flight ASR stream, pending debounced text, listening flag) unchanged.
The fix in `src/index.ts` adds a real abort branch that tears down the ASR stream (releasing
its paraformer lock), clears `dispatchTimer` / `pendingTurnText` / `buffer`, and re-arms a
fresh `listen-start` so the device and gateway agree on state.

**(b) Paraformer's per-task lock leaked across three race paths.** The provider serializes
tasks through an internal `wsLock` chain; a missed release deadlocks every subsequent task.
The fix in `src/asr/aliyun-paraformer.ts` plugs three leaks:

1. **Settled-before-acquire race**: when `abort()` fires while the IIFE is still awaiting
   `acquireWs()`, `settle()` runs with `release === null` and the lock can't be released.
   Fix: after `await acquireWs()`, check `settled` and release immediately if so.
2. **`task-started` timeout never settled**: the 30s timer rejected `startedPromise` but did
   not call `settle()`, so the WebSocket and lock stayed held until process exit. Fix: timer
   handler now calls `settle("reject", ...)` so the next task can proceed.
3. **Defensive 60s timeout on `acquireWs`**: if the previous task's lock release was
   orphaned by an unhandled error path elsewhere, the chain auto-recovers within 60s
   instead of hanging indefinitely.

Combined effect: an abort no longer leaves zombie state, and a single orphaned lock no longer
takes the whole channel down.

## Extras: Volcengine SeedTTS 2.0 TTS provider

Beyond the 4 patches, this fork adds `provider: "volcengine"` to the TTS config. It targets Volcengine's
豆包语音合成 `v3/tts/unidirectional` HTTP streaming endpoint (NDJSON of base64 ogg_opus), supports
the `*_bigtts` 大模型 voice families with optional `emotion` (`happy` / `sad` / `excited` / ...), and
yields raw Opus packets that xiaozhi-esp32 firmware can play without re-encoding.

```json
{
  "tts": {
    "provider": "volcengine",
    "appId": "<your-volcengine-app-id>",
    "apiKeyFile": "/path/to/volcengine-access-token-file",
    "resourceId": "seed-tts-2.0",
    "voice": "zh_female_cancan_uranus_bigtts",
    "loudnessRatio": 10,
    "speedRatio": 0.9
  }
}
```

**Voice selection caveat (verified 2026-05-13 on two EchoEar / ESP-VoCat boards)**:
the default-looking SeedTTS 2.0 voice `zh_female_vv_uranus_bigtts` (vivi) **renders noticeably
fast and slightly distorted** on the small embedded ES8311+speaker chain — vv's baseline prosody
is paced for energetic short-form playback, not the slower, longer agent replies. Even
`speedRatio: 0.8` (the schema minimum) can't compensate. `zh_female_cancan_uranus_bigtts`
(灿灿) is the same SeedTTS 2.0 family (same `resourceId`, same quality tier) but with calmer
default pacing — start there. If you need a still-slower / less expressive option, drop back to
the 1.x `*_moon_bigtts` family (also change `resourceId` to `volc.service_type.10029`).

**`emotion` field is a footgun for embedded TTS**: when set (e.g. `"emotion": "happy"`), Volcengine
applies dynamic prosody on top — faster pace + higher pitch + larger amplitude range. On a small
amp/speaker this clips audibly. We removed it from the example above; only re-enable if you can
hear it doesn't distort. Note that setting `enableEmotion: false` alone doesn't help — the provider
code sends emotion to the API as long as the `emotion` field is present at all, so you must
**delete `emotion` entirely** to fully disable emotional prosody.

`loudnessRatio` (optional, default 0) is forwarded as Volcengine's `audio_params.loudness_rate`.
**Despite the name, it is an integer offset, not a ratio** — float values like `1.6` are silently
dropped by the API (returns empty audio). Useful because some voices — notably the SeedTTS 2.0
`*_uranus_bigtts` family (vivi, cancan, etc.) — are designed for soft / intimate speech and render
quieter than the older `*_moon_bigtts` "broadcaster" voices. Measured on `vv_uranus_bigtts`:
`0` → -7.93 dBFS peak, `20` → -5.89, `50` → -4.82 (server soft-limits past ~30, so ~+3 dB is the
practical ceiling). With `emotion` removed, `10` is usually enough; `20` can clip on small
embedded amps when combined with sibilants/plosives.

`speedRatio` (optional, default 1.0, range 0.8-2.0) maps to `audio_params.speech_rate` — float
ratio, not integer offset. `0.9` slows by 10%, which helps with the natively-fast vv/cancan
voices. `0.8` is the floor.

Different voice families need different `resourceId`s — Volcengine's docs are quiet about this, so:

| Voice suffix | `resourceId` | Example speakers |
|---|---|---|
| `*_moon_bigtts` (1.x 大模型) | `volc.service_type.10029` | `zh_female_wanwanxiaohe_moon_bigtts` 湾湾小何 |
| `*_uranus_bigtts`, `saturn_*_tob` (SeedTTS 2.0) | `seed-tts-2.0` | `zh_female_cancan_uranus_bigtts` 灿灿 (recommended), `zh_female_vv_uranus_bigtts` vivi (faster, may distort on small amps) |

Wrong pairing returns `code: 55000000 resource ID is mismatched with speaker related resource`.

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
