// Plugin entry. Uses OpenClaw's defineChannelPluginEntry so we register as a
// real channel — other channels can target us, and core will deliver routed
// text via our plugin.outbound.sendText.
//
// Lifecycle:
//   1. OpenClaw imports this default export at gateway boot.
//   2. core invokes `register(api)`. We:
//        a. capture api.runtime (PluginRuntime) via setMinionRuntime
//        b. start the WebSocket transport with the auth gate
//        c. wire each session: STT text -> subagent.run -> core delivers via
//           outbound -> our session.send writes back to the device socket
//   3. Background CLI scans (plugins list / inspect) re-import this module.
//      Our WS server's start() is idempotent (graceful EADDRINUSE) so those
//      scans don't fight the live daemon over the port.

import { readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Append every turn (user STT + bot reply) to a plain-text transcript so
// the user can scroll back through full conversation history outside the
// daemon log noise.
const CONVERSATION_LOG_PATH = join(
  homedir(),
  ".openclaw",
  "extensions",
  "openclaw-channel-minion",
  "conversation.log",
);
function logTurn(role: "user" | "bot", text: string): void {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  const line = `${stamp}  [${role}] ${text}\n`;
  try {
    appendFileSync(CONVERSATION_LOG_PATH, line);
  } catch {
    // best-effort; never fail the conversation just because disk is full
  }
}

// Meeting-mode transcript archive. One file per meeting, named by start
// timestamp so they're easy to find later.
const MEETINGS_DIR = join(
  homedir(),
  ".openclaw",
  "extensions",
  "openclaw-channel-minion",
  "meetings",
);
try { mkdirSync(MEETINGS_DIR, { recursive: true }); } catch {}

// Trigger phrases (fuzzy regex). Aliyun Paraformer often mishears "小志" as
// 小知/小字/晓志/笑知/小制 etc., and "进入开会模式" sometimes comes in as
// "进入开会","开始开会模式" etc. — these patterns try to catch the common
// variants without being so loose they false-trigger on normal chatter.
// Voice volume control. Matches:
//   "音量调到 50" / "声音调到 80" / "把音量调成 30" / "音量改为 70"
const VOLUME_SET_RE = /(?:音量|声音)\D{0,8}?(\d{1,3})/;
//   "音量大一点" / "声音小一点" / "音量大些" / "声音轻一点"
const VOLUME_UP_RE   = /(?:音量|声音)\D{0,4}?(?:大一?点|大些|大声|高一?点|高些)/;
const VOLUME_DOWN_RE = /(?:音量|声音)\D{0,4}?(?:小一?点|小些|小声|低一?点|低些|轻一?点|轻些)/;

const ENTER_MEETING_RE = /(进入|开始|开启|打开).{0,4}(开会|会议)(模式)?/;
const EXIT_MEETING_RE  = /((退出|结束|关闭).{0,4}(开会|会议)(模式)?|(开会|会议).{0,2}(结束|到此|散会)|散会)/;
const ZHI_RE = /[小晓笑筱][智志知字制治指植置至支知]/;
const SUMMARIZE_RE = new RegExp(`${ZHI_RE.source}.{0,8}(总结|概括|汇总|过一遍|捋一捋|梳理)`);
const SPEAK_RE = new RegExp(
  `${ZHI_RE.source}.{0,8}(发言|说一?下|说说|讲一?下|讲讲|聊一聊|来说|怎么看|有(什么|啥)?(意见|想法|看法|建议))`,
);

function meetingFilenameFor(d: Date, deviceId: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours(),
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const safeDev = deviceId.replace(/[^a-z0-9]/gi, "");
  return join(MEETINGS_DIR, `meeting-${stamp}-${safeDev}.txt`);
}
function appendToMeeting(path: string, line: string): void {
  try {
    appendFileSync(path, line);
  } catch {
    // best-effort
  }
}
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { deliverOutboundPayloads } from "openclaw/plugin-sdk/outbound-runtime";
import { MinionWsServer, type MinionSession } from "./transport/ws-server.js";
import { resolveConfig, type ChannelConfig } from "./config.js";
import { makeAsrProvider, type AsrProvider, type AsrStreamSession } from "./asr/index.js";
import { OpusDecoder } from "opus-decoder";
import { makeTtsProvider, type TtsProvider } from "./tts/index.js";
import { minionPlugin } from "./plugin.js";
import { setMinionRuntime, getMinionRuntime } from "./runtime-store.js";
import { registerSession, unregisterSession } from "./session-registry.js";

// Eagerly compile the opus-decoder WASM at plugin load. The module-level WASM
// bytes are cached internally by the package, so this throwaway decoder pays
// the one-time compile cost up front; per-session decoders created later are
// then cheap (just memory alloc + module instantiate).
//
// Why we still create a fresh decoder per session instead of sharing one:
// Opus is a packet codec with inter-frame state (LPC/PLC continuity). If two
// concurrent sessions interleaved packets through one decoder its state would
// be wrong for both, producing clicks at boundaries. Per-session keeps each
// stream isolated; pre-warming just removes the first-frame init penalty.
const _opusWarmup = new OpusDecoder({ channels: 1, sampleRate: 16000 });
_opusWarmup.ready
  .then(() => {
    try { _opusWarmup.free(); } catch { /* ignore */ }
  })
  .catch(() => undefined);

// Captured from api.config in registerFull. We need it on every dispatch and
// it doesn't change at runtime; keeping a module-level reference avoids
// threading it through the WS server -> session -> dispatch call chain.
let openClawConfig: OpenClawConfig | null = null;

// TTS provider, lazy-initialized in bootstrapServer once cfg is in.
let ttsProvider: TtsProvider | null = null;

// Same fallback we already had: when register() runs in a CLI scan that
// doesn't pass our config, read it from disk.
function loadFallbackConfig(): ChannelConfig | null {
  const stateDir = process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw");
  const path = process.env.OPENCLAW_CONFIG_PATH ?? join(stateDir, "openclaw.json");
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const entry = raw?.plugins?.entries?.["openclaw-channel-minion"];
    if (entry?.config) return entry.config as ChannelConfig;
  } catch {
    // fall through
  }
  return null;
}

