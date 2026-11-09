/**
 * The dscli command line: every Claude Code non-interactive flag this build
 * accepts, the unknown-flag compatibility scan, and the validated
 * {@link CC_STARTUP_SERVICE} the runner consumes.
 * @module @deepseek-ai/dsh-cc-cli/startup
 */

import { Command, CommanderError, Option } from 'commander'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-cmdline'
import { internals } from './internals.ts'

/** Stable Cordis plugin name. */
export const name = 'cc-startup'

/** Services required before this invocation can be parsed. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the runner. */
export const CC_STARTUP_SERVICE = 'ccStartup'

/** The version string Claude Code clients assert against. */
export const CLAUDE_CODE_VERSION = '2.1.319'

/** The `--version` output. */
export const VERSION = `${CLAUDE_CODE_VERSION} (Claude Code compatible; dsCli 0.1.0)`

/** Output shape selected on the command line. */
export type OutputFormat = 'text' | 'json' | 'stream-json'

/** What the runner reads from {@link CC_STARTUP_SERVICE}. */
export interface CcStartupValues {
  /** The prompt positional, joined by spaces; absent when stdin supplies the task. */
  prompt: string | undefined
  /** Selected stdout projection. */
  outputFormat: OutputFormat
  /** Whether `--verbose` accompanied the invocation (only meaningful for stream-json). */
  verbose: boolean
  /** Exact Session identity to create; absent for a generated UUID. */
  sessionId: string | undefined
  /** Existing Session identity to resume; absent when not resuming. */
  resumeId: string | undefined
  /** Whether `-c` selects the newest Session in the working directory. */
  continueLatest: boolean
  /** Normalized permission mode: default | acceptEdits | bypassPermissions | plan. */
  permissionMode: string
  /** Claude tool allowlist; `undefined` keeps every tool, `[]` keeps none. */
  tools: string[] | undefined
  /** `--allowedTools` rules, used only by the permission decision. */
  allowedRules: string[]
  /** `--disallowedTools` rules, applied before every other permission decision. */
  disallowedRules: string[]
  /** Absolute additional writable roots for `acceptEdits`. */
  addDirs: string[]
  /** Model override from `--model` or `DSCLI_MODEL`; absent keeps the profile default. */
  model: string | undefined
  /** Reasoning effort passed through to the selected provider. */
  effort: string | undefined
  /** Replacement system prompt. */
  systemPrompt: string | undefined
  /** Additional system prompt kept alongside the native sections. */
  appendSystemPrompt: string | undefined
  /** Whether unknown flags abort instead of warning. */
  strict: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Parsed arguments of this dscli invocation. */
    ccStartup: CcStartupValues
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** The permission modes this build accepts (unknown values are usage errors). */
const PERMISSION_MODES = new Set([
  'default', 'manual', 'dontAsk', 'acceptEdits', 'bypassPermissions', 'plan', 'auto',
])

/** Split Claude's comma-or-space tool lists into individual non-empty entries. */
function splitList(values: readonly string[]): string[] {
  return values
    .flatMap(value => value.split(','))
    .map(value => value.trim())
    .filter(value => value !== '')
}

/** Normalize `--tools` variadic values into the runner's tri-state allowlist. */
function normalizeTools(values: readonly string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined
  const entries = splitList(values)
  if (entries.length === 1 && entries[0] === 'default') return undefined
  if (entries.length === 0) return []
  return entries
}

/** Build the app command; every runtime behavior lives in its action. */
function dscliCommand(): Command {
  return new Command()
    .name('dsCli')
    .description('Claude Code compatible non-interactive runner over the DeepSeek Harness core.')
    .version(VERSION, '-v, --version', 'output the version number')
    .helpOption('-h, --help', 'show this help')
    .option('-p, --print', 'answer one prompt and exit (required; interactive mode is not supported)')
    .addOption(new Option('--output-format <format>', 'stdout projection: text (default), json, or stream-json')
      .choices(['text', 'json', 'stream-json']))
    .option('--verbose', 'enable stream-json output (required together with --output-format stream-json)')
    .option('--session-id <uuid>', 'create a Session with this exact UUID; an existing id is an error')
    .option('-r, --resume <id>', 'resume an existing Session by id')
    .option('-c, --continue', 'continue the newest Session created in this working directory')
    .option('--permission-mode <mode>', 'default | manual | dontAsk | acceptEdits | bypassPermissions | plan | auto')
    .option('--dangerously-skip-permissions', 'alias for --permission-mode bypassPermissions')
    .option('--tools <tools...>', 'only these Claude tools are available (comma or space separated)')
    .option('--allowedTools <tools...>', 'permission rules to allow without further checks')
    .option('--disallowedTools <tools...>', 'permission rules to deny before every other decision')
    .option('--add-dir <path>', 'additional writable directory for acceptEdits (repeatable)',
      (value: string, previous: string[] | undefined) => [...previous ?? [], value])
    .option('--model <model>', 'model alias, model id, or provider/model')
    .option('--effort <level>', 'reasoning effort understood by the selected provider')
    .option('--system-prompt <text>', 'replace the whole system prompt')
    .option('--append-system-prompt <text>', 'append text to the system prompt')
    .option('--strict-mcp-config', 'accepted for compatibility; this build loads no external MCP servers')
    .argument('[prompt...]', 'the task text; multiple words are joined by spaces, and `-` reads stdin')
    .addHelpText('after', `
Examples:
  dsCli -p "run the tests"
  echo "run the tests" | dsCli -p
  dsCli -p --output-format stream-json --verbose "read a.txt"
  dsCli -p --resume <session-id> "continue"
`)
}

/** Whether the environment asks unknown flags to fail instead of warn. */
function strictRequested(): boolean {
  const value = process.env.DSCLI_STRICT
  return value === '1' || value === 'true'
}

/**
 * Drop flags this command does not declare, warning once per flag. Only the
 * flag token itself is dropped, never the token after it, so a prompt that
 * follows an unknown flag survives. Sanctioned misspellings are not a reason
 * to abort a run, but `DSCLI_STRICT` makes them fatal.
 * @param argv - the invocation's raw arguments.
 * @param program - the command whose declared options define what is known.
 * @param exit - the launcher's exit request.
 * @returns the arguments Commander should parse, or `undefined` after a fatal rejection.
 */
function filterUnknownArgs(
  argv: readonly string[],
  program: Command,
  exit: (code: number) => void,
): string[] | undefined {
  // Commander keeps the help option outside `program.options`.
  const longs = new Set<string>(['--help'])
  const shorts = new Set<string>(['-h'])
  for (const option of program.options) {
    if (option.long !== undefined) longs.add(option.long)
    if (option.short !== undefined) shorts.add(option.short)
  }
  const strict = strictRequested()
  const kept: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === undefined) continue
    if (token === '--') {
      kept.push(...argv.slice(index))
      break
    }
    if (token === '-' || !token.startsWith('-')) {
      kept.push(token)
      continue
    }
    const equals = token.indexOf('=')
    const flag = equals === -1 ? token : token.slice(0, equals)
    const known = flag.startsWith('--') ? longs.has(flag) : shorts.has(flag)
    if (known) {
      kept.push(token)
      continue
    }
    if (strict) {
      internals.stderr.write(`dsCli: ${flag} is not supported\n`)
      exit(1)
      return undefined
    }
    internals.stderr.write(`dsCli: ${flag} is not supported, ignored\n`)
  }
  return kept
}

