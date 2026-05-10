// Aliyun Bailian (DashScope) Paraformer real-time ASR provider.
//
// Protocol summary (full reference: PROTOCOL.md):
//   - WebSocket: wss://dashscope.aliyuncs.com/api-ws/v1/inference
//   - Auth: Authorization: Bearer <api_key>
//   - Lifecycle:
//       1. WS connect (one connection can host many tasks)
//       2. send run-task JSON (assigns task_id, picks model + audio params)
//       3. wait for task-started event
//       4. stream PCM 16-bit LE mono binary frames
//       5. send finish-task JSON
//       6. collect result-generated events; settle on task-finished
//
// We expose two surfaces:
//   - transcribe(req): one-shot. Opens its own WS per call. Simple.
//   - startStream(opts): streaming. Long-lived task, partial transcripts.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type {
  AsrProvider,
  AsrStreamSession,
  AsrTranscribeRequest,
  AsrTranscribeResult,
} from "./types.js";

const ENDPOINT = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
const DEFAULT_MODEL = "paraformer-realtime-v2";
const DEFAULT_AUDIO_CHUNK_MS = 100;

export interface AliyunParaformerOptions {
  /** API key string OR path to a 600-mode file containing it on its own line. */
  apiKey?: string;
  apiKeyFile?: string;
  /** Model name; defaults to paraformer-realtime-v2. */
  model?: string;
  /** Endpoint override (testing or different region). */
  endpoint?: string;
  /** Per-task overall timeout, ms. */
  taskTimeoutMs?: number;
  /** Send `heartbeat: true` so server keeps connection alive in long silence. */
  heartbeat?: boolean;
  /**
   * Audio wire format. Defaults to "opus" because xiaozhi-esp32 firmware
   * sends 16 kHz Opus 60 ms frames. Set to "pcm" for desktop test clients
   * that send raw PCM.
   */
  audioFormat?: "opus" | "pcm";
}

interface RunTaskMessage {
  header: { action: "run-task"; task_id: string; streaming: "duplex" };
  payload: {
    task_group: "audio";
    task: "asr";
    function: "recognition";
    model: string;
    parameters: {
      format: "pcm" | "opus";
      sample_rate: number;
      language_hints?: string[];
      heartbeat?: boolean;
      punctuation_prediction_enabled?: boolean;
      inverse_text_normalization_enabled?: boolean;
    };
    input: Record<string, never>;
  };
}

interface FinishTaskMessage {
  header: { action: "finish-task"; task_id: string; streaming: "duplex" };
  payload: { input: Record<string, never> };
}

interface ServerHeader {
  task_id: string;
  event: "task-started" | "result-generated" | "task-finished" | "task-failed";
  error_code?: string;
  error_message?: string;
  attributes?: Record<string, unknown>;
}

interface ResultGeneratedPayload {
  output?: {
    sentence?: {
      text?: string;
      sentence_end?: boolean;
    };
  };
}

function readApiKey(opts: AliyunParaformerOptions): string {
  if (opts.apiKey) return opts.apiKey;
  if (opts.apiKeyFile) return readFileSync(opts.apiKeyFile, "utf8").trim();
  throw new Error("AliyunParaformerProvider needs apiKey or apiKeyFile");
}

function chunkPcm(pcm: Uint8Array, sampleRate: number, chunkMs: number): Uint8Array[] {
  // 16-bit mono => 2 bytes per sample
  const samplesPerChunk = Math.floor((sampleRate * chunkMs) / 1000);
  const bytesPerChunk = samplesPerChunk * 2;
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < pcm.length; i += bytesPerChunk) {
    chunks.push(pcm.subarray(i, Math.min(i + bytesPerChunk, pcm.length)));
  }
  return chunks;
}

export class AliyunParaformerProvider implements AsrProvider {
  readonly name = "aliyun-paraformer";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly taskTimeoutMs: number;
  private readonly heartbeat: boolean;
  private readonly audioFormat: "opus" | "pcm";

  // Shared long-lived WebSocket. DashScope allows running consecutive tasks
  // over the same connection, so we keep one open across turns instead of
  // doing a fresh TLS+WS handshake for every utterance — that handshake
  // adds ~100-300ms of perceived latency at the start of every reply.
  //
  // Concurrency: we serialize tasks via wsLock. DashScope's ASR endpoint is
  // a single-task-at-a-time channel, and the Minion device only ever runs
  // one turn at a time anyway (debounced + dispatch-queued upstream), so a
  // simple FIFO mutex is sufficient.
  private sharedWs: WebSocket | null = null;
  private wsLock: Promise<void> = Promise.resolve();

