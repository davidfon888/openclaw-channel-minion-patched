# Minion Channel Protocol Reference

This channel implements the **xiaozhi-esp32 WebSocket protocol** so unmodified
xiaozhi firmware can connect to OpenClaw by changing only the server URL.

## Handshake

WebSocket upgrade with these headers:

| Header | Required | Purpose |
|---|---|---|
| `Authorization: Bearer <token>` | yes | Per-device shared secret |
| `Device-Id: <mac>` | yes | Physical MAC, used as device identity |
| `Client-Id: <uuid>` | yes | Software UUID, resets on full reflash |
| `Protocol-Version: <int>` | yes | Must equal `version` in client hello |
| `X-Timestamp: <unix-sec>` | strict mode only | Replay window (default ±60s) |
| `X-Signature: <hex>` | strict mode only | `HMAC-SHA256(secret, mac + uuid + timestamp)` |

After upgrade succeeds, **client** sends:

```json
{ "type": "hello", "version": 1,
  "features": { "mcp": true, "aec": true },
  "transport": "websocket",
  "audio_params": { "format": "opus", "sample_rate": 16000,
                    "channels": 1, "frame_duration": 60 } }
```

**Server** replies within 10s timeout:

```json
{ "type": "hello", "transport": "websocket",
  "session_id": "<server-assigned>",
  "audio_params": { "format": "opus", "sample_rate": 24000,
                    "channels": 1, "frame_duration": 60 } }
```

## Message types

### Device → Server (JSON text frames)

- `hello` — handshake
- `listen` — `state: start|stop|detect`, `mode: auto|manual|realtime`
- `abort` — interrupt current TTS
- `mcp` — JSON-RPC 2.0 (device tool reply)

### Server → Device (JSON text frames)

- `hello` — handshake reply
- `stt` — transcribed user text
- `llm` — assistant reply text + emotion
- `tts` — `state: start|stop|sentence_start`, optional `text`
- `mcp` — JSON-RPC 2.0 (call device tool: speaker/LED/servo/GPIO)
- `system` — `command: reboot`
- `alert` — `status`, `message`, `emotion`

## Audio frames (binary)

We target **BinaryProtocol V3** (smallest header):

```
uint8_t  type            // 0 = OPUS, 1 = JSON
uint8_t  reserved
uint16_t payload_size    // big-endian
uint8_t  payload[]
```

- Upload: 16 kHz mono Opus, 60 ms frames
- Download: 24 kHz mono Opus, 60 ms frames

## Auth modes

Configured via `requireHmac`:

- `false` (default): Bearer token only. Compatible with **stock xiaozhi firmware**, zero firmware change.
- `true` (strict): Bearer + timestamp + HMAC. Requires firmware patch to compute signature.

## References

- xiaozhi-esp32 protocol: <https://github.com/78/xiaozhi-esp32/blob/main/docs/websocket.md>
- Server reference (Python): <https://github.com/xinnan-tech/xiaozhi-esp32-server>