// Detect a Markdown pipe table (header row + separator row + body rows).
// We require the separator row (e.g. `| --- | --- |`) because plain pipe
// characters appear in lots of legitimate prose ("|" used as a divider in
// CLI examples, etc.) — checking for the separator avoids false positives.
function hasMarkdownTable(text: string): boolean {
  return /^\s*\|.+\|\s*$\n^\s*\|[\s:|-]+\|\s*$/m.test(text);
}

// Pull out the prose preface that appears before the first table row.
// Used as the spoken intro when we redirect the table itself to DingTalk:
// the user gets a one-or-two-sentence "here's what I found" lead-in, then
// a notice that the full table is in their DingTalk thread.
function prosePrefaceBeforeTable(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*\|.+\|\s*$/.test(line)) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

// Parse a SessionKey of the form `agent:<agent>:<channel>:<chatType>:<to>`
// into the pieces we need to push a side-message into the same conversation
// on a different channel. Returns null if the SessionKey doesn't match the
// expected shape (e.g. a non-agent lane); the caller falls back to voice-
// only delivery in that case.
function parseAgentSessionKey(sessionKey: string): {
  agent: string;
  channel: string;
  chatType: string;
  to: string;
} | null {
  const parts = sessionKey.split(":");
  if (parts.length < 5) return null;
  if (parts[0] !== "agent") return null;
  return {
    agent: parts[1]!,
    channel: parts[2]!,
    chatType: parts[3]!,
    to: parts.slice(4).join(":"),
  };
}

