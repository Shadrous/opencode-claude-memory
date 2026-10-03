// A V1-shaped client over the V2 plugin context, so RecallCoordinator,
// ExtractionCoordinator and the fork lifecycle run unchanged on both runtimes.
//
// V1/V2 differences absorbed here:
// - V2 returns unwrapped data (SessionInfo, SessionMessageInfo[], ...) where V1 returned
//   `{ data }`; every method below re-wraps into `{ data }` for `unwrapData`.
// - V2 scopes sessions to the plugin location instead of a `directory` query; the directory
//   is only still sent on `session.list`, the one call that keeps it.
// - V2 `session.prompt` only admits the prompt. The shim waits for completion, reads the
//   transcript back and synthesises the V1 prompt response (`{ info, parts }`) the recall
//   selector and fork error detection read.
// - V2 has no per-prompt agent/system/tools/format overrides and no `app.log`. The fork
//   agent is applied with `switchAgent` when the named agent exists; system injection and
//   the tool sandbox for fallback forks are applied by the `context` hook (see setup.ts)
//   from the pending-fork registry; logging goes to the console.
import type { OpencodeClient } from "../sdk.js"
import { createConsoleLogger } from "../util/log.js"
import { mapSessionMessages } from "./messages.js"
import type { V2PluginContext } from "./types.js"

export type ForkRequestOverride = {
  // System prompt injected by the context hook while this fork runs. Only set when the fork
  // does not run on its named agent; a fork on its named agent already carries it.
  system?: string
  agent?: string
}

export type V2ClientState = {
  overrides: Map<string, ForkRequestOverride>
  useAgent: (name: string) => boolean
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

function assistantText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const lines: string[] = []
  for (const part of content) {
    const record = asRecord(part)
    if (!record) continue
    if (record.type === "text" && typeof record.text === "string") lines.push(record.text)
  }
  return lines.length > 0 ? lines.join("\n") : undefined
}

function requestOptions(signal: unknown): { signal: AbortSignal } | undefined {
  return signal instanceof AbortSignal ? { signal } : undefined
}

export function createV2Client(ctx: V2PluginContext, state: V2ClientState): OpencodeClient {
  const session = {
    async create(options?: unknown) {
      const params = asRecord(options)
      const body = asRecord(params?.body) ?? {}
      const created = await ctx.session.create(
        {
          ...(typeof body.parentID === "string" ? { parentID: body.parentID } : {}),
          ...(typeof body.title === "string" ? { title: body.title } : {}),
        },
        requestOptions(params?.signal),
      )
      return { data: { id: created.id } }
    },

    async prompt(options?: unknown) {
      const params = asRecord(options)
      const path = asRecord(params?.path)
      const body = asRecord(params?.body) ?? {}
      const forkID = path?.id
      if (typeof forkID !== "string") throw new Error("opencode-claude-memory v2: session.prompt without a session id")
      const signal = params?.signal instanceof AbortSignal ? params.signal : undefined
      const request = signal ? { signal } : undefined

      const agent = typeof body.agent === "string" ? body.agent : undefined
      let onNamedAgent = false
      if (agent !== undefined && state.useAgent(agent)) {
        try {
          await ctx.session.switchAgent({ sessionID: forkID, agent }, request)
          onNamedAgent = true
        } catch {
          // The agent vanished after the setup snapshot; the fork still runs on the default
          // agent and the context hook applies the same system/tools overrides instead.
          onNamedAgent = false
        }
      }
      const model = asRecord(body.model)
      if (typeof model?.providerID === "string" && typeof model?.modelID === "string") {
        await ctx.session.switchModel(
          { sessionID: forkID, model: { providerID: model.providerID, id: model.modelID } },
          request,
        )
      }

      const system = typeof body.system === "string" ? body.system : undefined
      state.overrides.set(forkID, {
        ...(agent !== undefined ? { agent } : {}),
        // A fork on its named agent already carries its system prompt; a fallback fork gets
        // it injected by the context hook.
        ...(!onNamedAgent && system !== undefined ? { system } : {}),
      })

      const parts = Array.isArray(body.parts) ? body.parts : []
      const text = parts
        .map((part) => {
          const record = asRecord(part)
          return record?.type === "text" && typeof record.text === "string" ? record.text : ""
        })
        .filter(Boolean)
        .join("\n\n")

      try {
        await ctx.session.prompt({ sessionID: forkID, text }, request)
        await ctx.session.wait({ sessionID: forkID }, request)
        const history = await ctx.session.context({ sessionID: forkID }, request)
        const assistants = (Array.isArray(history) ? history : []).filter(
          (message) => asRecord(message)?.type === "assistant",
        )
        const last = asRecord(assistants[assistants.length - 1])
        const error = asRecord(last?.error)
        if (error && (typeof error.message === "string" || typeof error.type === "string")) {
          return { data: { info: { error }, parts: [] } }
        }
        const reply = last ? assistantText(last.content) : undefined
        return { data: { info: {}, parts: reply !== undefined ? [{ type: "text", text: reply }] : [] } }
      } finally {
        state.overrides.delete(forkID)
      }
    },

    async abort(options?: unknown) {
      const params = asRecord(options)
      const id = asRecord(params?.path)?.id
      if (typeof id === "string") await ctx.session.interrupt({ sessionID: id }, requestOptions(params?.signal))
      return { data: true }
    },

    async delete(options?: unknown) {
      const params = asRecord(options)
      const id = asRecord(params?.path)?.id
      if (typeof id === "string") await ctx.session.remove({ sessionID: id }, requestOptions(params?.signal))
      return { data: true }
    },

    async messages(options?: unknown) {
      const params = asRecord(options)
      const id = asRecord(params?.path)?.id
      if (typeof id !== "string") throw new Error("opencode-claude-memory v2: session.messages without a session id")
      const history = await ctx.session.context({ sessionID: id }, requestOptions(params?.signal))
      return { data: mapSessionMessages(id, Array.isArray(history) ? history : []) }
    },
  }

  const consoleLog = createConsoleLogger()

  const app = {
    async log(options?: unknown) {
      const body = asRecord(asRecord(options)?.body) ?? {}
      const level = body.level === "error" || body.level === "warn" || body.level === "debug" ? body.level : "info"
      const message = typeof body.message === "string" ? body.message : "opencode-claude-memory"
      consoleLog(level, message, asRecord(body.extra))
      return { data: true }
    },
  }

  return { session, app } as unknown as OpencodeClient
}
