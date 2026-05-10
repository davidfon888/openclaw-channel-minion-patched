import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { WebSocket } from "ws";
import { MinionWsServer } from "../src/transport/ws-server.js";
import type { ResolvedConfig } from "../src/config.js";

const SECRET = "test-secret-xyz";
const DEVICE = "AA:BB:CC:DD:EE:FF";
const CLIENT = "uuid-test-1";

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    port: 0,
    path: "/minion",
    requireHmac: false,
    timestampToleranceSec: 60,
    rateLimit: { perDevicePerMinute: 100 },
    devices: new Map([
      ["AA:BB:CC:DD:EE:FF", {
        deviceId: "AA:BB:CC:DD:EE:FF",
        secret: SECRET,
        sessionKey: "agent:main:test",
        allowedIps: [],
      }],
    ]),
    ...overrides,
  };
}

async function startOnRandomPort(config: ResolvedConfig): Promise<{ server: MinionWsServer; port: number }> {
  const server = new MinionWsServer(config);
  await server.start();
  // The httpServer is private; reach in via cast since it's a test.
  const port = ((server as unknown as { httpServer: { address(): { port: number } } }).httpServer.address()).port;
  return { server, port };
}

function rawUpgrade(port: number, headers: Record<string, string>): Promise<{ statusCode: number; reasonHeader: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/minion",
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
        ...headers,
      },
    });
    req.on("response", (res: IncomingMessage) => {
      const reasonHeader = res.headers["x-auth-reason"];
      resolve({
        statusCode: res.statusCode ?? 0,
        reasonHeader: Array.isArray(reasonHeader) ? reasonHeader[0] : reasonHeader,
      });
      res.resume();
    });
    req.on("upgrade", (res) => {
      resolve({ statusCode: res.statusCode ?? 101, reasonHeader: undefined });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("ws handshake (end-to-end)", () => {
  let server: MinionWsServer;
  let port: number;

  beforeEach(async () => {
    const started = await startOnRandomPort(makeConfig());
    server = started.server;
    port = started.port;
  });

  afterEach(async () => {
    await server.stop();
  });

  it("rejects upgrade without auth headers", async () => {
    const { statusCode, reasonHeader } = await rawUpgrade(port, {});
    expect(statusCode).toBe(401);
    expect(reasonHeader).toBe("missing_device_id");
  });

  it("rejects upgrade with bad bearer", async () => {
    const { statusCode, reasonHeader } = await rawUpgrade(port, {
      "Device-Id": DEVICE,
      "Client-Id": CLIENT,
      "Protocol-Version": "1",
      Authorization: "Bearer wrong",
    });
    expect(statusCode).toBe(401);
    expect(reasonHeader).toBe("bad_token");
  });

  it("accepts valid upgrade and replies to hello", async () => {
    const url = `ws://127.0.0.1:${port}/minion`;
    const ws = new WebSocket(url, {
      headers: {
        "Device-Id": DEVICE,
        "Client-Id": CLIENT,
        "Protocol-Version": "1",
        Authorization: `Bearer ${SECRET}`,
      },
    });

    const helloPromise = new Promise<unknown>((resolve, reject) => {
      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        resolve(JSON.parse(data.toString()));
      });
      ws.on("error", reject);
      setTimeout(() => reject(new Error("timeout waiting for hello reply")), 3000);
    });

    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    ws.send(JSON.stringify({
      type: "hello",
      version: 1,
      transport: "websocket",
      audio_params: { format: "opus", sample_rate: 16000, channels: 1, frame_duration: 60 },
    }));

    const reply = (await helloPromise) as Record<string, unknown>;
    expect(reply.type).toBe("hello");
    expect(reply.transport).toBe("websocket");
    expect(typeof reply.session_id).toBe("string");
    ws.close();
    await new Promise<void>((r) => ws.once("close", () => r()));
  });
});

describe("ws handshake strict HMAC mode", () => {
  let server: MinionWsServer;
  let port: number;

  beforeEach(async () => {
    const started = await startOnRandomPort(makeConfig({ requireHmac: true }));
    server = started.server;
    port = started.port;
  });

  afterEach(async () => {
    await server.stop();
  });

  it("rejects when signature missing", async () => {
    const { statusCode, reasonHeader } = await rawUpgrade(port, {
      "Device-Id": DEVICE,
      "Client-Id": CLIENT,
      "Protocol-Version": "1",
      Authorization: `Bearer ${SECRET}`,
    });
    expect(statusCode).toBe(401);
    expect(reasonHeader).toBe("stale_timestamp");
  });

  it("accepts when signature is valid", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac("sha256", SECRET).update(`${DEVICE}\n${CLIENT}\n${ts}`).digest("hex");
    const url = `ws://127.0.0.1:${port}/minion`;
    const ws = new WebSocket(url, {
      headers: {
        "Device-Id": DEVICE,
        "Client-Id": CLIENT,
        "Protocol-Version": "1",
        Authorization: `Bearer ${SECRET}`,
        "X-Timestamp": ts,
        "X-Signature": sig,
      },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
      setTimeout(() => reject(new Error("timeout")), 3000);
    });
    ws.close();
    await new Promise<void>((r) => ws.once("close", () => r()));
  });
});
