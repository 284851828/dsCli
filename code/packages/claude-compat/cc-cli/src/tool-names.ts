/**
 * Claude Code tool names and their DSH-native counterparts. Mapping happens
 * only at the CLI and projection boundary: the model keeps seeing native
 * names in every request.
 * @module @deepseek-ai/dsh-cc-cli/tool-names
 */

import type { Context } from '@deepseek-ai/cordis'

/** Stable Cordis plugin name. */
export const name = 'cc-tool-names'

/** Service provided by this plugin and injected by the permission and runner rows. */
export const CC_TOOL_NAMES_SERVICE = 'ccToolNames'

/** What consumers read from {@link CC_TOOL_NAMES_SERVICE}. */
export interface CcToolNames {
  /** Map a Claude Code tool name to its DSH tool, or `undefined` when unsupported. */
  toDsh(name: string): string | undefined
  /** Map a DSH tool name back to the Claude Code name shown on stdout. */
  toClaude(name: string): string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Claude Code ⇄ DSH tool-name mapping. */
    ccToolNames: CcToolNames
  }
}

const WINDOWS = process.platform === 'win32'

/** Claude Code name → DSH native name. */
const CLAUDE_TO_DSH: Readonly<Record<string, string>> = {
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  Glob: 'glob',
  Grep: 'grep',
  Bash: WINDOWS ? 'pwsh' : 'bash',
  PowerShell: 'pwsh',
  WebFetch: 'web_fetch',
  WebSearch: 'web_search',
  TodoWrite: 'todo_write',
  Agent: 'subagent',
  Task: 'subagent',
}

const DSH_TO_CLAUDE: Readonly<Record<string, string>> = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  bash: 'Bash',
  pwsh: 'PowerShell',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  todo_write: 'TodoWrite',
  subagent: 'Agent',
}

function toDsh(toolName: string): string | undefined {
  if (toolName.startsWith('mcp__')) return toolName
  return CLAUDE_TO_DSH[toolName]
}

function toClaude(toolName: string): string {
  if (toolName.startsWith('mcp__')) return toolName
  return DSH_TO_CLAUDE[toolName] ?? toolName
}

/**
 * Provide the tool-name mapping service.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  ctx.provide(CC_TOOL_NAMES_SERVICE, { toDsh, toClaude } satisfies CcToolNames)
}
