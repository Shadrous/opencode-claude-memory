// V2 plugin wiring: `Plugin.define({ id, setup })`. The coordinators are shared with V1;
// this module only translates V2 extension points onto them:
//
// - hidden agents: `ctx.agent.transform` fills `system`/`steps`/`permissions` gaps in
//   user-defined agents of the same fixed names (transforms cannot add agents).
// - memory tools: `ctx.tool.transform` registers the five JSON-Schema tools.
// - recall: one `ctx.session.hook("context")` replaces both V1 transforms
//   (`experimental.chat.messages.transform` started the selector prefetch,
//   `experimental.chat.system.transform` awaited it and pushed the system prompt).
// - fork sandbox: the same `context` hook injects the fork system prompt and prunes tools
//   for plugin-owned sessions, and applies the recall fork's temperature.
// - extraction: `ctx.event.subscribe` maps `session.idle` / `session.deleted` /
//   `session.status` onto the coordinators (V2 events carry `data`, V1 carried `properties`).
import { homedir } from "node:os"
import { AgentRegistry } from "../agents.js"
import { parseConfig } from "../config.js"
import { ExtractionCoordinator } from "../extraction/ExtractionCoordinator.js"
import { buildMemorySystemPrompt } from "../prompt/systemPrompt.js"
import { formatRecalledMemories } from "../recall/format.js"
import { RecallCoordinator } from "../recall/RecallCoordinator.js"
import type { PluginEvent } from "../sdk.js"
import { MemoryStore } from "../store/MemoryStore.js"
import { createConsoleLogger } from "../util/log.js"
import { OwnedSessions } from "../util/ownedSessions.js"
import {
  applyV2AgentDefaults,
  buildV2AgentTemperatures,
  buildV2ToolAllowLists,
  type ForkToolPolicy,
  forkToolPolicy,
  isToolAllowed,
} from "./agents.js"
import { createV2Client, type ForkRequestOverride } from "./client.js"
import { toChatMessages } from "./messages.js"
import { buildV2MemoryTools } from "./tools.js"
import type { V2ContextEvent, V2Event, V2PluginContext } from "./types.js"

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

function sessionIDOf(event: V2Event): string | undefined {
  const data = asRecord(asRecord(event as unknown)?.data)
  const id = data?.sessionID
  return typeof id === "string" ? id : undefined
}

// The V2 session domain has no `list`, so start-up catch-up cannot enumerate sessions from
// the server. Instead every session observed through events is recorded in plugin storage;
// the catch-up lister below replays those records against the persisted watermarks.
type SeenSession = {
  lastSeen: number
  parentID?: string
  directory: string
}

type SeenSessions = Record<string, SeenSession>

const SEEN_SESSIONS_KEY = "seen-sessions"
const MAX_SEEN_SESSIONS = 500

function eventDirectory(event: V2Event): string | undefined {
  const location = asRecord(asRecord(event as unknown)?.location)
  const directory = location?.directory
  return typeof directory === "string" ? directory : undefined
}

function isLocalEvent(event: V2Event, directory: string): boolean {
  const eventDir = eventDirectory(event)
  return eventDir === undefined || eventDir === directory
}

function asSeenSessions(value: unknown): SeenSessions {
  const record = asRecord(value)
  if (!record) return {}
  const out: SeenSessions = {}
  for (const [id, entry] of Object.entries(record)) {
    const seen = asRecord(entry)
    if (typeof seen?.lastSeen === "number" && typeof seen?.directory === "string") {
      out[id] = {
        lastSeen: seen.lastSeen,
        directory: seen.directory,
        ...(typeof seen?.parentID === "string" ? { parentID: seen.parentID } : {}),
      }
    }
  }
  return out
}

// V1 `session.deleted` carried `{ properties: { info: { id } } }`; the coordinators only read
// the id, so the V2 `data: { sessionID }` event is re-wrapped into that shape.
function deletedAsV1(sessionID: string): PluginEvent {
  return { type: "session.deleted", properties: { info: { id: sessionID } } } as unknown as PluginEvent
}

