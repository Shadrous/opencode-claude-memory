// Hidden-agent defaults for the V2 runtime. V1 expressed the fork sandbox as agent `tools`
// (`{"*": false, memory_save: true, ...}`) and `prompt`/`temperature`; V2 agents have neither.
// The equivalents are:
// - `system` (was: `prompt`),
// - `permissions` (was: `tools`; deny-all first, then allow the memory tools — last match wins),
// - `steps` (unchanged),
// - `temperature` has no agent-level equivalent (V2 does not send per-agent request overlays),
//   so the recall fork's `temperature: 0` is applied per request by the `context` hook.
//
// `ctx.agent.transform` cannot add agents, only update existing ones, so these defaults fill
// gaps in user-defined agents of the same fixed names. Forks whose named agent does not exist
// run on the default agent with the same system/tools/temperature applied by the context hook
// (see setup.ts), using the allow-lists below.
import type { MemoryAgents } from "../config.js"
import { AUTODREAM_PROMPT, EXTRACT_PROMPT } from "../extraction/prompts.js"
import { SELECT_MEMORIES_SYSTEM_PROMPT } from "../recall/selector.js"
import type { V2AgentInfo } from "./types.js"

export const MEMORY_TOOL_NAMES_V2 = [
  "memory_save",
  "memory_delete",
  "memory_list",
  "memory_search",
  "memory_read",
] as const

export type V2PermissionRule = {
  action: string
  resource: string
  effect: "allow" | "ask" | "deny"
}

export type V2AgentDefaults = {
  system: string
  steps?: number
  permissions: V2PermissionRule[]
}

const DENY_ALL: V2PermissionRule = { action: "*", resource: "*", effect: "deny" }

function allow(...tools: readonly string[]): V2PermissionRule[] {
  return [DENY_ALL, ...tools.map((action): V2PermissionRule => ({ action, resource: "*", effect: "allow" }))]
}

export function buildV2AgentDefaults(agents: MemoryAgents): Record<string, V2AgentDefaults> {
  return {
    [agents.recall]: {
      system: SELECT_MEMORIES_SYSTEM_PROMPT,
      // No tools at all, mirroring V1's `{ "*": false }`.
      permissions: [DENY_ALL],
    },
    [agents.extract]: {
      system: EXTRACT_PROMPT,
      // A legitimate extraction is a handful of memory_save calls; the step cap terminates a model
      // that keeps re-saving the same files instead of letting it spin until the timeout (#35).
      steps: 30,
      permissions: allow("memory_save", "memory_list", "memory_read"),
    },
    [agents.dream]: {
      system: AUTODREAM_PROMPT,
      steps: 60,
      permissions: allow(...MEMORY_TOOL_NAMES_V2),
    },
  }
}

// V1's recall agent ran with `temperature: 0`. Applied by the context hook (see setup.ts).
export function buildV2AgentTemperatures(agents: MemoryAgents): Record<string, number> {
  return { [agents.recall]: 0 }
}

// Tool allow-list per fork kind, mirroring V1's merged `tools` (`agents.toolsFor()`).
// The context hook prunes every other tool from fork requests (defence in depth next to the
// agent permissions above).
export function buildV2ToolAllowLists(agents: MemoryAgents): Record<string, Set<string>> {
  return {
    [agents.recall]: new Set(),
    [agents.extract]: new Set(["memory_save", "memory_list", "memory_read"]),
    [agents.dream]: new Set(MEMORY_TOOL_NAMES_V2),
  }
}

type AgentEditor = {
  get(id: string): { system?: string; steps?: number; permissions?: V2PermissionRule[] } | undefined
}

// Merge defaults under the user's own entries: only fill in what they did not set, so a
// partial override never drops `hidden`, `system` or the tool sandbox.
export function applyV2AgentDefaults(
  editor: AgentEditor,
  agents: MemoryAgents,
  defaults: Record<string, V2AgentDefaults> = buildV2AgentDefaults(agents),
): void {
  for (const [name, wanted] of Object.entries(defaults)) {
    const existing = editor.get(name)
    if (!existing) continue
    if (!existing.system) existing.system = wanted.system
    if (wanted.steps !== undefined && existing.steps === undefined) existing.steps = wanted.steps
    if (!existing.permissions || existing.permissions.length === 0) {
      existing.permissions = wanted.permissions.map((rule) => ({ ...rule }))
    }
  }
}

// Tool policy for one fork kind: either every tool is allowed (the user opened the sandbox
// with an `allow` `*` rule, mirroring V1 where `tools` replaced the sandbox wholesale) or only
// tools matching one of `patterns` (exact names like `memory_save`, or `prefix*` globs).
export type ForkToolPolicy = {
  allowAll: boolean
  patterns: Set<string>
}

// Effective fork policy: the default allow-list widened/narrowed by the user's own agent
// permissions in order (last match wins, like OpenCode's own rule evaluation).
export function forkToolPolicy(defaults: Set<string>, agent: V2AgentInfo | undefined): ForkToolPolicy {
  const patterns = new Set(defaults)
  let allowAll = false
  const permissions = agent?.permissions
  if (!Array.isArray(permissions) || permissions.length === 0) return { allowAll, patterns }
  for (const rule of permissions) {
    if (!rule || typeof rule.action !== "string") continue
    if (rule.effect === "allow") {
      if (rule.action === "*") allowAll = true
      else patterns.add(rule.action)
    } else if (rule.effect === "deny") {
      if (rule.action === "*") {
        allowAll = false
        patterns.clear()
      } else {
        patterns.delete(rule.action)
      }
    }
  }
  return { allowAll, patterns }
}

export function isToolAllowed(policy: ForkToolPolicy, name: string): boolean {
  if (policy.allowAll) return true
  if (policy.patterns.has(name)) return true
  for (const pattern of policy.patterns) {
    if (pattern.endsWith("*") && name.startsWith(pattern.slice(0, -1))) return true
  }
  return false
}
