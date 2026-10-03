// Fake V2 plugin context for adapter tests. Mirrors test/helpers/index.ts (V1) but speaks
// the V2 API: flat session methods with unwrapped returns, editor-based transforms, and a
// controllable event stream.
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { V2PluginContext } from "../../src/v2/types.js"

export function tempDir(prefix = "ocm-v2-"): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export type SessionCall = { method: string; input: unknown }

export type FakeSessionState = {
  calls: SessionCall[]
  contextHook: ((event: never) => Promise<void> | void) | undefined
  // Fork transcript returned by session.context().
  forkReply: unknown[] | ((forkID: string) => unknown[])
  histories: Map<string, unknown[]>
  createIDs: string[]
  prompted: Array<{ sessionID: string; text: string }>
  switchedAgents: Array<{ sessionID: string; agent: string }>
  interrupted: string[]
  removed: string[]
  agentList: Array<{ id: string; permissions?: Array<{ action: string; resource: string; effect: string }> }>
  onPrompt: ((sessionID: string, text: string) => Promise<void>) | undefined
}

export function userTextMessage(text: string, id = "msg_1"): unknown {
  return { id, type: "user", time: { created: 1 }, text }
}

export function assistantTextMessage(text: string, id = "asst_1", extra: Record<string, unknown> = {}): unknown {
  return { id, type: "assistant", time: { created: 2, completed: 3 }, content: [{ type: "text", text }], ...extra }
}

export type FakeContext = {
  ctx: V2PluginContext
  session: FakeSessionState
  tools: Array<{ name: string; description: string; input: unknown; execute: (...args: never[]) => Promise<unknown> }>
  agentEditorCalls: unknown[]
  emit: (event: unknown) => void
  close: () => void
  cleanup: (() => void) | undefined
  storage: Map<string, unknown>
}

export function makeFakeContext(directory: string): FakeContext {
  const session: FakeSessionState = {
    calls: [],
    contextHook: undefined,
    forkReply: [],
    histories: new Map(),
    createIDs: [],
    prompted: [],
    switchedAgents: [],
    interrupted: [],
    removed: [],
    agentList: [],
    onPrompt: undefined,
  }
  const tools: FakeContext["tools"] = []
  const agentEditorCalls: unknown[] = []
  const storage = new Map<string, unknown>()

  let seq = 0
  const eventQueue: unknown[] = []
  let notify: (() => void) | undefined
  let closed = false

  const sessionAPI = {
    async create(input?: unknown) {
      session.calls.push({ method: "create", input })
      seq += 1
      const id = `fork-${seq}`
      session.createIDs.push(id)
      return { id }
    },
    async prompt(input: unknown) {
      session.calls.push({ method: "prompt", input })
      const record = (input ?? {}) as { sessionID?: string; text?: string }
      session.prompted.push({ sessionID: record.sessionID ?? "", text: record.text ?? "" })
      await session.onPrompt?.(record.sessionID ?? "", record.text ?? "")
      return { id: `inbox-${seq}`, text: record.text ?? "" }
    },
    async wait(input: unknown) {
      session.calls.push({ method: "wait", input })
    },
    async context(input: unknown) {
      session.calls.push({ method: "context", input })
      const sessionID = (input as { sessionID?: string })?.sessionID ?? ""
      if (session.histories.has(sessionID)) return session.histories.get(sessionID) ?? []
      return typeof session.forkReply === "function" ? session.forkReply(sessionID) : session.forkReply
    },
    async switchAgent(input: unknown) {
      session.calls.push({ method: "switchAgent", input })
      const record = (input ?? {}) as { sessionID?: string; agent?: string }
      const known = session.agentList.some((agent) => agent.id === record.agent)
      if (!known) throw new Error(`unknown agent ${record.agent}`)
      session.switchedAgents.push({ sessionID: record.sessionID ?? "", agent: record.agent ?? "" })
    },
    async switchModel(input: unknown) {
      session.calls.push({ method: "switchModel", input })
    },
    async interrupt(input: unknown) {
      session.calls.push({ method: "interrupt", input })
      const sessionID = (input as { sessionID?: string })?.sessionID ?? ""
      session.interrupted.push(sessionID)
    },
    async remove(input: unknown) {
      session.calls.push({ method: "remove", input })
      const sessionID = (input as { sessionID?: string })?.sessionID ?? ""
      session.removed.push(sessionID)
    },
    async hook(name: unknown, callback: unknown) {
      if (name === "context") session.contextHook = callback as never
      return { dispose: async () => {} }
    },
  }

  const ctx = {
    location: { directory },
    options: {},
    agent: {
      async list() {
        return { location: { directory }, data: session.agentList }
      },
      async transform(callback: (editor: never) => void) {
        const agents = new Map<string, Record<string, unknown>>(
          session.agentList.map((agent) => [agent.id, { ...agent }]),
        )
        const editor = {
          list: () => [...agents.values()],
          get: (id: string) => agents.get(id),
          update: (id: string, update: (agent: Record<string, unknown>) => void) => {
            const agent = agents.get(id)
            if (agent) update(agent)
          },
          remove: (id: string) => void agents.delete(id),
          default: (_id: string | undefined) => {},
        }
        agentEditorCalls.push(editor)
        callback(editor as never)
        session.agentList = [...agents.values()] as never
        return { dispose: async () => {} }
      },
    },
    tool: {
      async transform(callback: (editor: never) => void) {
        const editor = {
          list: () => tools,
          get: (id: string) => tools.find((tool) => tool.name === id),
          namespace: (_namespace: unknown) => {},
          add: (definition: never) => void tools.push(definition as never),
          update: (_id: string, _update: unknown) => {},
          remove: (_id: string) => {},
        }
        callback(editor as never)
        return { dispose: async () => {} }
      },
    },
    session: sessionAPI,
    event: {
      subscribe(_options?: unknown) {
        const queue = eventQueue
        async function* stream(): AsyncGenerator<unknown> {
          let index = 0
          while (!closed) {
            if (index < queue.length) {
              yield queue[index]
              index += 1
              continue
            }
            await new Promise<void>((resolve) => {
              notify = resolve
            })
          }
        }
        return stream()
      },
    },
    storage: {
      async get(key: string) {
        return (storage.get(key) ?? undefined) as never
      },
      async set(key: string, value: unknown) {
        storage.set(key, value)
      },
      async remove(key: string) {
        storage.delete(key)
      },
      async scan() {
        return { entries: [], next: undefined }
      },
    },
  } as unknown as V2PluginContext

  return {
    ctx,
    session,
    tools,
    agentEditorCalls,
    storage,
    emit: (event: unknown) => {
      eventQueue.push(event)
      notify?.()
      notify = undefined
    },
    close: () => {
      closed = true
      notify?.()
      notify = undefined
    },
    cleanup: undefined,
  }
}

export function idleEvent(sessionID: string, directory?: string): unknown {
  return {
    type: "session.idle",
    data: { sessionID },
    ...(directory ? { location: { directory } } : {}),
  }
}

export function deletedEvent(sessionID: string): unknown {
  return { type: "session.deleted", data: { sessionID } }
}

export function statusEvent(sessionID: string, status: string): unknown {
  return { type: "session.status", data: { sessionID, status: { type: status } } }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
