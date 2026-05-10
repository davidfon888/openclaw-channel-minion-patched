// TTS provider contract. Mirrors the ASR adapter shape — every backend
// (edge, aliyun, openai, ...) implements this so the channel never imports
// a specific backend directly.

export interface TtsSynthesizeRequest {
  text: string;
  /** Voice short name (e.g. "zh-CN-YunxiNeural"). */
  voice?: string;
  /** Rate adjustment, percent string like "+25%". */
  rate?: string;
  /** Pitch adjustment, e.g. "+10Hz". */
  pitch?: string;
}

/** A single audio chunk emitted by the provider during streaming synthesis. */
export interface TtsAudioChunk {
  /** Raw audio bytes. Format depends on the provider; see TtsProvider.format. */
  audio: Uint8Array;
}

export interface TtsProvider {
  readonly name: string;
  /**
   * Wire format the provider emits.
   * - "mp3-24khz" : Edge TTS default mp3, decode-on-receive
   * - "opus-24khz-raw": raw Opus packets (no container), one per chunk —
   *     what xiaozhi-esp32 firmware expects
   * - "opus-24khz-webm": Opus inside WebM container, needs framing
   * - "pcm-16-le-24khz": raw 16-bit little-endian PCM at 24kHz mono
   */
  readonly format:
    | "mp3-24khz"
    | "opus-24khz-raw"
    | "opus-24khz-webm"
    | "pcm-16-le-24khz";

  /**
   * Stream synthesis. The async iterator yields audio chunks as they arrive.
   * Caller is responsible for closing the stream early (returning) if no
   * longer needed.
   */
  synthesize(req: TtsSynthesizeRequest): AsyncIterable<TtsAudioChunk>;
}
