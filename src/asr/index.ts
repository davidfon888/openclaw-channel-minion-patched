// ASR factory. Look at config and return the right provider.

import type { AsrProvider } from "./types.js";
import { LocalWhisperProvider, type LocalWhisperOptions } from "./local-whisper.js";
import {
  AliyunParaformerProvider,
  type AliyunParaformerOptions,
} from "./aliyun-paraformer.js";

export type AsrConfig =
  | ({ provider: "local-whisper" } & LocalWhisperOptions)
  | ({ provider: "aliyun-paraformer" } & AliyunParaformerOptions)
  // Stubs for future providers.
  | { provider: "openai-whisper-api"; apiKey: string }
  | { provider: "xfyun"; appId: string; apiKey: string; apiSecret: string };

export function makeAsrProvider(cfg: AsrConfig): AsrProvider {
  switch (cfg.provider) {
    case "local-whisper":
      return new LocalWhisperProvider(cfg);
    case "aliyun-paraformer":
      return new AliyunParaformerProvider(cfg);
    case "openai-whisper-api":
    case "xfyun":
      throw new Error(
        `ASR provider "${cfg.provider}" not yet implemented in v0.1.`,
      );
  }
}

export type {
  AsrProvider,
  AsrStreamSession,
  AsrTranscribeRequest,
  AsrTranscribeResult,
} from "./types.js";
export { LocalWhisperProvider } from "./local-whisper.js";
export { AliyunParaformerProvider } from "./aliyun-paraformer.js";
