/**
 * Session lifecycle for dscli: exact-id creation, `-r` resume, and `-c`
 * continuation of the newest compatible Session in the working directory.
 * @module @deepseek-ai/dsh-cc-cli/sessions
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-session-query'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'

/** A requested `--session-id` already names a stored Session. */
export class SessionExistsError extends Error {
  constructor(id: string) {
    super(`Session with ID ${id} already exists`)
    this.name = 'SessionExistsError'
  }
}

/** The requested Session is missing or cannot be adopted by this profile. */
export class NoConversationError extends Error {
  constructor(id: string | undefined) {
    super(id === undefined ? 'No conversation found to continue' : `No conversation found with session ID: ${id}`)
    this.name = 'NoConversationError'
  }
}

/** Whether a query failure simply means "this id is not stored". */
function isNotFound(error: unknown): boolean {
  return error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND'
}

/** A Session is adoptable only when its cwd, lineage, and composition match this profile. */
function assertAdoptable(header: SessionHeader, cwd: string, id: string | undefined): void {
  if (header.origin === 'subagent') throw new NoConversationError(id)
  if (header.agentPreset !== undefined) throw new NoConversationError(id)
  if (header.cwd !== cwd) throw new NoConversationError(id)
}

/** Bind this run's route and composition to a freshly created or resumed Agent. */
export type SessionSetup = AgentSetup

interface CreateOptions {
  id: string | undefined
  cwd: string
  agentOptions: AgentOptions
  setup: SessionSetup
}

/**
 * Create a Session, refusing a `--session-id` that already exists.
 * @param ctx - context carrying the Agent registry and Session query.
 * @param options - requested identity, working directory, route, and setup.
 * @returns the new Agent.
 */
export async function createSession(ctx: Context, options: CreateOptions): Promise<Agent> {
  if (options.id !== undefined) {
    try {
      using observation = await ctx.sessionQuery.observeSession(brandString<SessionId>(options.id))
      void observation
      throw new SessionExistsError(options.id)
    } catch (error: unknown) {
      if (!isNotFound(error)) throw error
    }
  }
  const sessionId = brandString<SessionId>(options.id ?? randomUUID())
  const { agent } = await ctx.agents.create({
    sessionId,
    meta: { cwd: options.cwd },
    agentOptions: options.agentOptions,
    setup: options.setup,
  })
  return agent
}

/**
 * Resume an existing Session that this profile can adopt.
 * @param ctx - context carrying the Agent registry and Session query.
 * @param id - exact stored Session identity.
 * @param cwd - working directory that must match the stored header.
 * @param agentOptions - route for this run.
 * @param setup - scoped composition for this run.
 * @returns the resumed Agent.
 */
export async function resumeSession(
  ctx: Context,
  id: string,
  cwd: string,
  agentOptions: AgentOptions,
  setup: SessionSetup,
): Promise<Agent> {
  try {
    using observation = await ctx.sessionQuery.observeSession(brandString<SessionId>(id))
    assertAdoptable(observation.header, cwd, id)
  } catch (error: unknown) {
    if (isNotFound(error)) throw new NoConversationError(id)
    throw error
  }
  try {
    const { agent } = await ctx.agents.resume({
      resumeSessionId: brandString<SessionId>(id),
      agentOptions,
      setup,
    })
    assertAdoptable(agent.session.header, cwd, id)
    return agent
  } catch (error: unknown) {
    if (isNotFound(error)) throw new NoConversationError(id)
    throw error
  }
}

/**
 * Continue the newest Session created in this working directory.
 * @param ctx - context carrying the Session query and Agent registry.
 * @param cwd - working directory to match.
 * @param agentOptions - route for this run.
 * @param setup - scoped composition for this run.
 * @returns the resumed Agent.
 */
export async function continueSession(
  ctx: Context,
  cwd: string,
  agentOptions: AgentOptions,
  setup: SessionSetup,
): Promise<Agent> {
  const records = await ctx.sessionQuery.listSessions()
  const newest = records.find(record =>
    record.header.cwd === cwd
    && record.header.origin !== 'subagent'
    && record.header.agentPreset === undefined)
  if (newest === undefined) throw new NoConversationError(undefined)
  return resumeSession(ctx, newest.header.id, cwd, agentOptions, setup)
}
