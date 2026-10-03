// V2 message shapes mapped onto the V1 ChatMessage model the coordinators and hooks
// already understand, so recall/extraction logic is shared between both runtimes.
//
// Two sources feed this adapter:
// - `ctx.session.context()` returns persisted SessionMessageInfo items (they carry ids and
//   timestamps; used for extraction watermarks and fork results).
// - the `context` hook carries the assembled model request (Message items with role/content
//   but no timestamps; used for recall turn detection).
import type { Message } from "@opencode/ai"
import type { SessionContext } from "@opencode/plugin/promise/session"
import type { ChatMessage } from "../sdk.js"

type SessionHistoryMessage = {
  id?: string
  type?: string
  role?: string
  time?: { created?: unknown; completed?: unknown }
  text?: unknown
  content?: unknown
  state?: unknown
  error?: unknown
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined
}

// Tool output arrives as V2 Tool.Content items (`{type:"text",text}` or
// `{type:"file",uri,...}`); the V1 model only knows plain strings.
export function toolContentToString(content: unknown): string {
  if (!Array.isArray(content)) return content === undefined ? "" : JSON.stringify(content)
  const lines: string[] = []
  for (const item of content) {
    const record = asRecord(item)
    if (!record) continue
    if (record.type === "text" && typeof record.text === "string") lines.push(record.text)
    else if (record.type === "file") lines.push(`[file ${asText(record.name) ?? asText(record.uri) ?? "attachment"}]`)
  }
  return lines.join("\n")
}

// A completed V1 tool part carries its output as a string; V2 tool results are typed
// (`json`/`text`/`error`/`content`), while persisted history tool states carry the content
// array directly.
export function toolResultToString(result: unknown): string {
  if (Array.isArray(result)) return toolContentToString(result)
  const record = asRecord(result)
  const type = record?.type
  const value = record?.value
  if (type === "text" && typeof value === "string") return value
  if (type === "content") return toolContentToString(value)
  if (value === undefined) return ""
  return typeof value === "string" ? value : JSON.stringify(value)
}

function chatMessage(
  sessionID: string,
  id: string | undefined,
  role: string,
  created: number | undefined,
  completed: number | undefined,
  parts: unknown[],
): ChatMessage {
  const time: Record<string, number> = {}
  if (created !== undefined) time.created = created
  if (completed !== undefined) time.completed = completed
  return { info: { id, sessionID, role, time }, parts } as unknown as ChatMessage
}

// Maps persisted session history (extraction watermarks, fork results) onto ChatMessage.
// Message kinds without a V1 equivalent (agent/model switches, shell, skill, compaction,
// idle, location switches) are skipped; the watermark logic only needs user/assistant
// ordering, ids and completion times, and it falls back to a time boundary when its
// watermark message is gone.
export function mapSessionMessages(sessionID: string, messages: readonly unknown[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const raw of messages) {
    const message = asRecord(raw) as SessionHistoryMessage | undefined
    const type = message?.type
    if (!message || type === undefined) continue
    if (type === "user") {
      const text = asText(message.text)
      if (!text) continue
      out.push(
        chatMessage(sessionID, asText(message.id), "user", asNumber(message.time?.created), undefined, [
          { type: "text", text },
        ]),
      )
    } else if (type === "synthetic") {
      const text = asText(message.text)
      if (!text) continue
      out.push(
        chatMessage(sessionID, asText(message.id), "user", asNumber(message.time?.created), undefined, [
          { type: "text", text, synthetic: true },
        ]),
      )
    } else if (type === "system") {
      const text = asText(message.text)
      if (!text) continue
      out.push(
        chatMessage(sessionID, asText(message.id), "system", asNumber(message.time?.created), undefined, [
          { type: "text", text },
        ]),
      )
    } else if (type === "assistant") {
      const created = asNumber(message.time?.created)
      const completed = asNumber(message.time?.completed)
      const parts: unknown[] = []
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          const record = asRecord(part)
          if (!record) continue
          if (record.type === "text" && typeof record.text === "string") {
            parts.push({ type: "text", text: record.text })
          } else if (record.type === "tool" && typeof record.name === "string") {
            const state = asRecord(record.state)
            const status = state?.status
            if (status === "completed" || status === "error") {
              parts.push({
                type: "tool",
                tool: record.name,
                state: { status, output: toolResultToString(asRecord(state)?.content) },
              })
            } else {
              parts.push({ type: "tool", tool: record.name, state: { status: "running" } })
            }
          }
        }
      }
      const info: Record<string, unknown> = {
        id: message.id,
        sessionID,
        role: "assistant",
        time: { created, completed },
      }
      if (message.error !== undefined && message.error !== null) info.error = message.error
      out.push({ info, parts } as unknown as ChatMessage)
    }
  }
  return out
}

