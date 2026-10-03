import { describe, expect, test } from "bun:test"
import { MEMORY_AGENTS } from "../../src/config.js"
import {
  applyV2AgentDefaults,
  buildV2AgentTemperatures,
  buildV2ToolAllowLists,
  forkToolPolicy,
  isToolAllowed,
} from "../../src/v2/agents.js"

describe("v2 agent defaults", () => {
  test("recall runs tool-free while extract and dream keep their memory sandboxes", () => {
    const temperatures = buildV2AgentTemperatures(MEMORY_AGENTS)
    expect(temperatures[MEMORY_AGENTS.recall]).toBe(0)
    expect(temperatures[MEMORY_AGENTS.extract]).toBeUndefined()

    const allow = buildV2ToolAllowLists(MEMORY_AGENTS)
    expect([...(allow[MEMORY_AGENTS.recall] ?? [])]).toEqual([])
    expect([...(allow[MEMORY_AGENTS.extract] ?? [])].sort()).toEqual(["memory_list", "memory_read", "memory_save"])
    expect(allow[MEMORY_AGENTS.dream]?.size).toBe(5)
  })

  test("applyV2AgentDefaults fills gaps without touching user values", () => {
    const agents = new Map<string, Record<string, unknown>>([
      [MEMORY_AGENTS.recall, { model: "anthropic/claude-haiku-4-5" }],
      [MEMORY_AGENTS.dream, { steps: 5, system: "custom", permissions: [] }],
    ])
    applyV2AgentDefaults(
      {
        get: (id: string) => agents.get(id),
      },
      MEMORY_AGENTS,
    )
    expect(agents.get(MEMORY_AGENTS.recall)).toMatchObject({ model: "anthropic/claude-haiku-4-5" })
    expect(typeof (agents.get(MEMORY_AGENTS.recall) as { system?: unknown }).system).toBe("string")
    const recallPermissions = agents.get(MEMORY_AGENTS.recall)?.permissions
    expect(recallPermissions).toHaveLength(1)
    // User values win; empty permissions still get defaults.
    expect(agents.get(MEMORY_AGENTS.dream)).toMatchObject({ steps: 5, system: "custom" })
    const dreamPermissions = agents.get(MEMORY_AGENTS.dream)?.permissions as unknown[]
    expect(dreamPermissions.length).toBeGreaterThan(1)
    // Unknown agents are left alone (transforms cannot add agents).
    expect(agents.has(MEMORY_AGENTS.extract)).toBe(false)
  })

  test("forkToolPolicy evaluates user permission rules in order", () => {
    const defaults = new Set(["memory_save"])
    expect(isToolAllowed(forkToolPolicy(defaults, undefined), "memory_save")).toBe(true)
    expect(isToolAllowed(forkToolPolicy(defaults, undefined), "read")).toBe(false)

    const widened = forkToolPolicy(defaults, {
      id: "x",
      permissions: [{ action: "memory_*", resource: "*", effect: "allow" }],
    } as never)
    expect(isToolAllowed(widened, "memory_read")).toBe(true)
    expect(isToolAllowed(widened, "read")).toBe(false)

    const everything = forkToolPolicy(defaults, {
      id: "x",
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    } as never)
    expect(everything.allowAll).toBe(true)
    expect(isToolAllowed(everything, "read")).toBe(true)

    const narrowed = forkToolPolicy(defaults, {
      id: "x",
      permissions: [{ action: "memory_save", resource: "*", effect: "deny" }],
    } as never)
    expect(isToolAllowed(narrowed, "memory_save")).toBe(false)
  })
})
