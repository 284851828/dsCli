/**
 * The dscli runner: resolve the task and model, create or adopt one Agent,
 * install Claude-compatible tools, prompts, and permissions, project the turn,
 * write one result, and exit.
 * @module @deepseek-ai/dsh-cc-cli
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-subagent'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { CcStartupValues } from './startup.ts'
import type {} from './tool-names.ts'
import { parseArguments } from './stream.ts'
import type { CcProjection, PermissionDenial } from './stream.ts'
import type { PermissionState } from './permissions.ts'
import { resolveModel } from './model.ts'
import { installPromptSections } from './prompts.ts'
import { continueSession, createSession, NoConversationError, resumeSession, SessionExistsError } from './sessions.ts'
import { flushStdout, internals } from './internals.ts'

/** Stable Cordis plugin name. */
export const name = 'cc-runner'

/** Services required before one task can run. */
export const inject = [
  'ccStartup',
  'ccToolNames',
  'ccStream',
  'ccPermissions',
  'agents',
  'agentDefaultModel',
  'sessions',
  'sessionQuery',
  'llm',
]

/** Plugin config: the alias table lives in code and a profile patch may replace it. */
export interface Config {
  /** Alias → model id or `provider/model`; empty targets keep the profile default. */
  modelAliases?: Record<string, string>
}

export const Config: z<Config> = z.object({
  modelAliases: z.dict(z.string()),
})

/** Process-facing effects of one run. */
interface CcIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  exit(code: number): void
}

/** A usage error whose message already carries Claude's `Error: ` prefix. */
class InputError extends Error {
  constructor() {
    super('Error: Input must be provided either through stdin or as a prompt argument when using --print')
    this.name = 'InputError'
  }
}

/** Resolve the task from the positionals or stdin. */
async function resolveTask(startup: CcStartupValues): Promise<string> {
  if (startup.prompt !== undefined && startup.prompt !== '-') {
    if (startup.prompt.trim() === '') throw new InputError()
    return startup.prompt
  }
  if (internals.stdinIsTty()) throw new InputError()
  const text = await internals.readStdin()
  if (text.trim() === '') throw new InputError()
  return text
}

/** Collect this run's final assistant text and terminal reason from the durable log. */
function summarize(session: Session, firstSeq: SessionLogOffset): { text: string; reason: SessionEvent<'turn/end'>['data']['reason'] | undefined } {
  let text = ''
  let reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
  const length = session.seq
  for (let seq = firstSeq; seq < length; seq++) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const event = session.eventAt(SessionSeq(seq))
    if (event === undefined) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}

/** Render one failure the way Claude clients expect to read it. */
function diagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof NoConversationError) return `${message}\n`
  if (error instanceof SessionExistsError || error instanceof InputError || message.startsWith('Error: ')) {
    return `${message}\n`
  }
  return `dsCli: ${message}\n`
}

/** Report an unexpected failure and request a failing exit. */
async function reportFailure(
  io: CcIo,
  startup: CcStartupValues | undefined,
  projection: CcProjection | undefined,
  sessionId: string,
  denials: PermissionDenial[],
  error: unknown,
  stream: Context['ccStream'],
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  if (projection !== undefined) {
    await projection.fail(message, denials)
  } else {
    await stream.errorResult(io.stdout, startup?.outputFormat ?? 'text', sessionId, message)
  }
  io.stderr.write(diagnostic(error))
  await flushStdout()
  io.exit(1)
}

/**
 * Run one task through one Agent and request process exit.
 * @param ctx - plugin context carrying all dscli services plus the core registry.
 * @param config - alias overrides.
 * @param io - process-facing effects.
 */
