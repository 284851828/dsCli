/**
 * Claude Code system-prompt flags mapped onto DSH prompt sections.
 * @module @deepseek-ai/dsh-cc-cli/prompts
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Keep the appended text after every native section (native orders stop at 10200). */
const APPEND_ORDER = 10300

/**
 * Register `--system-prompt` and `--append-system-prompt` on one agent scope.
 * A replacement becomes the complete prompt; when both flags are present the
 * appended text joins the replacement so section order cannot separate them.
 * @param agentCtx - the agent's scoped context.
 * @param systemPrompt - replacement text, if any.
 * @param appendSystemPrompt - appended text, if any.
 */
export function installPromptSections(
  agentCtx: Context,
  systemPrompt: string | undefined,
  appendSystemPrompt: string | undefined,
): void {
  if (systemPrompt !== undefined) {
    const text = appendSystemPrompt === undefined
      ? systemPrompt
      : `${systemPrompt}\n\n${appendSystemPrompt}`
    agentCtx.systemPrompt.section({
      name: 'cc-system-prompt',
      order: APPEND_ORDER,
      text,
      interpolate: false,
      complete: true,
    })
    return
  }
  if (appendSystemPrompt !== undefined) {
    agentCtx.systemPrompt.section({
      name: 'cc-append-system-prompt',
      order: APPEND_ORDER,
      text: appendSystemPrompt,
      interpolate: false,
    })
  }
}