// Strip Markdown formatting from agent reply text before sending to TTS.
// Xiaozhi (and most chat agents) emit text-channel-formatted replies — bold
// (**word**), code (`word`), bullet lists, headings, links — which sound
// terrible read literally ("星星", "撇", URL gibberish). This pass removes
// the formatting characters and unwraps the inline patterns without
// changing the actual content. Keep it lightweight: regex-only, no AST.
function stripMarkdownForTts(text: string): string {
  return text
    // [text](url) → text  (drop the URL entirely; never readable aloud)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // ![alt](url) → alt
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    // ```code blocks``` → code blocks (drop fences)
    .replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, "$1")
    // **bold** / __bold__ → bold (handle BEFORE single * / _)
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    // *italic* / _italic_ → italic (require non-space at boundaries to
    // avoid eating bare * separators in lists, math, etc.)
    .replace(/(?<![\w*])\*([^*\n]+?)\*(?![\w*])/g, "$1")
    .replace(/(?<![\w_])_([^_\n]+?)_(?![\w_])/g, "$1")
    // `inline code` → inline code
    .replace(/`([^`\n]+)`/g, "$1")
    // # headings  →  drop the # markers
    .replace(/^#{1,6}\s+/gm, "")
    // bullet markers at line start: -, *, + followed by space
    .replace(/^[\s]*[-*+]\s+/gm, "")
    // numbered lists: 1. / 2) etc.
    .replace(/^[\s]*\d+[\.\)]\s+/gm, "")
    // horizontal rules
    .replace(/^[-=_*]{3,}\s*$/gm, "")
    // blockquote markers
    .replace(/^>\s?/gm, "")
    // any stray formatting chars left behind from partial patterns
    .replace(/[`*_~]+/g, "")
    // collapse multi-newlines
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Synthesize text and stream the resulting audio chunks back to the device,
// bracketed by tts:start / tts:stop control events per xiaozhi-esp32
// protocol. Each audio chunk is wrapped in a BinaryProtocol V3 frame by
// session.sendAudio (type=OPUS marker; payload is whatever bytes the TTS
// provider emitted — see TtsProvider.format).
function streamTtsToDevice(opts: {
  session: MinionSession;
  text: string;
  log: { info: (m: string) => void; warn: (m: string) => void };
  onSpeakingChange?: (speaking: boolean) => void;
}): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!ttsProvider) return resolve();
    const { session, text } = opts;
    let frames = 0;
    let bytes = 0;

    const cleanText = stripMarkdownForTts(text);
    if (!cleanText) return resolve();

    opts.onSpeakingChange?.(true);
    session.send({ type: "tts", session_id: session.sessionId, state: "start" });

    // Burst the first BURST_FRAMES to seed ~100 ms of buffer on the device,
    // then pace at PACE_MS (slightly under Edge TTS's real-time 20 ms frame
    // cadence) so the I2S buffer stays full across WiFi jitter without
    // unbounded growth.
    const BURST_FRAMES = 5;
    const PACE_MS = 18;
    let pacingStart = 0;

    void (async () => {
      try {
        // Collect all opus packets BEFORE starting the paced send. Edge
        // TTS's MS-side service tends to emit WebM in non-uniform batches
        // for long replies — bursts of frames separated by multi-second
        // pauses while the server synthesizes the next segment. If we
        // pipelined those straight to the device the on-device buffer
        // would drain during each pause and the user would hear the audio
        // fragment into "say a few words → silence → say a few words →
        // silence" — exactly the choppy playback users reported.
        //
        // Buffering trades a small first-byte latency penalty (we wait
        // until the TTS source has fully drained) for guaranteed-smooth
        // playback. The pacing loop below then sends packets at a steady
        // 18ms cadence regardless of how stuttery the upstream was.
        // Streaming WebM parsing is preserved internally — we just don't
        // expose its jitter to the device.
        const packets: Uint8Array[] = [];
        for await (const chunk of ttsProvider!.synthesize({ text: cleanText })) {
          packets.push(chunk.audio);
          bytes += chunk.audio.length;
        }
        for (const packet of packets) {
          if (frames >= BURST_FRAMES) {
            if (pacingStart === 0) pacingStart = Date.now();
            const dueAt = pacingStart + (frames - BURST_FRAMES) * PACE_MS;
            const wait = dueAt - Date.now();
            if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          }
          session.sendAudio(packet);
          frames++;
        }
        opts.log.info(
          `[minion] tts done frames=${frames} bytes=${bytes} session=${session.sessionId}`,
        );
      } catch (err) {
        opts.log.warn(`[minion] tts error: ${(err as Error).message}`);
      } finally {
        session.send({ type: "tts", session_id: session.sessionId, state: "stop" });
        // 250 ms tail: speaker takes time to physically go quiet, don't
        // re-open mic until that decay has finished or the mute will leak.
        setTimeout(() => opts.onSpeakingChange?.(false), 250);
        resolve();
      }
    })();
  });
}