function statusAsV1(sessionID: string, status: string): PluginEvent {
  return {
    type: "session.status",
    properties: { sessionID, status: { type: status } },
  } as unknown as PluginEvent
}

export function isAutoMemorySystemText(text: unknown): boolean {
  return typeof text === "string" && text.trimStart().startsWith("<!-- opencode-claude-memory -->")
}

export async function setupV2(
  ctx: V2PluginContext,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
): Promise<(() => void) | undefined> {
  const config = parseConfig(ctx.options ?? {}, env, homeDir)
  const dir = ctx.location.directory
  const store = new MemoryStore(dir, { claudeConfigDir: config.claudeConfigDir })
  const log = createConsoleLogger()
  const owned = new OwnedSessions()
  const agents = new AgentRegistry(config.agents)
  const overrides = new Map<string, ForkRequestOverride>()
  const temperatures = buildV2AgentTemperatures(config.agents)
  const allowListDefaults = buildV2ToolAllowLists(config.agents)
  const policies = new Map<string, ForkToolPolicy>()
  const knownAgents = new Set<string>()

  const refreshAgents = async (): Promise<void> => {
    try {
      const listed = await ctx.agent.list()
      const infos = Array.isArray(listed) ? listed : asRecord(listed)?.data
      if (!Array.isArray(infos)) return
      knownAgents.clear()
      for (const info of infos) {
        const record = asRecord(info)
        const id = record?.id
        if (typeof id !== "string") continue
        knownAgents.add(id)
        const defaults = allowListDefaults[id]
        if (defaults) policies.set(id, forkToolPolicy(defaults, info as never))
      }
    } catch {
      // Agent reads are best-effort; forks fall back to the default agent with hook overrides.
    }
  }

  const client = createV2Client(ctx, {
    overrides,
    useAgent: (name) => knownAgents.has(name),
  })

  const touchSeenSession = (sessionID: string, parentID?: string): void => {
    void (async () => {
      try {
        const seen = asSeenSessions(await ctx.storage.get(SEEN_SESSIONS_KEY))
        const previous = seen[sessionID]
        seen[sessionID] = {
          lastSeen: Date.now(),
          directory: dir,
          parentID: parentID ?? previous?.parentID,
        }
        const ids = Object.keys(seen)
        if (ids.length > MAX_SEEN_SESSIONS) {
          ids
            .sort((a, b) => (seen[a]?.lastSeen ?? 0) - (seen[b]?.lastSeen ?? 0))
            .slice(0, ids.length - MAX_SEEN_SESSIONS)
            .forEach((id) => {
              delete seen[id]
            })
        }
        await ctx.storage.set(SEEN_SESSIONS_KEY, seen)
      } catch {
        // Seen-session tracking is best-effort; extraction still runs on live idle events.
      }
    })()
  }

  const forgetSeenSession = (sessionID: string): void => {
    void (async () => {
      try {
        const seen = asSeenSessions(await ctx.storage.get(SEEN_SESSIONS_KEY))
        if (seen[sessionID]) {
          delete seen[sessionID]
          await ctx.storage.set(SEEN_SESSIONS_KEY, seen)
        }
      } catch {
        // best-effort
      }
    })()
  }

  const deps = {
    store,
    config,
    client,
    directory: dir,
    owned,
    agents,
    log,
    listSessions: async () => {
      const seen = asSeenSessions(await ctx.storage.get(SEEN_SESSIONS_KEY))
      // Minimal SessionInfo: catch-up only reads id, parentID and time.updated.
      return Object.entries(seen)
        .filter(([, record]) => record.directory === dir)
        .map(([id, record]) => ({
          id,
          ...(record.parentID !== undefined ? { parentID: record.parentID } : {}),
          time: { created: record.lastSeen, updated: record.lastSeen },
        })) as never
    },
  }
  const recall = new RecallCoordinator(deps)
  const extraction = new ExtractionCoordinator(deps)

  await ctx.agent.transform((editor) => {
    applyV2AgentDefaults(editor as never, config.agents)
  })
  await refreshAgents()

  await ctx.tool.transform((editor) => {
    for (const definition of buildV2MemoryTools(store, extraction)) {
      editor.add({
        name: definition.name,
        description: definition.description,
        input: definition.input,
        execute: (input, context) =>
          definition.execute(input as Record<string, never>, {
            sessionID: (context as { sessionID?: string }).sessionID,
          }),
      })
    }
  })

  await ctx.session.hook("context", async (event: V2ContextEvent) => {
    const sessionID = event.sessionID
    if (owned.has(sessionID)) {
      const override = overrides.get(sessionID)
      const agent = override?.agent
      if (override?.system !== undefined) {
        event.system.push({ type: "text", text: override.system })
      }
      const policy = (agent !== undefined ? policies.get(agent) : undefined) ?? {
        allowAll: false,
        patterns: agent !== undefined ? (allowListDefaults[agent] ?? new Set<string>()) : new Set<string>(),
      }
      if (!policy.allowAll) {
        for (const name of Object.keys(event.tools)) {
          if (!isToolAllowed(policy, name)) delete event.tools[name]
        }
      }
      const temperature = agent !== undefined ? temperatures[agent] : undefined
      if (temperature !== undefined) event.options.temperature = temperature
      return
    }

    const chat = toChatMessages(sessionID, event.system, event.messages)
    recall.onMessagesTransform({ messages: chat })
    if (recall.isIgnored(sessionID)) {
      for (let i = event.system.length - 1; i >= 0; i--) {
        if (isAutoMemorySystemText(event.system[i]?.text)) event.system.splice(i, 1)
      }
      // Mirror V1's messages transform, which dropped the plugin's own segment from
      // system-role messages when memory is ignored.
      for (let i = event.messages.length - 1; i >= 0; i--) {
        const message = event.messages[i] as { role?: unknown; content?: unknown } | undefined
        const content = message?.role === "system" && Array.isArray(message.content) ? message.content : undefined
        if (!message || !content) continue
        const kept = content.filter((part) => !isAutoMemorySystemText(asRecord(part)?.text))
        if (kept.length === 0) event.messages.splice(i, 1)
        else if (kept.length !== content.length) message.content = kept
      }
    }
    const recalled = await recall.takeRecalled(sessionID)
    event.system.push({
      type: "text",
      text: buildMemorySystemPrompt(store, formatRecalledMemories(recalled), {
        includeIndex: !recall.isIgnored(sessionID),
      }),
    })
  })

  const controller = new AbortController()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          const type = (event as { type?: unknown }).type
          if (type === "session.created") {
            const sessionID = sessionIDOf(event)
            if (sessionID && isLocalEvent(event, dir) && !owned.has(sessionID)) {
              const parentID = asRecord(asRecord(event as unknown)?.data)?.parentID
              touchSeenSession(sessionID, typeof parentID === "string" ? parentID : undefined)
            }
          } else if (type === "session.idle") {
            const sessionID = sessionIDOf(event)
            if (sessionID) {
              if (isLocalEvent(event, dir) && !owned.has(sessionID)) touchSeenSession(sessionID)
              extraction.onSessionIdle(sessionID)
            }
          } else if (type === "session.deleted") {
            const sessionID = sessionIDOf(event)
            if (!sessionID) continue
            owned.release(sessionID, 5_000)
            forgetSeenSession(sessionID)
            const v1 = deletedAsV1(sessionID)
            recall.onEvent(v1)
            extraction.onEvent(v1)
          } else if (type === "session.status") {
            const data = asRecord(asRecord(event as unknown)?.data)
            const sessionID = data?.sessionID
            const status = asRecord(data?.status)?.type
            if (typeof sessionID === "string" && typeof status === "string") {
              if (isLocalEvent(event, dir) && !owned.has(sessionID)) touchSeenSession(sessionID)
              extraction.onEvent(statusAsV1(sessionID, status))
            }
          }
        } catch {
          // One bad event must not kill the subscription loop.
        }
      }
    } catch {
      // Aborted on unload.
    }
  })()

  // Runs once the agent sandbox is known; failures are logged inside catchUp().
  void extraction.catchUp()

  return () => {
    controller.abort()
    extraction.dispose()
    owned.dispose()
  }
}
