// Type definitions for the xiaozhi-esp32 WebSocket protocol.
// See PROTOCOL.md for the wire format.

export interface AudioParams {
  format: "opus";
  sample_rate: number;
  channels: number;
  frame_duration: number;
}

export interface ClientHello {
  type: "hello";
  version: number;
  features?: { mcp?: boolean; aec?: boolean };
  transport: "websocket";
  audio_params: AudioParams;
}

export interface ServerHello {
  type: "hello";
  transport: "websocket";
  session_id: string;
  audio_params: AudioParams;
}

export interface ClientListen {
  type: "listen";
  session_id: string;
  state: "start" | "stop" | "detect";
  mode: "auto" | "manual" | "realtime";
  text?: string;
}

export interface ClientAbort {
  type: "abort";
  session_id: string;
  reason?: string;
}

export interface JsonRpcEnvelope {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpMessage {
  type: "mcp";
  session_id: string;
  payload: JsonRpcEnvelope;
}

export type ClientMessage =
  | ClientHello
  | ClientListen
  | ClientAbort
  | McpMessage;

export interface ServerStt {
  type: "stt";
  session_id: string;
  text: string;
}

export interface ServerLlm {
  type: "llm";
  session_id: string;
  emotion: string;
  text: string;
}

export interface ServerTts {
  type: "tts";
  session_id: string;
  state: "start" | "stop" | "sentence_start";
  text?: string;
}

export interface ServerSystem {
  type: "system";
  session_id: string;
  command: "reboot";
}

export interface ServerAlert {
  type: "alert";
  session_id: string;
  status: string;
  message: string;
  emotion?: string;
}

// Server can also push `listen` to switch the device's mode (e.g. force
// realtime VAD instead of wake-word). Same shape as ClientListen.
export type ServerListen = ClientListen;

export type ServerMessage =
  | ServerHello
  | ServerStt
  | ServerLlm
  | ServerTts
  | ServerSystem
  | ServerAlert
  | ServerListen
  | McpMessage;

// BinaryProtocol V3 header. Audio frames carry Opus packets framed by this header.
export const BINARY_HEADER_SIZE = 4;
export const BINARY_TYPE_OPUS = 0;
export const BINARY_TYPE_JSON = 1;

export function encodeBinaryV3(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(BINARY_HEADER_SIZE + payload.length);
  out[0] = type & 0xff;
  out[1] = 0;
  out[2] = (payload.length >> 8) & 0xff;
  out[3] = payload.length & 0xff;
  out.set(payload, BINARY_HEADER_SIZE);
  return out;
}

export function decodeBinaryV3(
  buf: Uint8Array,
): { type: number; payload: Uint8Array } | null {
  if (buf.length < BINARY_HEADER_SIZE) return null;
  const type = buf[0]!;
  const size = (buf[2]! << 8) | buf[3]!;
  if (buf.length < BINARY_HEADER_SIZE + size) return null;
  return { type, payload: buf.slice(BINARY_HEADER_SIZE, BINARY_HEADER_SIZE + size) };
}
