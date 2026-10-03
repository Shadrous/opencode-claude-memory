import { afterEach, describe, expect, test } from "bun:test"
import { MEMORY_AGENTS } from "../../src/config.js"
import { AUTO_MEMORY_MARKER } from "../../src/prompt/systemPrompt.js"
import { setupV2 } from "../../src/v2/setup.js"
import { cleanupTempDirs } from "../helpers/index.js"
import {
  assistantTextMessage,
  deletedEvent,
  type FakeContext,
  idleEvent,
  makeFakeContext,
  sleep,
  statusEvent,
  tempDir,
  userTextMessage,
} from "./helpers.js"

afterEach(cleanupTempDirs)

async function setup(directory?: string, options?: unknown) {
  const dir = directory ?? tempDir("ocm-v2-project-")
  const claudeConfigDir = tempDir("ocm-v2-claude-")
  const homeDir = tempDir("ocm-v2-home-")
  const fake = makeFakeContext(dir)
  if (options !== undefined) (fake.ctx as { options: unknown }).options = options
  const cleanup = await setupV2(fake.ctx, { CLAUDE_CONFIG_DIR: claudeConfigDir }, homeDir)
  fake.cleanup = cleanup ?? undefined
  return { ...fake, dir, claudeConfigDir, homeDir }
}

function finish(fake: FakeContext): void {
  fake.close()
  fake.cleanup?.()
}

type ContextEvent = {
  sessionID: string
  system: Array<{ type: string; text: string }>
  messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>
  tools: Record<string, { description: string; input: unknown }>
  options: Record<string, unknown>
}

function contextEvent(sessionID: string, text: string, tools: string[] = ["read", "memory_save"]): ContextEvent {
  return {
    sessionID,
    system: [],
    messages: [{ role: "user", content: [{ type: "text", text }] }],
    tools: Object.fromEntries(tools.map((name) => [name, { description: name, input: {} }])),
    options: {},
  }
}

async function runContext(fake: FakeContext, event: ContextEvent): Promise<ContextEvent> {
  const hook = fake.session.contextHook as ((event: never) => Promise<void>) | undefined
  if (!hook) throw new Error("context hook not registered")
  await hook(event as never)
  return event
}

async function saveMemory(
  fake: FakeContext,
  input: Record<string, string>,
  sessionID: string,
): Promise<{ content: string }> {
  const save = fake.tools.find((tool) => tool.name === "memory_save")
  if (!save) throw new Error("memory_save not registered")
  return (await save.execute(input as never, { sessionID } as never)) as { content: string }
}

describe("v2 setup", () => {
  test("rejects invalid plugin options", async () => {
    const fake = makeFakeContext(tempDir("ocm-v2-project-"))
    try {
      await expect(
        setupV2(
          { ...fake.ctx, options: { extract: { enabled: "yes" } } } as never,
          { CLAUDE_CONFIG_DIR: tempDir("ocm-v2-claude-") },
          tempDir("ocm-v2-home-"),
        ),
      ).rejects.toThrow(/extract\.enabled/)
    } finally {
      fake.close()
    }
  })

  test("registers five tools", async () => {
    const fake = await setup()
    try {
      expect(fake.tools.map((tool) => tool.name).sort()).toEqual([
        "memory_delete",
        "memory_list",
        "memory_read",
        "memory_save",
        "memory_search",
      ])
    } finally {
      finish(fake)
    }
  })

  test("fills hidden-agent gaps without touching user values", async () => {
    const dir = tempDir("ocm-v2-project-")
    const fake = makeFakeContext(dir)
    fake.session.agentList = [
      { id: MEMORY_AGENTS.recall, permissions: [] },
      { id: MEMORY_AGENTS.dream, permissions: [] },
    ]
    try {
      const cleanup =
        (await setupV2(fake.ctx, { CLAUDE_CONFIG_DIR: tempDir("ocm-v2-claude-") }, tempDir("ocm-v2-home-"))) ??
        undefined
      const recall = fake.session.agentList.find((agent) => agent.id === MEMORY_AGENTS.recall)
      expect(typeof (recall as { system?: unknown } | undefined)?.system).toBe("string")
      expect(recall?.permissions?.length).toBe(1)
      const dream = fake.session.agentList.find((agent) => agent.id === MEMORY_AGENTS.dream)
      expect(dream?.permissions?.length).toBeGreaterThan(1)
      cleanup?.()
    } finally {
      fake.close()
    }
  })

  test("injects the memory system prompt and recalled memories", async () => {
    const fake = await setup()
    try {
      await saveMemory(
        fake,
        {
          file_name: "database_rules",
          name: "Database Test Rules",
          description: "Rules for database integration tests",
          type: "feedback",
          content: "Run integration tests against a real database, not mocks.",
        },
        "main",
      )

      fake.session.forkReply = [assistantTextMessage('```json\n{"selected_memories": ["database_rules.md"]}\n```')]
      const event = await runContext(fake, contextEvent("ses_recall", "How should we test database changes?"))
      expect(event.system).toHaveLength(1)
      expect(event.system[0]?.text.startsWith(AUTO_MEMORY_MARKER)).toBe(true)
      expect(event.system[0]?.text).toContain("## MEMORY.md")
      expect(event.system[0]?.text).toContain("## Recalled Memories")
      expect(event.system[0]?.text).toContain("Database Test Rules")

      // The selector fork ran through the V2 session API: create, prompt, wait, context, remove.
      const methods = fake.session.calls.map((call) => call.method)
      expect(methods).toEqual(["create", "prompt", "wait", "context", "remove"])
      expect(fake.session.prompted).toHaveLength(1)
      expect(fake.session.prompted[0]?.text).toContain("Query: How should we test database changes?")
      expect(fake.session.interrupted).toEqual([])
    } finally {
      finish(fake)
    }
  })

  test("owned forks get their system prompt, tool sandbox and temperature", async () => {
    const fake = await setup()
    try {
      await saveMemory(
        fake,
        {
          file_name: "database_rules",
          name: "Database Test Rules",
          description: "Rules for database integration tests",
          type: "feedback",
          content: "Run integration tests against a real database, not mocks.",
        },
        "main",
      )
      fake.session.forkReply = [assistantTextMessage('{"selected_memories": []}')]

      // Intercept the recall fork mid-flight: the shim registered its override before the
      // prompt was admitted, so the context hook must sandbox it like V1's agent sandbox did.
      let forkSeen: ContextEvent | undefined
      fake.session.onPrompt = async (forkID) => {
        forkSeen = await runContext(
          fake,
          contextEvent(forkID, "Query: x", ["read", "edit", "memory_save", "memory_list"]),
        )
      }
      await runContext(fake, contextEvent("ses_fork", "How should we test database changes?"))

      expect(forkSeen).toBeDefined()
      // Recall forks run tool-free with temperature 0.
      expect(forkSeen?.system).toHaveLength(1)
      expect(forkSeen?.system[0]?.text).toContain("selecting memories")
      expect(Object.keys(forkSeen?.tools ?? {})).toEqual([])
      expect(forkSeen?.options.temperature).toBe(0)
    } finally {
      finish(fake)
    }
  })

  test("suppresses the index while memory is ignored", async () => {
    const fake = await setup()
    try {
      await saveMemory(
        fake,
        {
          file_name: "hidden_memory",
          name: "Hidden Memory",
          description: "Should stay hidden",
          type: "user",
          content: "Secret content.",
        },
        "main",
      )
      const event = await runContext(fake, contextEvent("ses_ignore", "Ignore memory and answer fresh."))
      expect(event.system).toHaveLength(1)
      expect(event.system[0]?.text).toContain("# Auto Memory")
      expect(event.system[0]?.text).not.toContain("## MEMORY.md")
      expect(event.system[0]?.text).not.toContain("Hidden Memory")
    } finally {
      finish(fake)
    }
  })
})

