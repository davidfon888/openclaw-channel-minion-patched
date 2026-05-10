// Holds the PluginRuntime that OpenClaw passes via setRuntime in our
// defineChannelPluginEntry options. Anywhere downstream (subagent dispatch,
// outbound delivery) imports getMinionRuntime() from here.
//
// Uses OpenClaw's own SDK factory rather than rolling our own — dingtalk does
// the same: identical pattern, easier for anyone reading both extensions.

import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const runtimeStore = createPluginRuntimeStore<PluginRuntime>(
  "Minion runtime not initialized",
);

export const setMinionRuntime = runtimeStore.setRuntime;
export const getMinionRuntime = runtimeStore.getRuntime;
