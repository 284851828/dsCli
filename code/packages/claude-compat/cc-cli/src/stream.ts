/**
 * Projection of DSH session events onto Claude Code's event stream. The
 * projection never truncates: one event is one JSON line of arbitrary length.
 * @module @deepseek-ai/dsh-cc-cli/stream
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { OutputFormat } from './startup.ts'

/** Stable Cordis plugin name. */
export const name = 'cc-stream'

/** Service provided by this plugin and injected by the runner. */
export const CC_STREAM_SERVICE = 'ccStream'

/** One stdout line destination. */
export interface CcSink {
  write(chunk: string): unknown
}

/** One permission denial recorded for the result event. */
export interface PermissionDenial {
  tool_name: string
  tool_use_id: string
  tool_input: unknown
}

/** Everything a projection needs that the runner resolved before the task. */
export interface ProjectionOptions {
  format: OutputFormat
  sessionId: string
  cwd: string
  model: string
  tools: string[]
  permissionMode: string
  /** First session seq owned by this run. */
  firstSeq: number
  /** Claude-facing name for one DSH tool. */
  toClaude(name: string): string
}

/** The live projection of one run. */
export interface CcProjection {
  /** Write the single result (and, for text, the final reply), then wait for delivery. */
  finish(text: string, reason: { kind: string } | undefined, denials: PermissionDenial[]): Promise<void>
  /** Write an error result for a run that already announced itself. */
  fail(message: string, denials: PermissionDenial[]): Promise<void>
  /** Stop observing the Session. */
  dispose(): void
}

/** The projection service shared by the runner. */
export interface CcStreamService {
  /** Follow one Agent's session events from `options.firstSeq` and write stdout events. */
  project(ctx: Context, agent: Agent, sink: CcSink, options: ProjectionOptions): CcProjection
  /** Write a pre-run failure result (no init event) for json/stream-json output. */
  errorResult(sink: CcSink, format: OutputFormat, sessionId: string, message: string): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Claude-compatible event projection. */
    ccStream: CcStreamService
  }
}

type ClaudeContent =
  | { type: 'thinking'; thinking: string; signature: '' }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }

type TurnReason = { kind: string } | undefined

interface Totals {
  input: number
  output: number
  cacheCreation: number
  cacheRead: number
}

const EMPTY_TOTALS: Totals = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }

/** Parse a tool's raw JSON arguments; keep the raw text when the model sent invalid JSON. */
export function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

function line(event: unknown): string {
  return `${JSON.stringify(event)}\n`
}

function timestamp(): string {
  return new Date().toISOString()
}

/** Render one assistant message, preserving whitespace and ordering. */
function assistantEvent(
  options: ProjectionOptions,
  id: string,
  content: ClaudeContent[],
  usage: { input_tokens: number; output_tokens: number },
): unknown {
  return {
    type: 'assistant',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: options.model,
      content,
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
    parent_tool_use_id: null,
    session_id: options.sessionId,
    uuid: randomUUID(),
    timestamp: timestamp(),
  }
}

function resultEvent(
  options: ProjectionOptions,
  subtype: 'success' | 'error_during_execution',
  text: string,
  numTurns: number,
  totals: Totals,
  denials: PermissionDenial[],
  startedAt: number,
): unknown {
  const duration = Date.now() - startedAt
  return {
    type: 'result',
    subtype,
    is_error: subtype !== 'success',
    result: text,
    num_turns: numTurns,
    duration_ms: duration,
    duration_api_ms: duration,
    total_cost_usd: 0,
    usage: {
      input_tokens: totals.input,
      output_tokens: totals.output,
      cache_creation_input_tokens: totals.cacheCreation,
      cache_read_input_tokens: totals.cacheRead,
    },
    session_id: options.sessionId,
    permission_denials: denials,
    uuid: randomUUID(),
    timestamp: timestamp(),
  }
}

/** Fold a DSH token usage record into the Claude totals. */
function addUsage(totals: Totals, usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } | undefined): { input_tokens: number; output_tokens: number } {
  if (usage === undefined) return { input_tokens: 0, output_tokens: 0 }
  totals.input += usage.inputTokens
  totals.output += usage.outputTokens
  totals.cacheCreation += usage.cacheWriteTokens ?? 0
  totals.cacheRead += usage.cacheReadTokens ?? 0
  return { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens }
}

class Projection implements CcProjection {
  private readonly buffer: ClaudeContent[] = []
  private pendingUsage = { input_tokens: 0, output_tokens: 0 }
  private readonly totals: Totals = { ...EMPTY_TOTALS }
  private turns = 0
  private readonly startedAt = Date.now()
  private readonly stop: () => void