// Run a reply turn through OpenClaw core using the channel-runtime API
// (the same surface dingtalk's inbound-handler uses). Unlike subagent.run,
// this does NOT require a gateway request context — it's specifically
// designed for channel plugins to dispatch replies from their own event
// loops.
//
// Each text chunk core produces fires our `deliver` callback, which writes
// an `llm` event back to the originating device session.
async function dispatchToCore(opts: {
  session: MinionSession;
  text: string;
  log: { info: (m: string) => void; warn: (m: string) => void };
  onSpeakingChange?: (speaking: boolean) => void;
  // Called once with the full assembled bot reply after dispatch finishes
  // and TTS playback completes. Used by meeting mode to log the bot's
  // response to the meeting transcript file.
  onReply?: (text: string) => void;
}): Promise<void> {
  let rt;
  try {
    rt = getMinionRuntime();
  } catch (err) {
    opts.log.warn(`[minion] dispatch skipped: ${(err as Error).message}`);
    return;
  }
  if (!openClawConfig) {
    opts.log.warn(`[minion] dispatch skipped: cfg not captured yet`);
    return;
  }

  const { session } = opts;
  const sessionKey = session.device.sessionKey;
  let chunkCount = 0;
  // Accumulate the full reply so we can synthesize it as one utterance at
  // the end. Per-sentence streaming gave better first-byte latency but
  // created a hang risk when the LLM stalled mid-stream — tts.stop never
  // reached the firmware and the mic stayed muted indefinitely. One-shot
  // synthesis is slower to start but cannot leave the firmware in that
  // limbo state.
  const replyText: string[] = [];

  try {
    await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: {
        Body: opts.text,
        BodyForAgent: opts.text,
        SessionKey: sessionKey,
        AccountId: session.device.deviceId,
        From: session.device.deviceId,
        To: "minion",
        ChatType: "dm",
      },
      cfg: openClawConfig,
      dispatcherOptions: {
        responsePrefix: "",
        deliver: (payload) => {
          const text = typeof payload.text === "string" ? payload.text.trim() : "";
          if (!text) return;
          chunkCount++;
          replyText.push(text);
          session.send({
            type: "llm",
            session_id: session.sessionId,
            emotion: "neutral",
            text,
          });
          opts.log.info(`[minion] llm chunk #${chunkCount} text="${text}"`);
        },
      },
    });
    opts.log.info(`[minion] dispatch finished chunks=${chunkCount} session=${session.sessionId}`);

    // Voice playback: only speak the LAST chunk. Earlier chunks are usually
    // intermediate "thinking out loud" / tool-call narration / acknowledgements;
    // the last chunk is the actual final answer. Reading them all concatenated
    // makes replies feel doubled-up and confusing. Conversation log + OLED
    // still get every chunk — only the spoken audio is filtered.
    let spokenText = (replyText[replyText.length - 1] ?? "").trim();
    const fullText = replyText.join("\n\n").trim();
    if (fullText) logTurn("bot", fullText);

    // If the reply contains a Markdown table, the device speaker can't
    // render it usefully (TTS would read "竖线 列名 竖线 数据 竖线..." for
    // every row — terrible UX, and tables are usually long enough to
    // dominate the whole reply). Instead we forward the full reply (with
    // the table intact) to whatever channel owns this lane — typically
    // DingTalk for our setup — and speak only a short preface plus a
    // notice telling the user where to find the full version. Falls
    // through to normal speak-only behavior if the SessionKey doesn't
    // resolve to a side channel (e.g. ad-hoc voice-only sessions).
    if (fullText && hasMarkdownTable(fullText)) {
      const lane = parseAgentSessionKey(sessionKey);
      if (lane && lane.channel !== "minion") {
        try {
          await deliverOutboundPayloads({
            cfg: openClawConfig,
            channel: lane.channel,
            accountId: lane.agent,
            to: lane.to,
            payloads: [{ text: fullText }],
          });
          opts.log.info(
            `[minion] table redirected channel=${lane.channel} to=${lane.to}`,
          );
          const preface = prosePrefaceBeforeTable(fullText);
          spokenText = preface
            ? `${preface}\n\n完整表格我发到${lane.channel === "dingtalk" ? "钉钉" : lane.channel}给你了,你看一下。`
            : `我整理了一份表格,已经发到${lane.channel === "dingtalk" ? "钉钉" : lane.channel}给你了。`;
        } catch (err) {
          opts.log.warn(`[minion] table redirect failed: ${(err as Error).message}`);
          // Fall through and speak whatever we'd normally speak — better
          // a clumsy reading than total silence.
        }
      }
    }

    if (spokenText && ttsProvider) {
      await streamTtsToDevice({
        session,
        text: spokenText,
        log: opts.log,
        onSpeakingChange: opts.onSpeakingChange,
      });
      opts.onReply?.(spokenText);
    }
  } catch (err) {
    opts.log.warn(`[minion] dispatch error: ${(err as Error).message}`);
    session.send({
      type: "alert",
      session_id: session.sessionId,
      status: "dispatch_failed",
      message: (err as Error).message,
      emotion: "sad",
    });
  }
}

