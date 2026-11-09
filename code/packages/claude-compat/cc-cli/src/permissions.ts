/**
 * Claude Code permission rules, evaluated before a DSH tool executes. The
 * decision order mirrors Claude: disallowed rules, bypass, plan, read-only
 * tools, allowed rules, acceptEdits, then deny.
 * @module @deepseek-ai/dsh-cc-cli/permissions
 */

import { isAbsolute, matchesGlob, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PermissionDenial } from './stream.ts'

/** Stable Cordis plugin name. */
export const name = 'cc-permissions'

/** Service provided by this plugin and injected by the runner. */
export const CC_PERMISSIONS_SERVICE = 'ccPermissions'

/** The pre-dispatch answer for one tool call. */
export type PermissionDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }

/** One parsed `Tool` or `Tool(spec)` rule. */
export interface PermissionRule {
  tool: string
  /** Parenthesized rule payload; absent for a bare tool name. */
  spec: string | undefined
}

/** What the runner resolves from the command line before the run. */
export interface PermissionSetup {
  permissionMode: string
  allowedRules: readonly string[]
  disallowedRules: readonly string[]
  addDirs: readonly string[]
}

/** Per-run rule and denial state. */
export interface PermissionState {
  readonly mode: string
  readonly cwd: string
  readonly addDirs: readonly string[]
  readonly allowed: readonly PermissionRule[]
  readonly disallowed: readonly PermissionRule[]
  /** DSH names hidden by bare `--disallowedTools`, which never reach pre-execute. */
  readonly disallowedDsH: ReadonlySet<string>
  readonly denials: PermissionDenial[]
  readonly deniedCallIds: Set<string>
}

/** The permission service. */
export interface CcPermissions {
  /** Parse rules once per run. */
  createState(setup: PermissionSetup, cwd: string, toDsh: (name: string) => string | undefined): PermissionState
  /** Decide one call; `toolName` is already the Claude-facing name. */
  decide(state: PermissionState, toolName: string, args: unknown): PermissionDecision
  /** Record a denial once per call id. */
  recordDenial(state: PermissionState, toolName: string, callId: string, input: unknown): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Claude-compatible permission decisions. */
    ccPermissions: CcPermissions
  }
}

const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite'])
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const WINDOWS = process.platform === 'win32'

const DENY_REASON = (toolName: string): string => `Permission to use ${toolName} has been denied.`

/** Parse `Tool` / `Tool(spec)` without shell parsing. */
export function parseRule(raw: string): PermissionRule {
  const open = raw.indexOf('(')
  if (open === -1) return { tool: raw.trim(), spec: undefined }
  const close = raw.lastIndexOf(')')
  const end = close > open ? close : raw.length
  return { tool: raw.slice(0, open).trim(), spec: raw.slice(open + 1, end).trim() }
}

function isShellPair(tool: string): boolean {
  return SHELL_TOOLS.has(tool)
}

function sameTool(rule: string, event: string): boolean {
  if (rule === event) return true
  return isShellPair(rule) && isShellPair(event)
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/** Split a command into simple segments; this is deliberately not a shell parser. */
function commandSegments(command: string): string[] {
  return command.split(/&&|\|\||[;|\n]/u).map(segment => segment.trim()).filter(segment => segment !== '')
}

/** Strip the trailing wildcard and whitespace a rule uses for prefix matching. */
function commandPrefix(spec: string): string {
  let prefix = spec.trim()
  if (prefix.endsWith(':*')) prefix = prefix.slice(0, -2)
  else if (prefix.endsWith('*')) prefix = prefix.slice(0, -1)
  return prefix.trim()
}

function commandMatches(command: string, spec: string): boolean {
  const prefix = commandPrefix(spec)
  const segments = commandSegments(command)
  if (segments.length === 0) return prefix === ''
  return segments.every(segment => segment === prefix || segment.startsWith(prefix))
}

function pathMatches(cwd: string, pattern: string, target: string): boolean {
  try {
    const absoluteTarget = isAbsolute(target) ? target : resolve(cwd, target)
    const absolutePattern = isAbsolute(pattern) ? pattern : resolve(cwd, pattern)
    const candidate = WINDOWS ? absoluteTarget.toLowerCase() : absoluteTarget
    const glob = WINDOWS ? absolutePattern.toLowerCase() : absolutePattern
    return matchesGlob(candidate, glob)
  } catch {
    return false
  }
}

function hostnameMatches(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase()
  const expected = domain.toLowerCase()
  return host === expected || host.endsWith(`.${expected}`)
}

/** Extract a command from the model's arguments for shell-rule matching. */
function commandOf(args: unknown): string | undefined {
  const record = objectOf(args)
  const command = record?.command
  if (typeof command === 'string') return command
  const script = record?.script
  return typeof script === 'string' ? script : undefined
}

/** Extract the path an edit or read targets. */
function pathOf(args: unknown): string | undefined {
  const record = objectOf(args)
  const filePath = record?.file_path
  if (typeof filePath === 'string' && filePath !== '') return filePath
  const path = record?.path
  return typeof path === 'string' && path !== '' ? path : undefined
}

/** Whether `target` resolves under `root`. */
function isWithin(root: string, target: string): boolean {
  const inside = relative(root, target)
  return inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))
}

