// 火山引擎豆包语音合成 2.0 TTS provider (v3 unidirectional HTTP streaming).
// POSTs to /api/v3/tts/unidirectional with NDJSON streaming response,
// base64-decodes each chunk's ogg_opus payload, runs a stateful Ogg parser,
// yields raw Opus packets so xiaozhi-esp32 firmware can play them directly.
//
// Streaming: chunks flow in as TTS renders, so first packet arrives well
// before full sentence is synthesized. Big-model voice (*_bigtts) supports
// emotion via the `additions` field (JSON-stringified).

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { TtsAudioChunk, TtsProvider, TtsSynthesizeRequest } from "./types.js";

export interface VolcengineTtsOptions {
  appId: string;
  apiKey?: string;
  apiKeyFile?: string;
  resourceId?: string;
  voice?: string;
  speedRatio?: number;
  emotion?: string;
  enableEmotion?: boolean;
  timeoutMs?: number;
}

const ENDPOINT = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
const DEFAULT_RESOURCE_ID = "volc.service_type.10029";
const DEFAULT_VOICE = "zh_female_wanwanxiaohe_moon_bigtts";
const SAMPLE_RATE = 24000;
const DEFAULT_TIMEOUT_MS = 30000;
const STREAM_END_CODE = 20000000;

export class VolcengineTtsProvider implements TtsProvider {
  readonly name = "volcengine-tts";
  readonly format = "opus-24khz-raw" as const;

  private readonly appId: string;
  private readonly resourceId: string;
  private readonly defaultVoice: string;
  private readonly speedRatio?: number;
  private readonly emotion?: string;
  private readonly enableEmotion: boolean;
  private readonly timeoutMs: number;
  private readonly tokenPromise: Promise<string>;

  constructor(opts: VolcengineTtsOptions) {
    if (!opts.appId) throw new Error("VolcengineTtsProvider: appId is required");
    if (!opts.apiKey && !opts.apiKeyFile) {
      throw new Error("VolcengineTtsProvider: apiKey or apiKeyFile is required");
    }
    this.appId = opts.appId;
    this.resourceId = opts.resourceId ?? DEFAULT_RESOURCE_ID;
    this.defaultVoice = opts.voice ?? DEFAULT_VOICE;
    this.speedRatio = opts.speedRatio;
    this.emotion = opts.emotion;
    this.enableEmotion = opts.enableEmotion ?? opts.emotion !== undefined;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.tokenPromise = opts.apiKey
      ? Promise.resolve(opts.apiKey)
      : readFile(opts.apiKeyFile!, "utf8").then((s) => s.trim());
  }

  async *synthesize(req: TtsSynthesizeRequest): AsyncIterable<TtsAudioChunk> {
    const token = await this.tokenPromise;
    const reqId = randomUUID();

    const audioParams: Record<string, unknown> = {
      format: "ogg_opus",
      sample_rate: SAMPLE_RATE,
    };
    if (this.speedRatio !== undefined) audioParams.speech_rate = this.speedRatio;

    const reqParams: Record<string, unknown> = {
      text: req.text,
      speaker: req.voice ?? this.defaultVoice,
      audio_params: audioParams,
    };

    if (this.enableEmotion || this.emotion) {
      const additions: Record<string, unknown> = {};
      if (this.enableEmotion) additions.enable_emotion = true;
      if (this.emotion) additions.emotion = this.emotion;
      reqParams.additions = JSON.stringify(additions);
    }

    const body = JSON.stringify({
      user: { uid: "openclaw-minion" },
      req_params: reqParams,
    });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-App-Key": this.appId,
          "X-Api-Access-Key": token,
          "X-Api-Resource-Id": this.resourceId,
          "X-Api-Request-Id": reqId,
        },
        body,
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => "<no body>");
        throw new Error(
          `Volcengine TTS HTTP ${res.status}: ${errText.slice(0, 200)}`,
        );
      }

      const lineDecoder = new TextDecoder("utf-8");
      const oggParser = new StreamingOggParser();
      let lineBuf = "";
      const reader = res.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          lineBuf += lineDecoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = lineBuf.indexOf("\n")) >= 0) {
            const line = lineBuf.slice(0, nl).trim();
            lineBuf = lineBuf.slice(nl + 1);
            if (!line) continue;
            for (const packet of consumeLine(line, oggParser)) {
              yield { audio: packet };
            }
          }
        }
        if (lineBuf.trim()) {
          for (const packet of consumeLine(lineBuf.trim(), oggParser)) {
            yield { audio: packet };
          }
        }
        for (const packet of oggParser.flush()) {
          if (packet.length > 0) yield { audio: packet };
        }
      } finally {
        reader.releaseLock();
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

function* consumeLine(
  line: string,
  parser: StreamingOggParser,
): IterableIterator<Uint8Array> {
  const obj = JSON.parse(line) as { code: number; message?: string; data?: string };
  if (obj.code === STREAM_END_CODE) return;
  if (obj.code !== 0) {
    throw new Error(`Volcengine TTS error code=${obj.code}: ${obj.message ?? ""}`);
  }
  if (!obj.data) return;
  const ogg = Buffer.from(obj.data, "base64");
  for (const packet of parser.feed(ogg)) {
    if (packet.length > 0) yield packet;
  }
}

/**
 * Stateful Ogg page parser. Feed bytes incrementally, yield Opus packets.
 * Handles packets that span multiple pages (lacing 255 continues into next
 * segment/page). Skips first 2 packets which are OpusHead + OpusTags metadata.
 */
class StreamingOggParser {
  private buffer = new Uint8Array(0);
  private packetParts: Uint8Array[] = [];
  private packetIndex = 0;

  *feed(chunk: Uint8Array): IterableIterator<Uint8Array> {
    if (chunk.length > 0) {
      const merged = new Uint8Array(this.buffer.length + chunk.length);
      merged.set(this.buffer);
      merged.set(chunk, this.buffer.length);
      this.buffer = merged;
    }

    let offset = 0;
    while (offset + 27 <= this.buffer.length) {
      if (
        this.buffer[offset] !== 0x4f ||
        this.buffer[offset + 1] !== 0x67 ||
        this.buffer[offset + 2] !== 0x67 ||
        this.buffer[offset + 3] !== 0x53
      ) {
        throw new Error(`Ogg parse: missing OggS magic at byte ${offset}`);
      }
      const numSegments = this.buffer[offset + 26]!;
      const tableEnd = offset + 27 + numSegments;
      if (tableEnd > this.buffer.length) break;

      let pageDataLen = 0;
      for (let i = 0; i < numSegments; i++) pageDataLen += this.buffer[offset + 27 + i]!;
      const pageEnd = tableEnd + pageDataLen;
      if (pageEnd > this.buffer.length) break;

      let dataOffset = tableEnd;
      for (let i = 0; i < numSegments; i++) {
        const lacing = this.buffer[offset + 27 + i]!;
        this.packetParts.push(this.buffer.subarray(dataOffset, dataOffset + lacing));
        dataOffset += lacing;
        if (lacing < 255) {
          const packet = concat(this.packetParts);
          this.packetParts = [];
          if (this.packetIndex >= 2) yield packet;
          this.packetIndex++;
        }
      }
      offset = pageEnd;
    }
    this.buffer = this.buffer.subarray(offset);
  }

  *flush(): IterableIterator<Uint8Array> {
    if (this.packetParts.length > 0) {
      const packet = concat(this.packetParts);
      this.packetParts = [];
      if (this.packetIndex >= 2) yield packet;
      this.packetIndex++;
    }
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}
