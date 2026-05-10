// TTS factory. Same shape as ASR factory.

import type { TtsProvider } from "./types.js";
import { EdgeTtsProvider, type EdgeTtsOptions } from "./edge.js";

export type TtsConfig =
  | ({ provider: "edge" } & EdgeTtsOptions)
  // Stubs.
  | { provider: "aliyun-cosyvoice"; apiKey?: string; apiKeyFile?: string; voice?: string }
  | { provider: "openai-tts"; apiKey: string; voice?: string };

export function makeTtsProvider(cfg: TtsConfig): TtsProvider {
  switch (cfg.provider) {
    case "edge":
      return new EdgeTtsProvider(cfg);
    case "aliyun-cosyvoice":
    case "openai-tts":
      throw new Error(`TTS provider "${cfg.provider}" not yet implemented in v0.1.`);
  }
}

export type { TtsProvider, TtsSynthesizeRequest, TtsAudioChunk } from "./types.js";
export { EdgeTtsProvider } from "./edge.js";
