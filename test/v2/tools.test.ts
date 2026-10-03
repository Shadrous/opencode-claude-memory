import { afterEach, describe, expect, test } from "bun:test"
import { buildV2MemoryTools, type V2ToolDefinition } from "../../src/v2/tools.js"
import { cleanupTempDirs, makeStore } from "../helpers/index.js"

afterEach(cleanupTempDirs)

function toolByName(tools: V2ToolDefinition[], name: string): V2ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`tool ${name} not registered`)
  return tool
}

describe("v2 memory tools", () => {
  test("save, list, search, read and delete round-trip through JSON-schema tools", async () => {
    const store = makeStore()
    const savedByFork = new Map<string, string[]>()
    const tools = buildV2MemoryTools(store, {
      recordSave: (sessionID: string | undefined, fileName: string) => {
        if (!sessionID) return undefined
        const list = savedByFork.get(sessionID) ?? []
        list.push(fileName)
        savedByFork.set(sessionID, list)
        return list
      },
    })
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "memory_delete",
      "memory_list",
      "memory_read",
      "memory_save",
      "memory_search",
    ])
    for (const tool of tools) {
      expect(tool.input).toMatchObject({ type: "object", additionalProperties: false })
      expect(Array.isArray(tool.input.required ?? [])).toBe(true)
    }

    const save = toolByName(tools, "memory_save")
    const first = await save.execute(
      {
        file_name: "user_role",
        name: "User Role",
        description: "Backend engineer",
        type: "user",
        content: "Owns the API service.",
      } as never,
      { sessionID: "fork-1" },
    )
    expect(first.content).toContain("Memory saved to")

    // Inside a fork the result carries the done-signal; outside it stays plain.
    savedByFork.set("fork-1", [])
    const second = await save.execute(
      {
        file_name: "user_role",
        name: "User Role",
        description: "Backend engineer",
        type: "user",
        content: "Owns the API service.",
      } as never,
      { sessionID: "fork-1" },
    )
    expect(second.content).toContain("Saved so far in this extraction run")

    const list = await toolByName(tools, "memory_list").execute({} as never, { sessionID: "s" })
    expect(list.content).toContain("User Role")

    const search = await toolByName(tools, "memory_search").execute({ query: "api" } as never, { sessionID: "s" })
    expect(search.content).toContain("User Role")

    const read = await toolByName(tools, "memory_read").execute({ file_name: "user_role" } as never, { sessionID: "s" })
    expect(read.content).toContain("Owns the API service.")

    const remove = await toolByName(tools, "memory_delete").execute({ file_name: "user_role" } as never, {
      sessionID: "s",
    })
    expect(remove.content).toContain("deleted")
  })

  test("invalid input is rejected", async () => {
    const store = makeStore()
    const tools = buildV2MemoryTools(store, { recordSave: () => undefined })
    const save = toolByName(tools, "memory_save")
    await expect(save.execute({ file_name: "x" } as never, { sessionID: "s" })).rejects.toThrow(/name/)
    await expect(
      save.execute({ file_name: "../escape", name: "n", description: "d", type: "user", content: "c" } as never, {
        sessionID: "s",
      }),
    ).rejects.toThrow()
  })
})