/**
 * Normalize the permission mode, or report an unsupported value.
 * `manual` and `dontAsk` are Claude's non-interactive defaults; `auto` has no
 * DSH equivalent, so it warns instead of silently choosing a different policy.
 * @param program - command used for the usage error.
 * @param raw - the value supplied on the command line, if any.
 * @returns the normalized mode.
 */
function permissionMode(program: Command, raw: string | undefined): string {
  if (raw === undefined) return 'default'
  const value = raw.trim()
  if (!PERMISSION_MODES.has(value)) {
    program.error(`error: option '--permission-mode <mode>' argument '${value}' is invalid`)
  }
  if (value === 'auto') {
    internals.stderr.write('dsCli: --permission-mode auto is not supported, ignored; using default.\n')
    return 'default'
  }
  if (value === 'manual' || value === 'dontAsk') return 'default'
  return value
}

/** Resolve the task text: positionals joined by spaces, or absent for stdin. */
function promptOf(program: Command): string | undefined {
  return program.args.length === 0 ? undefined : program.args.join(' ')
}

/**
 * Parse this invocation and publish its validated values. Help, version, and
 * usage errors exit through the launcher without providing the service, so
 * the runner never starts for them.
 * @param ctx - plugin context carrying the raw command line and exit request.
 */
export function apply(ctx: Context): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('cc-startup: the launcher must provide ctx.appExit')
  const program = dscliCommand()
  const raw = ctx.get('cmdlineArgs')?.get() ?? []
  const filtered = filterUnknownArgs(raw, program, exit)
  if (filtered === undefined) return

  program.exitOverride()
  program.configureOutput({
    writeOut: chunk => { internals.stdout.write(chunk) },
    writeErr: chunk => { internals.stderr.write(chunk) },
  })
  program.action(() => {
    const options = program.opts<{
      print?: boolean
      outputFormat?: OutputFormat
      verbose?: boolean
      sessionId?: string
      resume?: string
      continue?: boolean
      permissionMode?: string
      dangerouslySkipPermissions?: boolean
      tools?: string[]
      allowedTools?: string[]
      disallowedTools?: string[]
      addDir?: string[]
      model?: string
      effort?: string
      systemPrompt?: string
      appendSystemPrompt?: string
    }>()

    if (options.print !== true) {
      internals.stderr.write('dsCli: 交互模式暂不支持，请使用 -p\n')
      exit(1)
      return
    }

    const outputFormat = options.outputFormat ?? 'text'
    if (outputFormat === 'stream-json' && options.verbose !== true) {
      internals.stderr.write('Error: When using --print, --output-format=stream-json requires --verbose\n')
      exit(1)
      return
    }

    const sessionId = options.sessionId
    if (sessionId !== undefined && !UUID.test(sessionId)) {
      internals.stderr.write('dsCli: --session-id must be a UUID\n')
      exit(1)
      return
    }
    if (sessionId !== undefined && (options.resume !== undefined || options.continue === true)) {
      internals.stderr.write('dsCli: --session-id cannot be combined with --resume or --continue\n')
      exit(1)
      return
    }
    if (options.resume !== undefined && options.continue === true) {
      internals.stderr.write('dsCli: --resume cannot be combined with --continue\n')
      exit(1)
      return
    }

    let mode = permissionMode(program, options.permissionMode)
    if (options.dangerouslySkipPermissions === true) mode = 'bypassPermissions'

    const model = (options.model !== undefined && options.model.trim() !== '' ? options.model.trim() : undefined)
      ?? (process.env.DSCLI_MODEL !== undefined && process.env.DSCLI_MODEL.trim() !== '' ? process.env.DSCLI_MODEL.trim() : undefined)

    ctx.provide(CC_STARTUP_SERVICE, {
      prompt: promptOf(program),
      outputFormat,
      verbose: options.verbose === true,
      sessionId,
      resumeId: options.resume,
      continueLatest: options.continue === true,
      permissionMode: mode,
      tools: normalizeTools(options.tools),
      allowedRules: splitList(options.allowedTools ?? []),
      disallowedRules: splitList(options.disallowedTools ?? []),
      addDirs: [...new Set((options.addDir ?? []).map(path => resolve(path)))],
      model,
      effort: options.effort,
      systemPrompt: options.systemPrompt,
      appendSystemPrompt: options.appendSystemPrompt,
      strict: strictRequested(),
    } satisfies CcStartupValues)
  })

  try {
    program.parse(filtered, { from: 'user' })
  } catch (error: unknown) {
    if (error instanceof CommanderError) {
      exit(error.exitCode)
      return
    }
    throw error
  }
}
