import { describe, expect, test } from "bun:test"
import { mapSessionMessages, toChatMessages, toolContentToString, toolResultToString } from "../../src/v2/messages.js"
import { assistantTextMessage, userTextMessage } from "./helpers.js"

describe("toolContentToString / toolResultToString", () => {
  test("renders text and file content items", () => {
    expect(toolContentToString([{ type: "text", text: "hello" }])).toBe("hello")
    expect(toolContentToString([{ type: "file", uri: "file:///a.png", mime: "image/png", name: "a.png" }])).toBe(
      "[file a.png]",
    )
    expect(toolResultToString({ type: "text", value: "out" })).toBe("out")
    expect(toolResultToString({ type: "json", value: { a: 1 } })).toBe('{"a":1}')
    expect(toolResultToString({ type: "content", value: [{ type: "text", text: "x" }] })).toBe("x")
  })
})

describe("mapSessionMessages", () => {
  test("maps user, assistant, system and synthetic history", () => {
    const mapped = mapSessionMessages("ses_1", [
      userTextMessage("hello", "u1"),
      {
        id: "a1",
        type: "assistant",
        time: { created: 2, completed: 3 },
        content: [
          { type: "text", text: "done" },
          {
            type: "tool",
            name: "read",
            state: { status: "completed", content: [{ type: "text", text: "file contents" }] },
          },
          { type: "tool", name: "edit", state: { status: "error", error: { message: "no" } } },
          { type: "tool", name: "glob", state: { status: "running", input: {} } },
        ],
      },
      { id: "s1", type: "system", time: { created: 1 }, text: "sys" },
      { id: "x1", type: "synthetic", time: { created: 4 }, text: "Deployment completed" },
      { id: "z1", type: "shell", time: { created: 5 } },
    ])
    expect(mapped).toHaveLength(4)
    const [user, assistant, system, synthetic] = mapped
    expect(user?.info).toMatchObject({ id: "u1", sessionID: "ses_1", role: "user" })
    expect(assistant?.info).toMatchObject({ role: "assistant", time: { created: 2, completed: 3 } })
    expect(assistant?.parts as unknown).toEqual([
      { type: "text", text: "done" },
      { type: "tool", tool: "read", state: { status: "completed", output: "file contents" } },
      { type: "tool", tool: "edit", state: { status: "error", output: "" } },
      { type: "tool", tool: "glob", state: { status: "running" } },
    ])
    expect(system?.parts as unknown).toEqual([{ type: "text", text: "sys" }])
    expect(synthetic?.parts as unknown).toEqual([{ type: "text", text: "Deployment completed", synthetic: true }])
  })

  test("carries assistant errors for fork failure detection", () => {
    const mapped = mapSessionMessages("ses_1", [
      assistantTextMessage("nope", "a1", { error: { type: "provider.invalid-request", message: "bad" } }),
    ])
    const info = mapped[0]?.info as { error?: unknown } | undefined
    if (!info) throw new Error("expected a mapped message")
    expect(info.error).toEqual({
      type: "provider.invalid-request",
      message: "bad",
    })
  })
})

describe("toChatMessages", () => {
  test("adapts the assembled request for recall", () => {
    const chat = toChatMessages(
      "ses_1",
      [{ type: "text", text: "base system" }],
      [
        { role: "user", content: [{ type: "text", text: "How should we test database changes?" }] },
        {
          role: "assistant",
          content: [
            { type: "tool-call", id: "c1", name: "grep", input: {} },
            { type: "tool-call", id: "c2", name: "read", input: {} },
          ],
        },
        {
          role: "tool",
          content: [
            { type: "tool-result", id: "c1", name: "grep", result: { type: "text", value: "hits" } },
            { type: "tool-result", id: "c2", name: "read", result: { type: "error", value: "denied" } },
          ],
        },
      ],
    )
    const roles = chat.map((message) => (message.info as { role: string }).role)
    expect(roles).toEqual(["system", "user", "assistant"])
    const assistant = chat[2]
    expect(assistant?.parts as unknown).toEqual([
      { type: "tool", tool: "grep", state: { status: "completed", output: "hits" } },
      { type: "tool", tool: "read", state: { status: "error", output: "" } },
    ])
  })
})
