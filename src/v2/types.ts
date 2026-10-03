// Type aliases derived from @opencode/plugin so the V2 adapter never spells out
// hand-written subsets of the plugin context or event shapes (see src/sdk.ts for V1).
import type { Plugin } from "@opencode/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"

export type V2PluginContext = Plugin.Context

export type V2Event =
  Awaited<ReturnType<V2PluginContext["event"]["subscribe"]>> extends AsyncIterable<infer E> ? E : never

// The `context` hook event: assembled system/messages/tools/options for one model request.
export type V2ContextEvent = SessionContext

export type V2AgentInfo = Awaited<ReturnType<V2PluginContext["agent"]["list"]>>["data"][number]