  constructor(
    ctx: Context,
    private readonly agent: Agent,
    private readonly sink: CcSink,
    private readonly options: ProjectionOptions,
  ) {
    this.stop = ctx.on('session/event', (session, event) => {
      if (session !== this.agent.session) return
      if (Number(event.seq) < options.firstSeq) return
      this.observe(event)
    })
    if (options.format === 'stream-json') {
      sink.write(line({
        type: 'system',
        subtype: 'init',
        session_id: options.sessionId,
        cwd: options.cwd,
        model: options.model,
        tools: options.tools,
        mcp_servers: [],
        permissionMode: options.permissionMode,
        apiKeySource: 'none',
        claude_code_version: '2.1.319',
        output_style: 'default',
        agents: [],
        skills: [],
        plugins: [],
        uuid: randomUUID(),
        timestamp: timestamp(),
      }))
    }
  }

  private observe(event: SessionEvent): void {
    switch (event.type) {
      case 'assistant/message': {
        this.flush()
        for (const block of event.data.message.content) {
          if (block.type === 'reasoning') {
            if (block.text !== '') this.buffer.push({ type: 'thinking', thinking: block.text, signature: '' })
          } else if (block.type === 'text') {
            if (block.text !== '') this.buffer.push({ type: 'text', text: block.text })
          }
        }
        this.pendingUsage = addUsage(this.totals, event.data.usage)
        return
      }
      case 'tool/call': {
        this.buffer.push({
          type: 'tool_use',
          id: event.data.callId,
          name: this.options.toClaude(event.data.name),
          input: parseArguments(event.data.arguments),
        })
        return
      }
      case 'tool/result': {
        this.flush()
        if (event.surfaceOp !== 'append') return
        const message = event.data.message
        const text = message.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('')
        this.write({
          type: 'user',
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: message.toolCallId,
              content: text,
              is_error: message.isError === true,
            }],
          },
          parent_tool_use_id: null,
          session_id: this.options.sessionId,
          uuid: randomUUID(),
          timestamp: timestamp(),
        })
        return
      }
      case 'step/end': {
        this.flush()
        return
      }
      case 'turn/end': {
        this.flush()
        return
      }
      default:
        return
    }
  }

  /** Write one buffered assistant message, if any content accumulated. */
  private flush(): void {
    if (this.buffer.length === 0) return
    const content = this.buffer.splice(0)
    this.turns += 1
    this.write(assistantEvent(this.options, randomUUID(), content, this.pendingUsage))
    this.pendingUsage = { input_tokens: 0, output_tokens: 0 }
  }

  private write(event: unknown): void {
    if (this.options.format !== 'stream-json') return
    this.sink.write(line(event))
  }

  async finish(text: string, reason: TurnReason, denials: PermissionDenial[]): Promise<void> {
    this.flush()
    const subtype = reason?.kind === 'completed' ? 'success' : 'error_during_execution'
    if (this.options.format === 'text') {
      // A failed turn has no reply to print; its diagnostic goes to stderr.
      if (subtype === 'success') this.sink.write(`${text}\n`)
      return
    }
    this.sink.write(line(resultEvent(this.options, subtype, text, this.turns, this.totals, denials, this.startedAt)))
  }

  async fail(message: string, denials: PermissionDenial[]): Promise<void> {
    this.flush()
    if (this.options.format === 'text') return
    this.sink.write(line(resultEvent(this.options, 'error_during_execution', message, this.turns, this.totals, denials, this.startedAt)))
  }

  dispose(): void {
    this.stop()
  }
}

function project(ctx: Context, agent: Agent, sink: CcSink, options: ProjectionOptions): CcProjection {
  return new Projection(ctx, agent, sink, options)
}

async function errorResult(sink: CcSink, format: OutputFormat, sessionId: string, message: string): Promise<void> {
  if (format === 'text') return
  sink.write(line(resultEvent(
    {
      format,
      sessionId,
      cwd: '',
      model: '',
      tools: [],
      permissionMode: 'default',
      firstSeq: 0,
      toClaude: toolName => toolName,
    },
    'error_during_execution',
    message,
    0,
    { ...EMPTY_TOTALS },
    [],
    Date.now(),
  )))
}

/**
 * Provide the event projection service.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  ctx.provide(CC_STREAM_SERVICE, { project, errorResult } satisfies CcStreamService)
}
