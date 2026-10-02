import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { createMemoryPlugin } from "./host/v1/plugin.js"

export const PLUGIN_ID = "opencode-claude-memory"

export { createMemoryPlugin }

export const MemoryPlugin: Plugin = createMemoryPlugin()

const plugin: PluginModule = { id: PLUGIN_ID, server: MemoryPlugin }
export default plugin

export { MEMORY_AGENTS, type MemoryConfig, type MemoryOptions, MemoryOptionsSchema } from "./config.js"
export { MemoryStore } from "./store/MemoryStore.js"
