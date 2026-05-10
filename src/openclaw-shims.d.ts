// Local minimal type shims for the OpenClaw plugin SDK.
//
// At runtime, the gateway resolves `openclaw/*` imports through its own
// custom loader (the package isn't installed in our node_modules — we declare
// it as a peerDependency so the host provides it). This file gives our local
// `tsc --noEmit` typecheck just enough information to compile, without
// pulling the entire OpenClaw source tree into the type-graph.
//
// We deliberately use loose `unknown` / minimal interfaces rather than
// re-exporting verbatim. Anything we touch in our own code we declare by
// shape; everything else is `unknown` and we narrow at call sites.

declare module "openclaw/plugin-sdk/runtime-store" {
  export interface PluginRuntimeStore<T> {
    setRuntime(rt: T): void;
    getRuntime(): T;
  }
  export function createPluginRuntimeStore<T>(notInitMessage: string): PluginRuntimeStore<T>;
}

declare module "openclaw/plugin-sdk/core" {
  // The minimum MsgContext shape we construct for our inbound STT turns.
  // All fields except Body/SessionKey are optional in the real type; we only
  // ship what's meaningful for a voice channel.
  export interface MinionMsgContext {
    Body: string;
    BodyForAgent?: string;
    SessionKey: string;
    AccountId?: string;
    From?: string;
    To?: string;
    ChatType?: string;
    [key: string]: unknown;
  }

  // The reply dispatcher's per-chunk callback payload — only the fields we
  // actually consume.
  export interface MinionDispatchPayload {
    text?: string;
    [key: string]: unknown;
  }

  // PluginRuntime — only the surfaces we actually call.
  export interface PluginRuntime {
    subagent: {
      run(params: {
        sessionKey: string;
        message: string;
        provider?: string;
        model?: string;
        extraSystemPrompt?: string;
        lane?: string;
        deliver?: boolean;
        idempotencyKey?: string;
      }): Promise<{ runId: string }>;
      waitForRun(params: {
        runId: string;
        timeoutMs?: number;
      }): Promise<{ status: "ok" | "error" | "timeout"; error?: string }>;
      getSessionMessages(params: {
        sessionKey: string;
        limit?: number;
      }): Promise<{ messages: unknown[] }>;
      deleteSession(params: { sessionKey: string; deleteTranscript?: boolean }): Promise<void>;
    };
    channel: {
      reply: {
        dispatchReplyWithBufferedBlockDispatcher(params: {
          ctx: MinionMsgContext;
          cfg: OpenClawConfig;
          dispatcherOptions: {
            responsePrefix?: string;
            deliver: (payload: MinionDispatchPayload) => Promise<void> | void;
            [key: string]: unknown;
          };
          replyOptions?: unknown;
          replyResolver?: unknown;
        }): Promise<unknown>;
        [key: string]: unknown;
      };
      session: {
        recordInboundSession(params: unknown): Promise<unknown> | unknown;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };
  }

  // OpenClawPluginApi — register-time surface.
  export interface OpenClawPluginApi {
    registrationMode: "cli-metadata" | "full" | string;
    runtime: PluginRuntime;
    config: unknown;
    logger: {
      info(msg: string): void;
      warn(msg: string): void;
      error(msg: string): void;
      debug?(msg: string): void;
    };
    registerChannel(params: { plugin: ChannelPlugin }): void;
    registerGatewayMethod(name: string, handler: (ctx: unknown) => Promise<unknown>): void;
  }

  // OpenClawConfig — opaque shape we navigate by index access only.
  export interface OpenClawConfig {
    [key: string]: unknown;
  }

  // ChannelPlugin — keep loose, our concrete plugin object satisfies a subset.
  export interface ChannelPlugin<ResolvedAccount = unknown> {
    id: string;
    meta: {
      id: string;
      label: string;
      selectionLabel: string;
      docsPath: string;
      blurb: string;
      order?: number;
      aliases?: readonly string[];
      [key: string]: unknown;
    };
    capabilities: {
      chatTypes: ReadonlyArray<string>;
      [key: string]: unknown;
    };
    config: {
      listAccountIds(cfg: OpenClawConfig): string[];
      resolveAccount(cfg: OpenClawConfig, accountId?: string | null): ResolvedAccount;
      isEnabled?(account: ResolvedAccount, cfg: OpenClawConfig): boolean;
      isConfigured?(
        account: ResolvedAccount,
        cfg: OpenClawConfig,
      ): boolean | Promise<boolean>;
      [key: string]: unknown;
    };
    outbound?: {
      deliveryMode: "direct" | "gateway" | "hybrid";
      sendText?(ctx: unknown): Promise<unknown>;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }

  export interface DefinedChannelPluginEntry<TPlugin> {
    id: string;
    name: string;
    description: string;
    register(api: OpenClawPluginApi): void;
    channelPlugin: TPlugin;
  }

  export function defineChannelPluginEntry<TPlugin>(opts: {
    id: string;
    name: string;
    description: string;
    plugin: TPlugin;
    setRuntime?(rt: PluginRuntime): void;
    registerCliMetadata?(api: OpenClawPluginApi): void;
    registerFull?(api: OpenClawPluginApi): void;
  }): DefinedChannelPluginEntry<TPlugin>;
}

declare module "openclaw/plugin-sdk/outbound-runtime" {
  import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
  // Loose shim — the real type carries many optional knobs we don't touch.
  // We only need a path to actively push a text payload into another
  // channel (e.g. forward the full markdown table into the user's DingTalk
  // thread when the voice channel can't render it). Returns per-payload
  // delivery results; we don't introspect them.
  export function deliverOutboundPayloads(params: {
    cfg: OpenClawConfig;
    channel: string;
    to: string;
    accountId?: string;
    payloads: Array<{ text?: string; [key: string]: unknown }>;
    [key: string]: unknown;
  }): Promise<unknown[]>;
}