function matchesRule(cwd: string, rule: PermissionRule, toolName: string, args: unknown): boolean {
  if (!sameTool(rule.tool, toolName)) return false
  const spec = rule.spec
  if (spec === undefined || spec === '') return true

  if (SHELL_TOOLS.has(toolName)) {
    const command = commandOf(args)
    return command !== undefined && commandMatches(command, spec)
  }

  if (toolName === 'WebFetch' && spec.startsWith('domain:')) {
    const record = objectOf(args)
    const url = record?.url
    if (typeof url !== 'string') return false
    try {
      return hostnameMatches(new URL(url).hostname, spec.slice('domain:'.length))
    } catch {
      return false
    }
  }

  if (toolName === 'Read' || EDIT_TOOLS.has(toolName)) {
    const path = pathOf(args)
    return path !== undefined && pathMatches(cwd, spec, path)
  }

  return false
}

function acceptsRule(rule: PermissionRule): boolean {
  if (rule.spec === undefined) return true
  const spec = rule.spec
  if (SHELL_TOOLS.has(rule.tool)) return true
  if (rule.tool === 'WebFetch') return spec.startsWith('domain:')
  return rule.tool === 'Read' || EDIT_TOOLS.has(rule.tool)
}

function createState(setup: PermissionSetup, cwd: string, toDsh: (name: string) => string | undefined): PermissionState {
  const allowed = setup.allowedRules.map(parseRule)
  const disallowed = setup.disallowedRules.map(parseRule)
  const disallowedDsH = new Set<string>()
  for (const rule of disallowed) {
    if (rule.spec !== undefined) continue
    const mapped = toDsh(rule.tool)
    if (mapped !== undefined) disallowedDsH.add(mapped)
  }
  return {
    mode: setup.permissionMode,
    cwd,
    addDirs: setup.addDirs,
    allowed,
    disallowed,
    disallowedDsH,
    denials: [],
    deniedCallIds: new Set(),
  }
}

function decide(state: PermissionState, toolName: string, args: unknown): PermissionDecision {
  for (const rule of state.disallowed) {
    if (matchesRule(state.cwd, rule, toolName, args)) {
      return { kind: 'deny', reason: DENY_REASON(toolName) }
    }
    // A parenthesized deny rule this build cannot evaluate fails closed.
    if (rule.spec !== undefined && !acceptsRule(rule) && sameTool(rule.tool, toolName)) {
      return { kind: 'deny', reason: DENY_REASON(toolName) }
    }
  }
  if (state.mode === 'bypassPermissions') return { kind: 'allow' }
  if (state.mode === 'plan') {
    return READ_ONLY.has(toolName) ? { kind: 'allow' } : { kind: 'deny', reason: DENY_REASON(toolName) }
  }
  if (READ_ONLY.has(toolName)) return { kind: 'allow' }
  for (const rule of state.allowed) {
    if (matchesRule(state.cwd, rule, toolName, args)) return { kind: 'allow' }
  }
  if (state.mode === 'acceptEdits' && EDIT_TOOLS.has(toolName)) {
    const path = pathOf(args)
    if (path !== undefined) {
      const absolute = isAbsolute(path) ? path : resolve(state.cwd, path)
      const roots = [state.cwd, ...state.addDirs]
      if (roots.some(root => isWithin(root, absolute))) return { kind: 'allow' }
    }
  }
  return { kind: 'deny', reason: DENY_REASON(toolName) }
}

function recordDenial(state: PermissionState, toolName: string, callId: string, input: unknown): void {
  if (state.deniedCallIds.has(callId)) return
  state.deniedCallIds.add(callId)
  state.denials.push({ tool_name: toolName, tool_use_id: callId, tool_input: input })
}

/**
 * Provide the permission service.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  ctx.provide(CC_PERMISSIONS_SERVICE, { createState, decide, recordDenial } satisfies CcPermissions)
}
