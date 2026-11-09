/**
 * Model selection: CLI alias table, `provider/model`, environment fallback,
 * and loud rejection of unknown explicit models.
 * @module @deepseek-ai/dsh-cc-cli/model
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

/** The runner's configurable surface; a profile patch may replace the aliases. */
export interface CcRunnerConfig {
  /** Alias → model id or `provider/model`; an empty target keeps the profile default. */
  modelAliases?: Record<string, string>
}

/** Claude Code's short names. Empty targets keep the deployment default. */
export const DEFAULT_ALIASES: Readonly<Record<string, string>> = {
  opus: '',
  sonnet: '',
  haiku: '',
  fable: '',
}

/** Split on the first slash only, so provider names cannot hide model slashes. */
function splitOnce(value: string, separator: string): [string, string] {
  const index = value.indexOf(separator)
  return index === -1 ? [value, ''] : [value.slice(0, index), value.slice(index + 1)]
}

/**
 * Resolve this run's model. Priority: an explicit `--model`/`DSCLI_MODEL`
 * value, else the profile default. Explicit values are validated against the
 * provider catalog when that catalog is non-empty; profile defaults are the
 * deployment's responsibility and are never rejected here.
 * @param ctx - context carrying the LLM registry.
 * @param raw - the merged CLI/environment model request.
 * @param effort - explicit reasoning effort, if any.
 * @param fallback - the profile's current default selection.
 * @param config - alias overrides from the profile patch.
 * @returns the exact selection for this run.
 */
export async function resolveModel(
  ctx: Context,
  raw: string | undefined,
  effort: string | undefined,
  fallback: ModelSelection,
  config: CcRunnerConfig,
): Promise<ModelSelection> {
  const aliases = { ...DEFAULT_ALIASES, ...config.modelAliases }
  let provider = fallback.provider
  let model = fallback.model
  let explicit = false

  if (raw !== undefined && raw !== '') {
    if (Object.hasOwn(aliases, raw)) {
      const mapped = aliases[raw] ?? ''
      if (mapped !== '') {
        if (mapped.includes('/')) [provider, model] = splitOnce(mapped, '/')
        else model = mapped
      }
    } else {
      explicit = true
      if (raw.includes('/')) [provider, model] = splitOnce(raw, '/')
      else model = raw
    }
  }

  if (!ctx.llm.listProviders().some(row => row.id === provider)) {
    throw new Error(`unknown model provider "${provider}"; configure it or use --model <provider>/<model>`)
  }
  if (explicit) {
    const catalog = await ctx.llm.listModels(provider)
    if (catalog.length > 0 && !catalog.some(row => row.id === model)) {
      throw new Error(`unknown model "${model}" for provider "${provider}"; declared models: ${catalog.map(row => row.id).join(', ')}`)
    }
  }

  const reasoningEffort = effort ?? fallback.reasoningEffort
  return {
    provider,
    model,
    ...reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) },
  }
}