describe("v2 extraction events", () => {
  test("session.idle extracts through a fork and advances the watermark", async () => {
    const fake = await setup(undefined, { extract: { debounceMs: 0 }, autodream: { enabled: false } })
    try {
      fake.session.histories.set("parent-session", [
        userTextMessage(
          "I am a backend engineer on the API team; always run integration tests against a real database.",
          "u1",
        ),
      ])
      // The fork "model" saves a memory through the registered tool, as the V1 test does.
      fake.session.onPrompt = async (forkID) => {
        await saveMemory(
          fake,
          {
            file_name: "user_role",
            name: "User Role",
            description: "Backend engineer on the API team",
            type: "user",
            content: "The user is a backend engineer who owns the API service.",
          },
          forkID,
        )
      }
      fake.emit(idleEvent("parent-session", fake.dir))
      await sleep(100)

      expect(fake.session.createIDs).toEqual(["fork-1"])
      expect(fake.session.removed).toEqual(["fork-1"])
      const list = fake.tools.find((tool) => tool.name === "memory_list")
      if (!list) throw new Error("memory_list not registered")
      const output = (await list.execute({} as never, { sessionID: "check" } as never)) as { content: string }
      expect(output.content).toContain("User Role")

      // The session was recorded in plugin storage: restarts replay it without session.list.
      const seen = (await fake.storage.get("seen-sessions")) as Record<string, { lastSeen: number }>
      const recorded = seen["parent-session"]
      if (!recorded) throw new Error("expected a seen-session record")
      expect(recorded.lastSeen).toBeGreaterThan(0)
    } finally {
      finish(fake)
    }
  })

  test("a busy session cancels its pending extraction", async () => {
    const fake = await setup(undefined, { extract: { debounceMs: 20 }, autodream: { enabled: false } })
    try {
      fake.session.histories.set("parent-busy", [userTextMessage("Remember the sky is blue.", "u1")])
      fake.emit(idleEvent("parent-busy", fake.dir))
      fake.emit(statusEvent("parent-busy", "busy"))
      await sleep(100)
      expect(fake.session.createIDs).toEqual([])
    } finally {
      finish(fake)
    }
  })

  test("session.deleted forgets the session", async () => {
    const fake = await setup(undefined, { extract: { debounceMs: 0 }, autodream: { enabled: false } })
    try {
      await fake.storage.set("seen-sessions", {
        "gone-session": { lastSeen: 123, directory: fake.dir },
        "staying-session": { lastSeen: 456, directory: fake.dir },
      })
      fake.emit(deletedEvent("gone-session"))
      await sleep(50)
      const seen = (await fake.storage.get("seen-sessions")) as Record<string, unknown>
      expect(seen["gone-session"]).toBeUndefined()
      expect(seen["staying-session"]).toBeDefined()
    } finally {
      finish(fake)
    }
  })
})