async function run(ctx: Context, config: Config, io: CcIo): Promise<void> {
  const startup = ctx.get('ccStartup')
  const names = ctx.get('ccToolNames')
  const stream = ctx.get('ccStream')
  const permissions = ctx.get('ccPermissions')
  if (startup === undefined || names === undefined || stream === undefined || permissions === undefined) return

  let projection: CcProjection | undefined
  let permissionState: PermissionState | undefined
  const requestedId = startup.sessionId ?? startup.resumeId ?? ''

  try {
    await ctx.get('loader')?.await()
    const agents = ctx.get('agents')
    const defaultModel = ctx.get('agentDefaultModel')
    const sessions = ctx.get('sessions')
    if (agents === undefined || defaultModel === undefined || sessions === undefined) return

    const task = await resolveTask(startup)
    const selection = await resolveModel(
      ctx,
      startup.model,
      startup.effort,
      defaultModel.currentSelection(),
      config,
    )

    const fs = ctx.get('fs')
    const cwd = fs === undefined ? process.cwd() : fs.processPath(await fs.resolve('.'))
    const agentOptions: AgentOptions = { ...selection }
    let initTools: string[] = []

    const setup: AgentSetup = (agentCtx, agent) => {
      agent.model.select(selection)
      installModelSelection(agentCtx)

      const visible = new Set(agentCtx.tools.definitions(scopeOf(agentCtx)).map(definition => definition.name))
      if (startup.tools !== undefined) {
        const allow: string[] = []
        for (const requested of startup.tools) {
          const native = names.toDsh(requested)
          if (native === undefined || !visible.has(native)) {
            internals.stderr.write(`dsCli: tool "${requested}" is not available, ignored\n`)
            continue
          }
          allow.push(native)
        }
        agentCtx.tools.restrict({ allow })
      }
      const deny = startup.disallowedRules
        .filter(rule => !rule.includes('('))
        .map(rule => names.toDsh(rule))
        .filter((native): native is string => native !== undefined && visible.has(native))
      if (deny.length > 0) agentCtx.tools.restrict({ deny })

      initTools = agentCtx.tools.definitions(scopeOf(agentCtx)).map(definition => names.toClaude(definition.name))
      installPromptSections(agentCtx, startup.systemPrompt, startup.appendSystemPrompt)
      // Claude Code sends context reminders before the prompt, so the prompt
      // stays the last user text the model reads.
      agentCtx.on('agent/pre-step', async (_payload, next) => {
        const decision = await next()
        if (decision.kind !== 'enter') return decision
        const isContext = (message: { source: { kind: string } }): boolean => message.source.kind === 'runtime-context'
        return {
          ...decision,
          messages: [...decision.messages.filter(isContext), ...decision.messages.filter(message => !isContext(message))],
        }
      })
    }

    let agent: Agent
    if (startup.sessionId !== undefined) {
      agent = await createSession(ctx, {
        id: startup.sessionId,
        cwd,
        agentOptions,
        setup,
      })
    } else if (startup.resumeId !== undefined) {
      agent = await resumeSession(ctx, startup.resumeId, cwd, agentOptions, setup)
    } else if (startup.continueLatest) {
      agent = await continueSession(ctx, cwd, agentOptions, setup)
    } else {
      agent = await createSession(ctx, { id: undefined, cwd, agentOptions, setup })
    }

    await agent.whenIdle()
    const firstSeq = agent.session.seq
    const sessionId = String(agent.session.id)
    projection = stream.project(ctx, agent, io.stdout, {
      format: startup.outputFormat,
      sessionId,
      cwd,
      model: selection.model,
      tools: initTools,
      permissionMode: startup.permissionMode,
      firstSeq: Number(firstSeq),
      toClaude: name => names.toClaude(name),
    })

    permissionState = permissions.createState(
      {
        permissionMode: startup.permissionMode,
        allowedRules: startup.allowedRules,
        disallowedRules: startup.disallowedRules,
        addDirs: startup.addDirs,
      },
      cwd,
      name => names.toDsh(name),
    )
    const state = permissionState

    const stopPreExecute = ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.agent !== agent) return next()
      const claudeName = names.toClaude(exec.name)
      const decision = permissions.decide(state, claudeName, exec.arguments)
      if (decision.kind === 'deny') permissions.recordDenial(state, claudeName, exec.callId, exec.arguments)
      return decision
    })
    const stopCalls = ctx.on('session/event', (session, event) => {
      if (session !== agent.session || event.type !== 'tool/call') return
      if (!state.disallowedDsH.has(event.data.name)) return
      permissions.recordDenial(
        state,
        names.toClaude(event.data.name),
        event.data.callId,
        parseArguments(event.data.arguments),
      )
    })

    let failure: { error: unknown; atOffset: SessionLogOffset } | undefined
    const stopErrors = ctx.on('agent/error', ({ agent: subject, error }) => {
      if (subject === agent) failure = { error, atOffset: agent.session.seq }
    })
    const stopTerminals = ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'turn/end'
        && failure !== undefined && event.seq >= failure.atOffset) failure = undefined
    })

    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: task }],
        source: { kind: 'user' },
      }))
      const subagents = ctx.get('subagents')
      while (true) {
        await agent.whenIdle()
        const idleSeq = agent.session.seq
        if (!await subagents?.waitForTreeWork(agent)
          && agent.status === 'idle' && agent.session.seq === idleSeq) break
      }
      await sessions.flush(agent.session)
      if (failure !== undefined) throw failure.error
    } finally {
      stopPreExecute()
      stopCalls()
      stopErrors()
      stopTerminals()
    }

    const outcome = summarize(agent.session, firstSeq)
    projection.finish(outcome.text, outcome.reason, state.denials)
    await flushStdout()
    projection.dispose()
    projection = undefined

    const reason = outcome.reason as { kind?: string; error?: { code?: string; message?: string } } | undefined
    if (reason?.kind === 'error') {
      io.stderr.write(`dsCli: Error: ${reason.error?.code ?? 'UNKNOWN'}: ${reason.error?.message ?? 'turn failed'}\n`)
    }
    await flushStdout()
    io.exit(reason?.kind === 'completed' ? 0 : 1)
  } catch (error: unknown) {
    await reportFailure(
      io,
      startup,
      projection,
      startup.sessionId ?? startup.resumeId ?? requestedId,
      permissionState?.denials ?? [],
      error,
      stream,
    )
  }
}

/**
 * Mount the dscli runner.
 * @param ctx - plugin context carrying the app's parsed values and core services.
 * @param config - alias overrides.
 */
export function apply(ctx: Context, config: Config): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('cc-runner: the launcher must provide ctx.appExit')
  const io: CcIo = { stdout: internals.stdout, stderr: internals.stderr, exit }
  void run(ctx, config, io).catch((error: unknown) => {
    io.stderr.write(diagnostic(error))
    io.exit(1)
  })
}
