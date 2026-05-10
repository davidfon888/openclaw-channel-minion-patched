// Microsoft Edge TTS provider via the msedge-tts npm package.
// The same service the user's chat.py already used (edge-tts in Python) —
// free, no API key, decent Mandarin voices.
//
// Output format is configurable:
//   - "opus" (default) — uses WEBM_24KHZ_16BIT_MONO_OPUS, then strips the
//       WebM container so each yielded chunk is a raw Opus packet ready for
//       xiaozhi-esp32 firmware.
//   - "mp3" — passes mp3 chunks through unchanged. Useful for desktop test
//       clients that want to afplay the result; ESP32 firmware won't decode.

import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import type { TtsAudioChunk, TtsProvider, TtsSynthesizeRequest } from "./types.js";
import { parseOpusFromWebmStream } from "./webm-parser.js";

export interface EdgeTtsOptions {
  voice?: string;
  rate?: string;
  pitch?: string;
  /** Output format. Defaults to "opus" for ESP32 compatibility. */
  format?: "opus" | "mp3";
}

const DEFAULT_VOICE = "zh-CN-YunxiNeural";
const DEFAULT_RATE = "+25%";
const DEFAULT_PITCH = "+10Hz";

export class EdgeTtsProvider implements TtsProvider {
  readonly name = "edge-tts";
  readonly format: "opus-24khz-raw" | "mp3-24khz";
  private readonly defaults: Required<Pick<EdgeTtsOptions, "voice" | "rate" | "pitch">>;
  private readonly outputMode: "opus" | "mp3";

  constructor(opts: EdgeTtsOptions = {}) {
    this.defaults = {
      voice: opts.voice ?? DEFAULT_VOICE,
      rate: opts.rate ?? DEFAULT_RATE,
      pitch: opts.pitch ?? DEFAULT_PITCH,
    };
    this.outputMode = opts.format ?? "opus";
    this.format = this.outputMode === "opus" ? "opus-24khz-raw" : "mp3-24khz";
  }

  async *synthesize(req: TtsSynthesizeRequest): AsyncIterable<TtsAudioChunk> {
    const tts = new MsEdgeTTS();
    const edgeFmt =
      this.outputMode === "opus"
        ? OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS
        : OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;
    await tts.setMetadata(req.voice ?? this.defaults.voice, edgeFmt);
    const { audioStream } = tts.toStream(req.text, {
      rate: req.rate ?? this.defaults.rate,
      pitch: req.pitch ?? this.defaults.pitch,
    } as never);

    if (this.outputMode === "mp3") {
      try {
        for await (const c of audioStream as AsyncIterable<Buffer | Uint8Array>) {
          const buf = c instanceof Uint8Array ? c : new Uint8Array(c);
          if (buf.length > 0) yield { audio: buf };
        }
      } finally {
        try { tts.close(); } catch { /* ignore */ }
      }
      return;
    }

    // Opus mode: parse the WebM container as it arrives. Each Opus packet
    // is yielded the moment its SimpleBlock has fully arrived, so the first
    // audio frame can reach the device while the rest of the TTS audio is
    // still being downloaded from Microsoft. For typical replies this cuts
    // first-byte-out latency from "wait for full WebM" (often 1-3s on long
    // sentences) down to "EBML header + first Cluster" (a few hundred ms).
    try {
      for await (const opus of parseOpusFromWebmStream(
        audioStream as AsyncIterable<Buffer | Uint8Array>,
      )) {
        if (opus.length > 0) yield { audio: opus };
      }
    } finally {
      try { tts.close(); } catch { /* ignore */ }
    }
  }
}