  constructor(opts: AliyunParaformerOptions = {}) {
    this.apiKey = readApiKey(opts);
    this.model = opts.model ?? DEFAULT_MODEL;
    this.endpoint = opts.endpoint ?? ENDPOINT;
    this.taskTimeoutMs = opts.taskTimeoutMs ?? 30_000;
    this.heartbeat = opts.heartbeat ?? false;
    this.audioFormat = opts.audioFormat ?? "opus";
  }

  // [Per-task WS] ALWAYS open fresh. Sharing the WS across tasks caused
  // chronic 1007 stalls because errors poisoned the connection and
  // accumulated state (paused mutex, stale listeners, half-closed sockets).
  // Per-task connection isolates each conversation: if Aliyun closes one
  // mid-task, only that one task fails — next conversation starts clean.
  // Trade-off: ~100-200ms extra TLS+WS handshake per utterance.
  private async ensureWs(): Promise<WebSocket> {
    return await this.openSocket();
  }

  // Acquire exclusive use of the shared WebSocket for one task. Tasks run
  // FIFO: each waits for the previous holder to release before getting the
  // socket. The returned `release` MUST be called exactly once (typically
  // in a finally block) regardless of success or failure, or subsequent
  // tasks will deadlock.
  private async acquireWs(): Promise<{ ws: WebSocket; release: () => void }> {
    const prev = this.wsLock;
    let release!: () => void;
    this.wsLock = new Promise<void>((res) => { release = res; });
    try {
      await prev;
    } catch { /* ignore */ }
    let ws: WebSocket;
    try {
      ws = await this.ensureWs();
    } catch (err) {
      release();
      throw err;
    }
    return { ws, release };
  }

