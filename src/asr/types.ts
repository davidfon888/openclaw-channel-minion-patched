// ASR provider contract. Every backend (local-whisper, aliyun-nls, openai-api,
// xfyun, ...) must implement this. The channel never imports a specific
// backend directly — only the factory in ./index.ts does.

export interface AsrTranscribeRequest {
  /** Raw 16-bit little-endian mono PCM. */
  pcm: Uint8Array;
  /** PCM sample rate in Hz. Most providers want 16000. */
  sampleRate: number;
  /** ISO-style language hint, e.g. "zh", "en". */
  language: string;
}

export interface AsrTranscribeResult {
  text: string;
  /** Server-side processing time in ms (for telemetry, not strictly required). */
  durationMs?: number;
}

/**
 * Streaming session, optional. Providers that natively stream (Aliyun NLS,
 * iFlytek, etc.) implement this for lower latency. Local Whisper does not —
 * it returns null from startStream and the channel falls back to buffer-then-
 * transcribe.
 */
export interface AsrStreamSession {
  /** Push a small audio chunk (PCM frame) into the open stream. */
  push(pcm: Uint8Array): void;
  /** Close the input side, wait for final transcript. */
  finish(): Promise<AsrTranscribeResult>;
  /** Abort without waiting for a transcript. */
  abort(): void;
}

export interface AsrProvider {
  /** Friendly name for logs / errors. */
  readonly name: string;

  /** Transcribe a complete utterance. Always available. */
  transcribe(req: AsrTranscribeRequest): Promise<AsrTranscribeResult>;

  /**
   * Open a streaming session. Return null if the provider does not stream
   * natively — the channel will fall back to buffer-and-transcribe.
   */
  startStream?(opts: {
    sampleRate: number;
    language: string;
    /**
     * Fires for every transcript update. `sentenceEnd` is true on the final
     * partial of a sentence — the channel uses that to dispatch a turn to
     * the LLM without waiting for end-of-stream.
     */
    onPartial?: (text: string, sentenceEnd: boolean) => void;
    /**
     * Fires once if the underlying ASR session dies before finish() / abort()
     * is called (transport drop, server-side idle/timeout, task-failed, etc.).
     * After this fires, the AsrStreamSession is dead — push() is a no-op.
     * The channel uses this to transparently spawn a replacement stream so
     * the user doesn't end up in a "device sending audio, but server stopped
     * listening" zombie state. Only fires on involuntary failure; a normal
     * finish() does not invoke this.
     */
    onError?: (err: Error) => void;
  }): AsrStreamSession | null;
}