// One-time WS server bootstrap. We do this lazily inside register() so the
// definePluginEntry pipeline can call us without forcing a port bind from
// non-runtime contexts (in practice register() is only called once at
// startup, but staying lazy is cheap and safer).
let started = false;
async function bootstrapServer(
  log: { info: (m: string) => void; warn: (m: string) => void },
  cfg?: OpenClawConfig,
): Promise<void> {
  if (started) return;
  started = true;
  if (cfg) openClawConfig = cfg;

  const fb = loadFallbackConfig();
  const config = resolveConfig(fb ?? ({} as ChannelConfig));
  log.info(
    `[minion] resolved ${config.devices.size} device(s); ` +
      `port=${config.port} path=${config.path} requireHmac=${config.requireHmac} ` +
      `asr=${config.asr?.provider ?? "none"}`,
  );

  let asr: AsrProvider | null = null;
  if (config.asr) {
    try {
      asr = makeAsrProvider(config.asr);
      log.info(`[minion] asr provider ready: ${asr.name}`);
    } catch (err) {
      log.warn(`[minion] asr init failed: ${(err as Error).message}`);
    }
  }

  if (config.tts) {
    try {
      ttsProvider = makeTtsProvider(config.tts);
      log.info(`[minion] tts provider ready: ${ttsProvider.name} (${ttsProvider.format})`);
    } catch (err) {
      log.warn(`[minion] tts init failed: ${(err as Error).message}`);
    }
  }

  const server = new MinionWsServer(config);
  server.onSession((session) => {
    registerSession(session);
    log.info(
      `[minion] session ${session.sessionId} device=${session.device.deviceId} ` +
        `client=${session.clientId}`,
    );
    // (Old firmware needed server to push `listen.start` here to skip the
    // wake-word phase. New ESP-VoCat firmware doesn't recognize a
    // server-initiated `listen` message — it logs "Unknown message type:
    // listen" and moments later the WS gets reset. The new firmware
    // self-initiates listening on connect, so we just don't push.)

    let stream: AsrStreamSession | null = null;
    let buffer: Uint8Array[] = [];
    let listening = false;
    let audioFramesThisSession = 0;
    let audioBytesThisSession = 0;
    // True while we're streaming bot TTS audio back to the device. While
    // true the onAudio path discards inbound frames so the speaker's own
    // playback caught by the mic does not get re-transcribed as a phantom
    // user turn.
    let botSpeaking = false;

    // Meeting mode state. In `meeting` mode, all STT goes silently to a
    // transcript file and the bot does NOT respond — except when the user
    // says a trigger phrase ("小志,总结一下" / "小志,发言一下" / similar),
    // at which point the bot summarizes the buffered transcript and replies
    // via TTS. Mode is per-connection; reconnection resets to "normal".
    type SessionMode = "normal" | "meeting";
    let mode: SessionMode = "normal";
    let meetingFile: string | null = null;
    // In-memory transcript of the current meeting (just user turns, kept
    // for building the LLM prompt when summarize/speak is triggered).
    const meetingBuffer: Array<{ at: Date; text: string }> = [];

    // Single-slot dispatch queue. Without this, when Aliyun splits one
    // continuous user utterance into multiple sentence_end events that
    // each pass the debounce window, two dispatches go in parallel and
    // their TTS audio frames interleave on the WS — the speaker plays a
    // garbled mix of both replies. With it, dispatch N waits for dispatch
    // N-1's TTS playback to fully finish before starting its own.
    let dispatchQueueTail: Promise<void> = Promise.resolve();
    const enqueueDispatch = (run: () => Promise<void>): void => {
      const prev = dispatchQueueTail;
      dispatchQueueTail = (async () => {
        try { await prev; } catch {}
        try { await run(); } catch (err) {
          log.warn(`[minion] dispatch queue error: ${(err as Error).message}`);
        }
      })();
    };

    const formatTime = (d: Date) =>
      `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;

    const startMeeting = () => {
      const start = new Date();
      meetingFile = meetingFilenameFor(start, session.device.deviceId);
      mode = "meeting";
      meetingBuffer.length = 0;
      appendToMeeting(
        meetingFile,
        `# 会议记录\n开始时间: ${start.toISOString()}\n设备: ${session.device.deviceId}\n` +
          `Session: ${session.sessionId}\n\n`,
      );
      log.info(`[minion] meeting mode ON file=${meetingFile}`);
    };
    const stopMeeting = () => {
      if (meetingFile) {
        appendToMeeting(meetingFile, `\n# 结束时间: ${new Date().toISOString()}\n`);
      }
      log.info(`[minion] meeting mode OFF file=${meetingFile ?? "(none)"} buffered=${meetingBuffer.length}`);
      mode = "normal";
      meetingFile = null;
      meetingBuffer.length = 0;
    };
    const recordMeeting = (role: "user" | "AI", text: string) => {
      if (!meetingFile) return;
      const t = formatTime(new Date());
      appendToMeeting(meetingFile, `[${t}] ${role}: ${text}\n`);
    };

    // Speak a fixed confirmation text via TTS without going through the
    // LLM (used for "进入开会模式" / "退出开会模式" acknowledgements).
    const speakFixed = async (text: string): Promise<void> => {
      if (!ttsProvider) return;
      await streamTtsToDevice({
        session,
        text,
        log,
        onSpeakingChange: (s) => { botSpeaking = s; },
      });
    };

    // Per-session Opus decoder. xiaozhi-esp32 firmware encodes its mic input
    // as 16 kHz mono Opus with 60 ms frame duration. Aliyun Paraformer's
    // "opus" format expects an Ogg-Opus stream rather than bare codec
    // packets, so we decode to int16 PCM here and forward PCM to the ASR
    // provider — that path is well tested.
    const opusDecoder = new OpusDecoder({ channels: 1, sampleRate: 16000 });
    const opusReady = opusDecoder.ready.catch((err) =>
      log.warn(`[minion] opus decoder init failed: ${(err as Error).message}`),
    );

    // Decode an incoming Opus packet to int16 little-endian PCM. Returns
    // null on decode failure (corrupt frame).
    const decodeOpusPacket = (opus: Uint8Array): Uint8Array | null => {
      try {
        const result = opusDecoder.decodeFrame(opus);
        const f32 = result.channelData[0];
        if (!f32 || f32.length === 0) return null;
        const pcm = new Uint8Array(f32.length * 2);
        const view = new DataView(pcm.buffer);
        for (let i = 0; i < f32.length; i++) {
          const s = Math.max(-1, Math.min(1, f32[i]!));
          view.setInt16(i * 2, (s * 0x7fff) | 0, true);
        }
        return pcm;
      } catch {
        return null;
      }
    };

    // Debounced turn dispatch:
    //   Aliyun fires sentence_end on commas / short pauses, so a single
    //   spoken paragraph often arrives as several "sentences." If we
    //   dispatched each immediately, the LLM would race three replies for
    //   one user turn and the user only hears one of them.
    //   Instead, accumulate sentence_end texts in pendingTurnText and only
    //   actually dispatch after DEBOUNCE_MS of silence. New sentence_end
    //   resets the timer and appends.
    const DEBOUNCE_MS = 3000;
    let pendingTurnText = "";
    let dispatchTimer: NodeJS.Timeout | null = null;
    // Minimum content length to dispatch as a real user turn. Aliyun's ASR
    // is aggressive — keyboard clicks, desk thumps, and TTS-leak tails
    // routinely come back as 1-character "transcripts" like "对。" or "嗯。"
    // Without this guard the agent dispatches on noise and starts replying
    // to phantom utterances. Counts non-punctuation, non-whitespace chars.
    const NOISE_PUNCT = /[\s。,！？，、；：""''""''.!?,;:…—\-]/g;
    const isLikelyNoise = (text: string): boolean =>
      text.replace(NOISE_PUNCT, "").length < 2;
    // Server-initiated MCP call to the device. Wraps a JSON-RPC request
    // (with id, so device sends a response) in the `mcp` envelope.
    let mcpReqId = 1;
    const callDeviceTool = (name: string, args: Record<string, unknown>) => {
      const payload = {
        jsonrpc: "2.0" as const,
        id: mcpReqId++,
        method: "tools/call",
        params: { name, arguments: args },
      };
      session.send({
        type: "mcp",
        session_id: session.sessionId,
        payload,
      });
      log.info(`[minion] mcp call → device tool="${name}" args=${JSON.stringify(args)}`);
    };

    const handleUserTurn = (text: string) => {
      // Always echo the STT to the device so the OLED shows what was heard.
      session.send({ type: "stt", session_id: session.sessionId, text });
      log.info(`[minion] stt session=${session.sessionId} text="${text}" mode=${mode}`);

      // ---- Volume intent (handled in BOTH modes) ---------------------
      // Catch "音量调到50" / "声音大一点" type commands without going through
      // the LLM, which doesn't have access to device MCP tools yet.
      const volMatch = text.match(VOLUME_SET_RE);
      if (volMatch) {
        const target = Math.max(0, Math.min(100, parseInt(volMatch[1]!, 10)));
        callDeviceTool("self.audio_speaker.set_volume", { volume: target });
        void speakFixed(`好,音量调到${target}`);
        return;
      }
      if (VOLUME_UP_RE.test(text)) {
        callDeviceTool("self.audio_speaker.set_volume", { volume: 100 });
        void speakFixed("好,音量调大");
        return;
      }
      if (VOLUME_DOWN_RE.test(text)) {
        callDeviceTool("self.audio_speaker.set_volume", { volume: 40 });
        void speakFixed("好,音量调小");
        return;
      }

      // ---- Mode transitions (recognized in BOTH modes) ----------------
      if (mode === "normal" && ENTER_MEETING_RE.test(text)) {
        startMeeting();
        recordMeeting("user", text);
        logTurn("user", text);
        void speakFixed("好的,进入开会模式,我会安静听着,说小志总结一下我就总结。");
        return;
      }
      if (mode === "meeting" && EXIT_MEETING_RE.test(text)) {
        recordMeeting("user", text);
        const path = meetingFile;
        stopMeeting();
        log.info(`[minion] meeting saved at ${path}`);
        void speakFixed("好的,退出开会模式。");
        return;
      }

      // ---- Meeting mode: silent record + summarize-only-on-trigger ---
      if (mode === "meeting") {
        meetingBuffer.push({ at: new Date(), text });
        recordMeeting("user", text);
        const wantsSummary = SUMMARIZE_RE.test(text);
        const wantsSpeak   = !wantsSummary && SPEAK_RE.test(text);
        if (!wantsSummary && !wantsSpeak) {
          // Just record, no reply.
          return;
        }
        // Build an LLM prompt with the entire transcript + the user's
        // trigger sentence. The agent's own persona handles tone; we just
        // hand it the context.
        const transcript = meetingBuffer
          .map((e) => `[${formatTime(e.at)}] ${e.text}`)
          .join("\n");
        const action = wantsSummary
          ? "把上面的会议记录简洁地总结出来,口语化,2-4 句"
          : "基于上面的会议记录给一段你的看法或建议,口语化,2-4 句";
        const promptText =
          `[当前正在开会,以下是从开会模式开启到现在的全部记录]\n` +
          `${transcript}\n\n` +
          `[请${action}]`;
        logTurn("user", text);
        enqueueDispatch(() =>
          dispatchToCore({
            session,
            text: promptText,
            log,
            onSpeakingChange: (s) => { botSpeaking = s; },
            onReply: (reply) => recordMeeting("AI", reply),
          }),
        );
        return;
      }

      // ---- Normal mode: every turn dispatches to the agent -----------
      logTurn("user", text);
      enqueueDispatch(() =>
        dispatchToCore({
          session,
          text,
          log,
          onSpeakingChange: (s) => { botSpeaking = s; },
        }),
      );
    };

    const scheduleDispatch = () => {
      if (dispatchTimer) clearTimeout(dispatchTimer);
      dispatchTimer = setTimeout(() => {
        dispatchTimer = null;
        const text = pendingTurnText.trim();
        pendingTurnText = "";
        if (!text) return;
        if (isLikelyNoise(text)) {
          log.info(`[minion] stt drop (short noise): "${text}"`);
          return;
        }
        handleUserTurn(text);
      }, DEBOUNCE_MS);
    };

    // Open a fresh ASR streaming session and wire its callbacks. Extracted
    // so onError can re-invoke this to transparently replace a dead stream
    // (e.g. paraformer NO_INPUT_AUDIO_ERROR after long silence) without the
    // device noticing.
    const openAsrStream = (): AsrStreamSession | null => {
      if (!asr?.startStream) return null;
      const s = asr.startStream({
        sampleRate: 16000,
        language: "zh",
        onPartial: (text, sentenceEnd) => {
          log.info(`[minion] partial "${text}" end=${sentenceEnd}`);
          if (sentenceEnd && text.trim()) {
            pendingTurnText = pendingTurnText
              ? `${pendingTurnText} ${text.trim()}`
              : text.trim();
            scheduleDispatch();
          }
        },
        onError: (err) => {
          // Paraformer ends the task on its own under several conditions
          // (NO_INPUT_AUDIO_ERROR after ~1.5 min without detected speech,
          // server-side idle timeouts, transient transport issues). Without
          // intervention the channel would silently stop transcribing —
          // audio still flows from the device but no partials come back.
          // Spin up a replacement stream so the user can keep talking.
          log.warn(`[minion] asr stream died: ${err.message}; restarting`);
          stream = null;
          if (!listening) return;
          // Tiny delay avoids hot-looping on persistent server-side errors
          // (e.g. auth failure, quota exhausted). Auth/quota would also
          // surface on the very next attempt and the loop would back off
          // naturally as restarts pile up — for transient issues this is
          // effectively zero overhead.
          setTimeout(() => {
            if (!listening || stream) return;
            stream = openAsrStream();
            log.info(`[minion] asr stream replaced; ${stream ? "ok" : "failed"}`);
          }, 500);
        },
      });
      return s ?? null;
    };

    const startListening = () => {
      // If a previous stream is still open (firmware sends listen=start
      // again after each TTS turn without first sending listen=stop), tear
      // it down before opening the new one. Otherwise the new stream gets
      // queued behind the old stream's WS lock and can't acquire it until
      // the old task auto-fails on idle ~60-90s later — the user
      // experiences this as "first turn works, every later turn the bot
      // doesn't hear me." abort() flips voluntaryFinish=true so the
      // onError-driven auto-restart doesn't also fire, and releases the
      // lock synchronously so openAsrStream below acquires immediately.
      if (stream) {
        try { stream.abort(); } catch { /* ignore */ }
        stream = null;
      }
      listening = true;
      buffer = [];
      stream = openAsrStream();
      log.info(
        `[minion] listen-start session=${session.sessionId} ` +
          `mode=${stream ? "stream" : "buffer"}`,
      );
    };

    const stopListening = async () => {
      if (!listening) return;
      listening = false;
      let text = "";
      try {
        if (stream) {
          const r = await stream.finish();
          text = r.text;
        } else if (asr && buffer.length > 0) {
          const total = buffer.reduce((n, c) => n + c.length, 0);
          const merged = new Uint8Array(total);
          let off = 0;
          for (const c of buffer) {
            merged.set(c, off);
            off += c.length;
          }
          const r = await asr.transcribe({ pcm: merged, sampleRate: 16000, language: "zh" });
          text = r.text;
        }
      } catch (err) {
        log.warn(`[minion] asr error: ${(err as Error).message}`);
      } finally {
        stream = null;
        buffer = [];
      }
      if (text && isLikelyNoise(text)) {
        log.info(`[minion] stt drop (short noise): "${text}"`);
        return;
      }
      if (text) handleUserTurn(text);
    };

    return {
      onMessage: async (msg) => {
        if (msg.type === "listen") {
          if (msg.state === "start") startListening();
          else if (msg.state === "stop") await stopListening();
        } else if (msg.type === "abort") {
          // Device's cancel button. Without this branch the message used to
          // be a no-op (only logged). That left ASR / dispatch / debounce
          // state in whatever shape the in-flight turn happened to have,
          // and after a few aborts in a row the channel could enter a
          // state where audio kept arriving but no paraformer task ever
          // started — recoverable only by gateway restart (see memory:
          // minion_asr_silent_stall.md, 2026-05-11). The fix below clears
          // every piece of per-turn state and re-arms listening so the
          // next utterance starts from a known-clean baseline.
          log.info(
            `[minion] abort received session=${session.sessionId} ` +
              `reason="${msg.reason ?? ""}"`,
          );
          // 1) Tear down the ASR stream. stream.abort() settles the
          //    paraformer task and releases its wsLock; if we left it
          //    alive, the next startListening would race a half-shut-down
          //    stream against a fresh one on the same shared lock chain.
          if (stream) {
            try { stream.abort(); } catch { /* ignore */ }
            stream = null;
          }
          // 2) Drop the partial-recognition buffer so debounced text
          //    from a half-spoken utterance can't get auto-dispatched
          //    after the user already gave up on it.
          if (dispatchTimer) {
            clearTimeout(dispatchTimer);
            dispatchTimer = null;
          }
          pendingTurnText = "";
          buffer = [];
          // 3) Force `listening` off so onAudio's gate matches reality
          //    until the next listen-start (auto-sent right below).
          listening = false;
          // 4) Re-arm: push a fresh listen-start to the device + open a
          //    new ASR stream on our side. We do this proactively rather
          //    than wait for the device to send one, because some firmware
          //    builds skip the listen-start after abort and we'd be stuck
          //    silently dropping every subsequent audio frame.
          session.send({
            type: "listen",
            session_id: session.sessionId,
            state: "start",
            mode: "realtime",
          });
          startListening();
        } else if (msg.type === "mcp") {
          // Inbound MCP from device (firmware-initiated notification).
          // Currently the only one we care about is `meeting.toggle`,
          // sent by esp-vocat board on touch-screen double-tap.
          const method = (msg.payload as { method?: string } | undefined)?.method;
          if (method === "meeting.toggle") {
            if (mode === "normal") {
              startMeeting();
              if (meetingFile) appendToMeeting(meetingFile, `[${formatTime(new Date())}] -- 双击进入开会模式 --\n`);
              session.send({
                type: "llm",
                session_id: session.sessionId,
                emotion: "neutral",
                text: "🎙 开会中·静听",
              });
              log.info(`[minion] meeting ON (double-tap) session=${session.sessionId}`);
            } else {
              const path = meetingFile;
              if (meetingFile) appendToMeeting(meetingFile, `[${formatTime(new Date())}] -- 双击退出开会模式 --\n`);
              stopMeeting();
              session.send({
                type: "llm",
                session_id: session.sessionId,
                emotion: "happy",
                text: "✓ 退出开会",
              });
              log.info(`[minion] meeting saved at ${path} (double-tap)`);
            }
          } else {
            log.info(
              `[minion] mcp inbound method="${method ?? "?"}" session=${session.sessionId}`,
            );
          }
        } else {
          log.info(`[minion] msg type=${msg.type} session=${session.sessionId}`);
        }
      },
      onAudio: (audio) => {
        audioFramesThisSession++;
        audioBytesThisSession += audio.length;
        if (!listening) return;
        // Drop inbound mic frames while the bot is talking — even with
        // CONFIG_USE_SERVER_AEC=y the firmware keeps the mic open, so its
        // own speaker bleeds into ASR and gets transcribed as phantom
        // user turns. This is the simple half-duplex gate.
        if (botSpeaking) return;
        const pcm = decodeOpusPacket(audio);
        if (!pcm) {
          if (audioFramesThisSession % 50 === 0) {
            log.warn(
              `[minion] opus decode failed frames=${audioFramesThisSession} ` +
                `bytes=${audioBytesThisSession}`,
            );
          }
          return;
        }
        if (audioFramesThisSession === 1 || audioFramesThisSession % 50 === 0) {
          log.info(
            `[minion] audio frames=${audioFramesThisSession} opus=${audio.length}B ` +
              `pcm=${pcm.length}B`,
          );
        }
        if (stream) stream.push(pcm);
        else buffer.push(pcm);
      },
      onClose: (code, reason) => {
        if (stream) stream.abort();
        unregisterSession(session.device.deviceId);
        log.info(
          `[minion] closed code=${code} reason="${reason}" session=${session.sessionId}`,
        );
      },
    };
  });

  await server.start();
  if (server.bound) {
    log.info(`[minion] listening on ws://0.0.0.0:${config.port}${config.path}`);
  } else {
    log.info(
      `[minion] port ${config.port} already bound by sibling instance; ` +
        `register() call is a no-op.`,
    );
  }
}

export default defineChannelPluginEntry({
  // Plugin id — must match the install record key in openclaw.json
  // (derived from the npm package name). Distinct from minionPlugin.id,
  // which is the channel id used for cross-channel routing.
  id: "openclaw-channel-minion",
  name: "Minion Channel",
  description: "ESP32 voice robot speaking xiaozhi-esp32 protocol over WebSocket.",
  plugin: minionPlugin,
  setRuntime: (rt) => {
    setMinionRuntime(rt);
  },
  registerFull: (api) => {
    bootstrapServer(
      {
        info: api.logger.info.bind(api.logger),
        warn: api.logger.warn.bind(api.logger),
      },
      api.config as OpenClawConfig,
    );
  },
});