  async transcribe(req: AsrTranscribeRequest): Promise<AsrTranscribeResult> {
    const t0 = Date.now();
    const taskId = randomUUID().replace(/-/g, "");
    const ws = await this.openSocket();

    const sentences: string[] = [];
    let resolveDone!: () => void;
    let rejectDone!: (err: Error) => void;
    const done = new Promise<void>((res, rej) => {
      resolveDone = res;
      rejectDone = rej;
    });
    const timer = setTimeout(
      () => rejectDone(new Error("paraformer task timed out")),
      this.taskTimeoutMs,
    );

    let started = false;

    ws.on("message", (data, isBinary) => {
      if (isBinary) return; // server only sends JSON for ASR
      let msg: { header: ServerHeader; payload?: ResultGeneratedPayload };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      const ev = msg.header?.event;
      if (ev === "task-started") {
        started = true;
        // Stream the PCM in chunks.
        for (const c of chunkPcm(req.pcm, req.sampleRate, DEFAULT_AUDIO_CHUNK_MS)) {
          ws.send(c);
        }
        const fin: FinishTaskMessage = {
          header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
          payload: { input: {} },
        };
        ws.send(JSON.stringify(fin));
      } else if (ev === "result-generated") {
        const s = msg.payload?.output?.sentence;
        if (s?.text && s.sentence_end) sentences.push(s.text);
      } else if (ev === "task-finished") {
        resolveDone();
      } else if (ev === "task-failed") {
        rejectDone(
          new Error(`paraformer ${msg.header.error_code}: ${msg.header.error_message}`),
        );
      }
    });

    ws.on("error", (err) => rejectDone(err));
    ws.on("close", (code, reason) => {
      if (!started) {
        rejectDone(new Error(`ws closed before task-started: ${code} ${reason.toString()}`));
      }
    });

    const run: RunTaskMessage = {
      header: { action: "run-task", task_id: taskId, streaming: "duplex" },
      payload: {
        task_group: "audio",
        task: "asr",
        function: "recognition",
        model: this.model,
        parameters: {
          format: this.audioFormat,
          sample_rate: req.sampleRate,
          language_hints: [req.language],
          punctuation_prediction_enabled: true,
          inverse_text_normalization_enabled: true,
          heartbeat: this.heartbeat,
        },
        input: {},
      },
    };
    ws.send(JSON.stringify(run));

    try {
      await done;
    } finally {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    return { text: sentences.join("").trim(), durationMs: Date.now() - t0 };
  }

  startStream(opts: {
    sampleRate: number;
    language: string;
    onPartial?: (text: string, sentenceEnd: boolean) => void;
    onError?: (err: Error) => void;
  }): AsrStreamSession {
    const taskId = randomUUID().replace(/-/g, "");
    const sentences: string[] = [];
    let started = false;
    let settled = false;

    // Deferred: WS reference, set once acquireWs() resolves.
    let socketReady!: (ws: WebSocket) => void;
    let socketFailed!: (err: Error) => void;
    const socketPromise = new Promise<WebSocket>((res, rej) => {
      socketReady = res;
      socketFailed = rej;
    });
    socketPromise.catch(() => undefined);

    // Deferred: resolves on `task-started` so push() can hold its frames
    // until the server is ready to accept them. Replaces the old 50ms
    // polling loop.
    let signalStarted!: () => void;
    let signalStartFailed!: (err: Error) => void;
    const startedPromise = new Promise<void>((res, rej) => {
      signalStarted = res;
      signalStartFailed = rej;
    });
    startedPromise.catch(() => undefined);
    const startTimer = setTimeout(() => {
      if (!started) signalStartFailed(new Error("paraformer task-started timeout"));
    }, this.taskTimeoutMs);

    const t0 = Date.now();
    let resolveFinished!: (result: AsrTranscribeResult) => void;
    let rejectFinished!: (err: Error) => void;
    const finished = new Promise<AsrTranscribeResult>((res, rej) => {
      resolveFinished = res;
      rejectFinished = rej;
    });
    // No-op rejection handler so a server-side timeout (e.g. paraformer
    // IdleTimeout when the device VAD goes silent in realtime mode) does
    // not surface as an unhandled promise rejection and crash the
    // channel. finish() awaits the same promise and will see the error.
    finished.catch(() => undefined);

    // Holds the lock release returned by acquireWs(). Set once acquired,
    // cleared on settle so we never release twice.
    let release: (() => void) | null = null;
    // Captured handler references so we can detach them from the shared WS
    // on settle without affecting other tasks. The shared WS is long-lived
    // and reused across many tasks; if we leak listeners on it the
    // EventEmitter's MaxListeners (default 10) trips after ~10 tasks and
    // we get the silent stall pattern documented in memory.
    let messageHandler: ((data: unknown, isBinary: boolean) => void) | null = null;
    let transportError: ((err: Error) => void) | null = null;
    let transportClose: ((code: number, reason: Buffer) => void) | null = null;
    let activeWs: WebSocket | null = null;

    // True once the caller has voluntarily called finish() or abort(). Used
    // to distinguish "expected end-of-task" from "involuntary death" so we
    // only fire onError in the latter case — finish() already returns the
    // result via its own promise, no need to also notify via callback.
    let voluntaryFinish = false;

    const settle = (
      action: "resolve" | "reject",
      payload: AsrTranscribeResult | Error,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(startTimer);
      if (activeWs) {
        if (messageHandler) {
          try { activeWs.off("message", messageHandler); } catch { /* ignore */ }
        }
        if (transportError) {
          try { activeWs.off("error", transportError); } catch { /* ignore */ }
        }
        if (transportClose) {
          try { activeWs.off("close", transportClose); } catch { /* ignore */ }
        }
      }
      messageHandler = null;
      transportError = null;
      transportClose = null;
      if (release) {
        try { release(); } catch { /* ignore */ }
        release = null;
      }
      // [Per-task WS] Close the per-task connection. Each task has its own
      // socket (see ensureWs), so closing here doesn\u0027t affect other tasks.
      if (activeWs && activeWs.readyState !== WebSocket.CLOSED) {
        try { activeWs.close(); } catch { /* ignore */ }
      }
      if (action === "resolve") resolveFinished(payload as AsrTranscribeResult);
      else rejectFinished(payload as Error);
      if (action === "reject" && !voluntaryFinish) {
        try { opts.onError?.(payload as Error); } catch { /* ignore */ }
      }
    };

    (async () => {
      try {
        const acquired = await this.acquireWs();
        release = acquired.release;
        const ws = acquired.ws;
        activeWs = ws;
        socketReady(ws);

        messageHandler = (data, _isBinary) => {
          // _isBinary kept for type compatibility; ASR control channel is
          // text only in normal operation.
          let msg: { header: ServerHeader; payload?: ResultGeneratedPayload };
          try {
            msg = JSON.parse((data as Buffer | string).toString());
          } catch {
            return;
          }
          if (msg.header?.task_id !== taskId) {
            // Late event from a previous task on the same WS — ignore.
            return;
          }
          const ev = msg.header.event;
          if (ev === "task-started") {
            started = true;
            console.log(`[paraformer] task-started task=${taskId}`);
            signalStarted();
          } else if (ev === "result-generated") {
            const s = msg.payload?.output?.sentence;
            if (s?.text) {
              const ended = !!s.sentence_end;
              if (ended) sentences.push(s.text);
              opts.onPartial?.(s.text, ended);
            }
          } else if (ev === "task-finished") {
            console.log(
              `[paraformer] task-finished task=${taskId} sentences=${sentences.length}`,
            );
            settle("resolve", { text: sentences.join("").trim(), durationMs: Date.now() - t0 });
          } else if (ev === "task-failed") {
            console.log(
              `[paraformer] task-failed task=${taskId} code=${msg.header.error_code} msg=${msg.header.error_message}`,
            );
            settle(
              "reject",
              new Error(`paraformer ${msg.header.error_code}: ${msg.header.error_message}`),
            );
          }
        };
        ws.on("message", messageHandler);

        // Attach one-shot error/close handlers scoped to this task so a
        // mid-task socket drop fails the in-flight task instead of hanging
        // its `finish()` forever. They MUST be detached in settle() — the
        // WS is long-lived and reused, so unremoved `once` handlers
        // accumulate across tasks and eventually trip MaxListeners.
        const onTransportError = (err: Error) => {
          if (!settled) settle("reject", err);
        };
        const onTransportClose = (code: number, reason: Buffer) => {
          if (!settled) {
            settle(
              "reject",
              new Error(`paraformer ws closed mid-task: ${code} ${reason.toString()}`),
            );
          }
        };
        transportError = onTransportError;
        transportClose = onTransportClose;
        ws.once("error", onTransportError);
        ws.once("close", onTransportClose);

        const run: RunTaskMessage = {
          header: { action: "run-task", task_id: taskId, streaming: "duplex" },
          payload: {
            task_group: "audio",
            task: "asr",
            function: "recognition",
            model: this.model,
            parameters: {
              format: this.audioFormat,
              sample_rate: opts.sampleRate,
              language_hints: [opts.language],
              punctuation_prediction_enabled: true,
              inverse_text_normalization_enabled: true,
              heartbeat: this.heartbeat,
            },
            input: {},
          },
        };
        ws.send(JSON.stringify(run));
      } catch (err) {
        socketFailed(err as Error);
        signalStartFailed(err as Error);
        settle("reject", err as Error);
      }
    })();

    const session: AsrStreamSession = {
      push: (pcm: Uint8Array) => {
        socketPromise
          .then(async (ws) => {
            await startedPromise;
            if (!settled && ws.readyState === WebSocket.OPEN) ws.send(pcm);
          })
          .catch(() => undefined);
      },
      finish: async () => {
        voluntaryFinish = true;
        const ws = await socketPromise;
        try {
          await startedPromise;
        } catch (err) {
          // task never started — the settle() inside the message-handler
          // path won't fire, so make sure we surface the error and free
          // the lock here.
          settle("reject", err as Error);
          throw err;
        }
        if (settled) {
          // Already resolved/rejected (e.g. server-side timeout fired
          // before finish() was called). Just await the existing outcome.
          return finished;
        }
        const fin: FinishTaskMessage = {
          header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
          payload: { input: {} },
        };
        try {
          ws.send(JSON.stringify(fin));
        } catch (err) {
          settle("reject", err as Error);
        }
        // settle() runs from the message handler when task-finished arrives;
        // do NOT close the WS — it's reused by the next task.
        return finished;
      },
      abort: () => {
        if (settled) return;
        voluntaryFinish = true;
        // Best-effort: tell server we're done so it stops billing this
        // task. If WS is dead, just give up — settle() will reject and
        // release the lock for the next task.
        const ws = activeWs;
        if (ws && ws.readyState === WebSocket.OPEN && started) {
          try {
            const fin: FinishTaskMessage = {
              header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
              payload: { input: {} },
            };
            ws.send(JSON.stringify(fin));
          } catch { /* ignore */ }
        }
        settle("reject", new Error("aborted"));
      },
    };
    return session;
  }

  private openSocket(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.endpoint, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      ws.once("open", () => resolve(ws));
      ws.once("error", (err) => reject(err));
    });
  }
}
