// The five memory tools registered through `ctx.tool.transform`. Same store operations and
// result text as the V1 tools (see src/tools.ts); only the envelope changes: V2 tool schemas
// are JSON Schema and execution returns `{ content }` (V2 results have no `title`).
import type { ExtractionCoordinator } from "../extraction/ExtractionCoordinator.js"
import { MEMORY_TYPES } from "../store/frontmatter.js"
import type { MemoryStore } from "../store/MemoryStore.js"
import { formatMemorySaveResult } from "../tools.js"

type JsonSchema = {
  type: "object"
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties: false
}

export type V2ToolDefinition = {
  name: string
  description: string
  input: JsonSchema
  execute: (input: Record<string, never>, context: { sessionID?: string }) => Promise<{ content: string }>
}

function stringProperty(description: string): { type: "string"; description: string } {
  return { type: "string", description }
}

function objectSchema(properties: Record<string, unknown>, required: string[] = Object.keys(properties)): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false }
}

const FILE_NAME_HINT = 'with or without the .md extension; sub-directories are allowed, e.g. "team/conventions"'

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("opencode-claude-memory: tool input must be an object")
  return value as Record<string, unknown>
}

function requiredString(input: Record<string, unknown>, field: string): string {
  const value = input[field]
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`opencode-claude-memory: tool input field "${field}" must be a non-empty string`)
  }
  return value
}

export function buildV2MemoryTools(
  store: MemoryStore,
  extraction: Pick<ExtractionCoordinator, "recordSave">,
): V2ToolDefinition[] {
  return [
    {
      name: "memory_save",
      description:
        "Save or update a memory for future conversations. " +
        "Each memory is stored as a markdown file with frontmatter. " +
        "Use this when the user explicitly asks you to remember something, " +
        "or when you observe important information worth preserving across sessions " +
        "(user preferences, feedback, project context, external references). " +
        "Check existing memories first with memory_list or memory_search to avoid duplicates.",
      input: objectSchema({
        file_name: stringProperty(
          'File name for the memory (without .md extension). Use snake_case, e.g. "user_role", "feedback_testing_style", "project_auth_rewrite"; a sub-directory prefix such as "team/conventions" is allowed',
        ),
        name: stringProperty("Human-readable name for this memory"),
        description: stringProperty(
          "One-line description — used to decide relevance in future conversations, so be specific",
        ),
        type: {
          type: "string",
          enum: [...MEMORY_TYPES],
          description:
            "Memory type: user (about the person), feedback (guidance on approach), project (ongoing work context), reference (pointers to external systems)",
        },
        content: stringProperty(
          "Memory content. For feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines",
        ),
      }),
      async execute(raw, context) {
        const input = asRecord(raw)
        const outcome = store.save({
          fileName: requiredString(input, "file_name"),
          name: requiredString(input, "name"),
          description: requiredString(input, "description"),
          type: requiredString(input, "type") as (typeof MEMORY_TYPES)[number],
          content: requiredString(input, "content"),
        })
        const savedThisRun = extraction.recordSave(context?.sessionID, outcome.fileName)
        return { content: formatMemorySaveResult(outcome, savedThisRun) }
      },
    },

    {
      name: "memory_delete",
      description: "Delete a memory that is outdated, wrong, or no longer relevant. Also removes it from the index.",
      input: objectSchema({
        file_name: stringProperty(`File name of the memory to delete (${FILE_NAME_HINT})`),
      }),
      async execute(raw) {
        const input = asRecord(raw)
        const fileName = requiredString(input, "file_name")
        const { deleted, trashedTo } = store.delete(fileName)
        let content = `Memory "${fileName}" not found.`
        if (deleted) {
          content = trashedTo
            ? `Memory "${fileName}" deleted (a copy was kept at ${trashedTo}).`
            : `Memory "${fileName}" deleted.`
        }
        return { content }
      },
    },

    {
      name: "memory_list",
      description:
        "List all saved memories with their names, types, and descriptions. " +
        "Use this to check what memories exist before saving a new one (to avoid duplicates) " +
        "or when you need to recall what's been stored.",
      input: objectSchema({}, []),
      async execute() {
        const entries = store.list()
        if (entries.length === 0) return { content: "No memories saved yet." }
        const lines = entries.map((e) => `- **${e.name}** (${e.type}) [${e.filename}]: ${e.description}`)
        return { content: `${entries.length} memories found:\n${lines.join("\n")}` }
      },
    },

    {
      name: "memory_search",
      description:
        "Search memories by keyword. Searches across names, descriptions, and content. " +
        "Use this to find relevant memories before answering questions or when the user references past conversations.",
      input: objectSchema({
        query: stringProperty("Search query — searches across name, description, and content"),
      }),
      async execute(raw) {
        const input = asRecord(raw)
        const query = requiredString(input, "query")
        const results = store.search(query)
        if (results.length === 0) return { content: `No memories matching "${query}".` }
        const lines = results.map(
          (e) =>
            `- **${e.name}** (${e.type}) [${e.filename}]: ${e.description}\n  Content: ${e.body.slice(0, 200)}${e.body.length > 200 ? "..." : ""}`,
        )
        return { content: `${results.length} matches for "${query}":\n${lines.join("\n")}` }
      },
    },

    {
      name: "memory_read",
      description: "Read the full content of a specific memory file.",
      input: objectSchema({
        file_name: stringProperty(`File name of the memory to read (${FILE_NAME_HINT})`),
      }),
      async execute(raw) {
        const input = asRecord(raw)
        const fileName = requiredString(input, "file_name")
        const entry = store.read(fileName)
        if (!entry) return { content: `Memory "${fileName}" not found.` }
        return {
          content: `# ${entry.name}\n**Type:** ${entry.type}\n**Description:** ${entry.description}\n\n${entry.body}`,
        }
      },
    },
  ]
}
