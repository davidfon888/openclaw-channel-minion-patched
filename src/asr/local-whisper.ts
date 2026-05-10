// Local-Whisper provider. Calls the Python sidecar at sidecar/asr/asr-server.py
// over plain HTTP. The sidecar runs faster-whisper with the same tuning as
// the user's existing chat.py.

import type {
  AsrProvider,
  AsrTranscribeRequest,
  AsrTranscribeResult,
} from "./types.js";

export interface LocalWhisperOptions {
  /** Sidecar URL, default http://127.0.0.1:8789 */
  url?: string;
  /** Per-request timeout in ms. medium model on M4 finishes well under 5s. */
  timeoutMs?: number;
}

export class LocalWhisperProvider implements AsrProvider {
  readonly name = "local-whisper";
  private readonly url: string;
  private readonly timeoutMs: number;

  constructor(opts: LocalWhisperOptions = {}) {
    this.url = (opts.url ?? "http://127.0.0.1:8789").replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async transcribe(req: AsrTranscribeRequest): Promise<AsrTranscribeResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.url}/transcribe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Sample-Rate": String(req.sampleRate),
          "X-Language": req.language,
        },
        body: req.pcm,
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`asr sidecar HTTP ${res.status}: ${detail}`);
      }
      const json = (await res.json()) as {
        ok: boolean;
        text?: string;
        duration_ms?: number;
        error?: string;
      };
      if (!json.ok) {
        throw new Error(`asr sidecar error: ${json.error ?? "unknown"}`);
      }
      return { text: json.text ?? "", durationMs: json.duration_ms };
    } finally {
      clearTimeout(timer);
    }
  }

  async healthcheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/healthz`, { method: "GET" });
      if (!res.ok) return false;
      const json = (await res.json()) as { ok: boolean };
      return json.ok === true;
    } catch {
      return false;
    }
  }
}
