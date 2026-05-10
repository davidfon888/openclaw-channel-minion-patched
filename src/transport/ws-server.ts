// Minimal WebSocket server: accepts upgrades, runs auth gate on the request
// headers, completes the xiaozhi-style hello exchange, then hands the live
// socket off to whoever subscribes via onSession().
//
// This file owns transport only. Audio routing, ASR, TTS, LLM dispatch belong
// elsewhere — they listen for sessions emitted from here.

import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { ResolvedConfig, ResolvedDevice } from "../config.js";
import { makeAuthGate, FAILURE_CLOSE_CODES, type AuthResult } from "../auth/index.js";
import type {
  ClientMessage,
  ClientHello,
  ServerMessage,
  ServerHello,
} from "../protocol/messages.js";
import { decodeBinaryV3, BINARY_TYPE_OPUS, BINARY_TYPE_JSON } from "../protocol/messages.js";

export interface MinionSession {
  sessionId: string;
  device: ResolvedDevice;
  clientId: string;
  ws: WebSocket;
  send(msg: ServerMessage): void;
  sendAudio(opus: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface MinionSessionEvents {
  onMessage: (msg: ClientMessage) => void;
  onAudio: (opus: Uint8Array) => void;
  onClose: (code: number, reason: string) => void;
}

export interface SessionHandler {
  (session: MinionSession): MinionSessionEvents;
}

export class MinionWsServer {
  private readonly httpServer: Server;
  private readonly wss: WebSocketServer;
  private readonly authGate: ReturnType<typeof makeAuthGate>;
  private handler: SessionHandler | null = null;

  constructor(private readonly config: ResolvedConfig) {
    this.authGate = makeAuthGate(config);
    this.httpServer = createServer((_req, res) => {
      res.writeHead(404);
      res.end("not found");
    });
    this.wss = new WebSocketServer({ noServer: true });

    this.httpServer.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== this.config.path) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }
      const auth = this.authGate(req);
      if (!auth.ok) {
        const code = FAILURE_CLOSE_CODES[auth.reason];
        socket.write(
          `HTTP/1.1 401 Unauthorized\r\n` +
            `X-Auth-Reason: ${auth.reason}\r\n` +
            `X-Close-Code: ${code}\r\n\r\n`,
        );
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.onConnection(ws, req, auth);
      });
    });
  }

  onSession(handler: SessionHandler): void {
    this.handler = handler;
  }

  // True if we successfully bound the port; false if another process already
  // owns it (treated as "already running by a sibling instance" — no error).
  bound = false;

  start(): Promise<void> {
    return new Promise((resolve) => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          // Some other Node process (typically a previous register() call from
          // a CLI command or a running daemon) already owns this port. We are
          // a duplicate invocation — succeed silently so the host CLI is not
          // disrupted by inspect/list scans.
          this.httpServer.removeListener("error", onError);
          this.bound = false;
          resolve();
          return;
        }
        // Re-throw via uncaught — start() promise has already resolved or the
        // listen retry path is unsafe. Real fatal errors should bubble.
        throw err;
      };
      this.httpServer.once("error", onError);
      this.httpServer.listen(this.config.port, () => {
        this.httpServer.removeListener("error", onError);
        this.bound = true;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.bound) return;
    this.wss.close();
    await new Promise<void>((r) => this.httpServer.close(() => r()));
  }

  private onConnection(ws: WebSocket, _req: IncomingMessage, auth: AuthResult & { ok: true }): void {
    let helloSeen = false;
    let sessionId = "";
    let events: MinionSessionEvents | null = null;
    const helloTimeout = setTimeout(() => {
      if (!helloSeen) ws.close(4408, "hello timeout");
    }, 10_000);

    // Heartbeat: server-side WS ping every 10s keeps idle TCP path alive
    // through NAT/frp during one-way TTS playback; close cleanly if pong
    // is missing for 3+ intervals so the device reconnects fast instead
    // of waiting for TCP RST.
    let lastPong = Date.now();
    ws.on("pong", () => { lastPong = Date.now(); });
    const heartbeat = setInterval(() => {
      if (ws.readyState !== ws.OPEN) return;
      if (Date.now() - lastPong > 35_000) {
        ws.close(1011, "heartbeat timeout");
        return;
      }
      try { ws.ping(); } catch { /* ignore */ }
    }, 10_000);

    const sendJson = (msg: ServerMessage) => {
      ws.send(JSON.stringify(msg));
    };
    const sendAudio = (opus: Uint8Array) => {
      // BinaryProtocol V3 frame
      const header = new Uint8Array(4);
      header[0] = BINARY_TYPE_OPUS;
      header[1] = 0;
      header[2] = (opus.length >> 8) & 0xff;
      header[3] = opus.length & 0xff;
      const frame = new Uint8Array(header.length + opus.length);
      frame.set(header, 0);
      frame.set(opus, header.length);
      ws.send(frame);
    };

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const buf = data as Buffer;
        const decoded = decodeBinaryV3(buf);
        if (!decoded) return;
        if (decoded.type === BINARY_TYPE_OPUS && events) {
          events.onAudio(decoded.payload);
        } else if (decoded.type === BINARY_TYPE_JSON) {
          // Some firmware variants send JSON inside binary frames
          this.handleJsonText(buf.subarray(4).toString("utf8"), {
            getEvents: () => events,
            setHelloSeen: (id) => {
              helloSeen = true;
              sessionId = id;
              clearTimeout(helloTimeout);
            },
            startSession: (hello) => {
              sessionId = randomUUID();
              const reply: ServerHello = {
                type: "hello",
                transport: "websocket",
                session_id: sessionId,
                audio_params: {
                  format: "opus",
                  sample_rate: 24000,
                  channels: 1,
                  frame_duration: 20,
                },
              };
              sendJson(reply);
              const session: MinionSession = {
                sessionId,
                device: auth.device,
                clientId: auth.clientId,
                ws,
                send: sendJson,
                sendAudio,
                close: (c = 1000, r = "") => ws.close(c, r),
              };
              events = this.handler ? this.handler(session) : null;
              helloSeen = true;
              clearTimeout(helloTimeout);
            },
          });
        }
        return;
      }
      this.handleJsonText(data.toString(), {
        getEvents: () => events,
        setHelloSeen: (id) => {
          helloSeen = true;
          sessionId = id;
          clearTimeout(helloTimeout);
        },
        startSession: (hello) => {
          sessionId = randomUUID();
          const reply: ServerHello = {
            type: "hello",
            transport: "websocket",
            session_id: sessionId,
            audio_params: {
              format: "opus",
              sample_rate: 24000,
              channels: 1,
              frame_duration: 20,
            },
          };
          sendJson(reply);
          const session: MinionSession = {
            sessionId,
            device: auth.device,
            clientId: auth.clientId,
            ws,
            send: sendJson,
            sendAudio,
            close: (c = 1000, r = "") => ws.close(c, r),
          };
          events = this.handler ? this.handler(session) : null;
          helloSeen = true;
          clearTimeout(helloTimeout);
        },
      });
    });

    ws.on("close", (code, reason) => {
      clearTimeout(helloTimeout);
      clearInterval(heartbeat);
      events?.onClose(code, reason.toString());
    });
  }

  private handleJsonText(
    text: string,
    ctx: {
      getEvents: () => MinionSessionEvents | null;
      setHelloSeen: (id: string) => void;
      startSession: (hello: ClientHello) => void;
    },
  ): void {
    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(text) as ClientMessage;
    } catch {
      return;
    }
    if (parsed.type === "hello") {
      ctx.startSession(parsed);
      return;
    }
    const ev = ctx.getEvents();
    if (ev) ev.onMessage(parsed);
  }
}
