/**
 * The interactive terminal's `/model` command: it reports the live model route
 * and switches it mid-session. Switching mutates the Agent-scoped
 * {@link ModelSelectionRef} the client installed at creation, which
 * `installModelSelection` reads at the start of each step — so a switch lands
 * on the next turn without replacing the live Agent or its session.
 *
 * The switch needs no session event of its own: the loop logs a
 * `request/header` event whenever the assembled route changes, and that header
 * carries the provider and model, so the route in force at any point stays
 * reconstructable from the log.
 *
 * @module @deepseek-ai/dsh-tui/model-command
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'

/** A model route requested by a flag or a command, before validation. */
export interface RequestedRoute {
  /** Registered provider route, when the request named one. */
  provider?: string
  /** Provider-owned model id, when the request named one. */
  model?: string
}

/**
 * Split a `/model` argument into its optional provider and model parts. The
 * first `/` separates a provider from the model id, so a provider-qualified id
 * whose model itself contains `/` keeps the remainder intact; a bare token is a
 * model on the current provider.
 * @param input - the raw argument text following the command name.
 * @returns the requested route; both fields absent for empty input.
 */
export function parseModelArgument(input: string): RequestedRoute {
  const trimmed = input.trim()
  if (trimmed === '') return {}
  const separator = trimmed.indexOf('/')
  if (separator === -1) return { model: trimmed }
  const provider = trimmed.slice(0, separator)
  const model = trimmed.slice(separator + 1)
  return {
    ...provider === '' ? {} : { provider },
    ...model === '' ? {} : { model },
  }
}

/**
 * Resolve a requested route against the current selection, validating the
 * provider against the registered set. The model id is not checked: a provider
 * catalog is advisory and never governs request routing, so an uncatalogued but
 * valid id must still be accepted.
 * @param registered - every registered provider route id.
 * @param current - the selection the request overrides.
 * @param requested - the requested provider and model.
 * @returns the resolved selection, or a message naming the valid providers.
 */
export function resolveRequestedSelection(
  registered: readonly string[],
  current: ModelSelection,
  requested: RequestedRoute,
): { selection: ModelSelection } | { error: string } {
  if (requested.provider !== undefined && !registered.includes(requested.provider)) {
    const known = registered.length === 0 ? '(none registered)' : registered.join(', ')
    return { error: `unknown provider "${requested.provider}"; registered providers: ${known}` }
  }
  return {
    selection: {
      ...current,
      ...requested.provider === undefined ? {} : { provider: requested.provider },
      ...requested.model === undefined ? {} : { model: requested.model },
    },
  }
}

/** Services and state the `/model` command reads and mutates. */
export interface ModelCommandDeps {
  /** The live Agent-scoped selection; mutating `current` switches the route. */
  selection: ModelSelectionRef
  /** The selection in force when the session started, used before any switch. */
  fallback: ModelSelection
}

/** Render the live route plus the discoverable providers and models. */
async function describeRoute(ctx: Context, active: ModelSelection): Promise<string> {
  const lines = [`model: ${active.provider}/${active.model}`]
  const llm = ctx.get('llm')
  if (llm === undefined) return `${lines[0]}\n(model discovery is unavailable in this composition)`
  lines.push('', 'providers:')
  for (const provider of llm.listProviders()) {
    const mark = provider.id === active.provider ? '*' : ' '
    lines.push(`  ${mark} ${provider.id}  ${provider.name}`)
  }
  try {
    const models = await llm.listModels(active.provider)
    lines.push('', `models on ${active.provider}:`)
    for (const model of models) {
      const mark = model.id === active.model ? '*' : ' '
      lines.push(`  ${mark} ${model.id}  ${model.name}`)
    }
  } catch {
    // A catalog is advisory and may reach the network; failing to list it must
    // not hide the live route or block a switch.
    lines.push('', `(could not list models for ${active.provider})`)
  }
  return lines.join('\n')
}

/**
 * Register `/model` on the shared command registry.
 * @param ctx - plugin context carrying the command registry and the LLM service.
 * @param deps - the live selection this command reports and mutates.
 */
export function registerModelCommand(ctx: Context, deps: ModelCommandDeps): void {
  const commands = ctx.get('commands')
  if (commands === undefined) {
    throw new Error('tui-client: the commands service must be composed to register /model')
  }
  commands.register({
    name: 'model',
    description: 'Show the live model route, or switch it for the next turn.',
    input: { hint: '[provider/]model' },
    handler: async (invocation): Promise<CommandResult> => {
      const active = deps.selection.current ?? deps.fallback
      const requested = parseModelArgument(invocation.rawInput)
      if (requested.provider === undefined && requested.model === undefined) {
        return { kind: 'success', text: await describeRoute(ctx, active) }
      }
      const providers = ctx.get('llm')?.listProviders() ?? []
      const resolved = resolveRequestedSelection(providers.map(entry => entry.id), active, requested)
      if ('error' in resolved) return { kind: 'error', text: resolved.error }
      deps.selection.current = resolved.selection
      return {
        kind: 'success',
        text: `model: ${resolved.selection.provider}/${resolved.selection.model} (from the next turn)`,
      }
    },
  })
}