type RequestToolResult = { status: "completed" | "error"; output: string } | undefined

// Assembled request messages carry tool calls (`tool-call`) and their results (`tool-result`
// parts, usually on later `tool`-role messages). Index results by call id first so every
// call maps to a V1 tool part with the right completion status.
function indexRequestToolResults(messages: readonly Message[]): Map<string, RequestToolResult> {
  const results = new Map<string, RequestToolResult>()
  for (const message of messages) {
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      const record = asRecord(part)
      if (record === undefined) continue
      if (record.type !== "tool-result" || typeof record.id !== "string") continue
      const result = asRecord(record.result)
      const failed = result?.type === "error" || result?.type === undefined
      if (failed) results.set(record.id, { status: "error", output: "" })
      else results.set(record.id, { status: "completed", output: toolResultToString(result) })
    }
  }
  return results
}

// Maps the assembled model request (V2 Message items) plus the request system prompt onto
// ChatMessage for recall turn detection: last user query, surfaced-memory keys and recent
// tools. Timestamps do not exist on request messages and are not needed on this path.
export function toChatMessages(
  sessionID: string,
  system: SessionContext["system"],
  messages: readonly Message[],
): ChatMessage[] {
  const out: ChatMessage[] = []
  if (system.length > 0) {
    out.push(
      chatMessage(
        sessionID,
        undefined,
        "system",
        undefined,
        undefined,
        system.map((part) => ({ ...part })),
      ),
    )
  }
  const results = indexRequestToolResults(messages)
  messages.forEach((message, index) => {
    const role = (message as { role?: unknown }).role
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) return
    if (role === "user") {
      const parts = content
        .filter((part) => asRecord(part)?.type === "text" && typeof asRecord(part)?.text === "string")
        .map((part) => ({ type: "text", text: (asRecord(part) as { text: string }).text }))
      if (parts.length > 0) {
        out.push(
          chatMessage(
            sessionID,
            asText((message as { id?: unknown }).id) ?? `request-${index}`,
            "user",
            index,
            undefined,
            parts,
          ),
        )
      }
    } else if (role === "assistant") {
      const parts: unknown[] = []
      for (const part of content) {
        const record = asRecord(part)
        if (!record) continue
        if (record.type === "text" && typeof record.text === "string") {
          parts.push({ type: "text", text: record.text })
        } else if (record.type === "tool-call" && typeof record.name === "string") {
          const result = typeof record.id === "string" ? results.get(record.id) : undefined
          parts.push({
            type: "tool",
            tool: record.name,
            state: result ?? { status: "running" },
          })
        }
      }
      if (parts.length > 0) {
        out.push(
          chatMessage(
            sessionID,
            asText((message as { id?: unknown }).id) ?? `request-${index}`,
            "assistant",
            index,
            index,
            parts,
          ),
        )
      }
    } else if (role === "system") {
      const parts = content
        .filter((part) => asRecord(part)?.type === "text" && typeof asRecord(part)?.text === "string")
        .map((part) => ({ type: "text", text: (asRecord(part) as { text: string }).text }))
      if (parts.length > 0) out.push(chatMessage(sessionID, undefined, "system", undefined, undefined, parts))
    }
  })
  return out
}
