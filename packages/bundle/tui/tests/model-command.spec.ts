/**
 * The `/model` command over the real command runtime: argument parsing, the
 * shared provider validator, list mode against a stub LLM service, and the
 * live-selection mutation that switches the route for the next turn.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Agent, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { registerTuiCommands } from '../src/client/commands.ts'
import {
  parseModelArgument,
  registerModelCommand,
  resolveRequestedSelection,
} from '../src/client/model-command.ts'

/** The starting route used across these tests. */
const BASE: ModelSelection = { provider: 'deepseek', model: 'deepseek-chat' }

/** Mount the real session store and command runtime and mint one agent/session. */
async function mounted(): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  const session = ctx.sessions.create(SessionId('sess'))
  const agent = { id: session.id, session } as Agent
  await ctx.plugin(Object.assign((inner: Context) => { createScope(inner, agent) }, { inject: ['commands'] }))
  return { ctx, agent }
}

/**
 * Provide a stub `llm` service exposing only the two discovery methods the
 * command reads, so these tests do not need a real provider adapter.
 */
function provideLlm(
  ctx: Context,
  providers: readonly { id: string; name: string }[],
  listModels: (provider: string) => Promise<{ provider: string; id: string; name: string }[]>,
): void {
  ctx.provide('llm', {
    listProviders: () => providers.map(entry => ({ ...entry })),
    listModels,
  } as unknown as Context['llm'])
}

/** Run one `/model` invocation and return its text. */
async function run(ctx: Context, agent: Agent, line: string): Promise<string> {
  const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
  return execution?.result.text ?? ''
}

describe('parseModelArgument', () => {
  it('reads empty and whitespace-only input as no request', () => {
    expect(parseModelArgument('')).toEqual({})
    expect(parseModelArgument('   ')).toEqual({})
  })

  it('reads a bare token as a model on the current provider', () => {
    expect(parseModelArgument(' deepseek-reasoner ')).toEqual({ model: 'deepseek-reasoner' })
  })

  it('splits a provider from the model on the first slash', () => {
    expect(parseModelArgument(' pi-ai/some-model ')).toEqual({ provider: 'pi-ai', model: 'some-model' })
  })

  it('keeps later slashes in the model id', () => {
    expect(parseModelArgument('pi-ai/org/model-v2')).toEqual({ provider: 'pi-ai', model: 'org/model-v2' })
  })

  it('drops an empty side of the separator', () => {
    expect(parseModelArgument('/model-only')).toEqual({ model: 'model-only' })
    expect(parseModelArgument('provider-only/')).toEqual({ provider: 'provider-only' })
  })
})

describe('resolveRequestedSelection', () => {
  it('returns the base selection when nothing is requested', () => {
    expect(resolveRequestedSelection(['deepseek'], BASE, {})).toEqual({ selection: BASE })
  })

  it('overrides only the model', () => {
    expect(resolveRequestedSelection(['deepseek'], BASE, { model: 'other' })).toEqual({
      selection: { provider: 'deepseek', model: 'other' },
    })
  })

  it('overrides only the provider, keeping the model', () => {
    expect(resolveRequestedSelection(['deepseek', 'pi-ai'], BASE, { provider: 'pi-ai' })).toEqual({
      selection: { provider: 'pi-ai', model: 'deepseek-chat' },
    })
  })

  it('overrides both fields together', () => {
    expect(resolveRequestedSelection(['deepseek', 'pi-ai'], BASE, { provider: 'pi-ai', model: 'x' })).toEqual({
      selection: { provider: 'pi-ai', model: 'x' },
    })
  })

  it('preserves an inherited reasoning effort across a switch', () => {
    const base = { ...BASE, reasoningEffort: 'high' } as ModelSelection
    const resolved = resolveRequestedSelection(['deepseek'], base, { model: 'other' })
    expect(resolved).toEqual({ selection: { ...base, model: 'other' } })
  })

  it('rejects an unregistered provider and names the valid ones', () => {
    expect(resolveRequestedSelection(['deepseek', 'pi-ai'], BASE, { provider: 'nope' })).toEqual({
      error: 'unknown provider "nope"; registered providers: deepseek, pi-ai',
    })
  })

  it('reports an empty registry rather than an empty list', () => {
    expect(resolveRequestedSelection([], BASE, { provider: 'nope' })).toEqual({
      error: 'unknown provider "nope"; registered providers: (none registered)',
    })
  })

  it('accepts an uncatalogued model id, because a catalog is advisory', () => {
    expect(resolveRequestedSelection(['deepseek'], BASE, { model: 'not-in-any-catalog' })).toEqual({
      selection: { provider: 'deepseek', model: 'not-in-any-catalog' },
    })
  })
})

describe('registerModelCommand', () => {
  it('throws on a composition without the commands service', () => {
    expect(() => {
      registerModelCommand(new Context(), { selection: { current: BASE, assembled: undefined }, fallback: BASE })
    }).toThrow('the commands service must be composed')
  })

  it('lists the live route, providers, and that provider\'s models', async () => {
    const { ctx, agent } = await mounted()
    provideLlm(ctx, [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'pi-ai', name: 'Pi' }], async provider => [
      { provider, id: 'deepseek-chat', name: 'Chat' },
      { provider, id: 'deepseek-reasoner', name: 'Reasoner' },
    ])
    registerModelCommand(ctx, { selection: { current: BASE, assembled: undefined }, fallback: BASE })
    const text = await run(ctx, agent, '/model')
    expect(text).toContain('model: deepseek/deepseek-chat')
    expect(text).toContain('* deepseek  DeepSeek')
    expect(text).toContain('  pi-ai  Pi')
    expect(text).toContain('* deepseek-chat  Chat')
    expect(text).toContain('  deepseek-reasoner  Reasoner')
  })

  it('degrades to the route and providers when the catalog cannot be listed', async () => {
    const { ctx, agent } = await mounted()
    provideLlm(ctx, [{ id: 'deepseek', name: 'DeepSeek' }], async () => {
      throw new Error('network down')
    })
    registerModelCommand(ctx, { selection: { current: BASE, assembled: undefined }, fallback: BASE })
    const text = await run(ctx, agent, '/model')
    expect(text).toContain('model: deepseek/deepseek-chat')
    expect(text).toContain('could not list models for deepseek')
  })

  it('reports the route without discovery when the llm service is absent', async () => {
    const { ctx, agent } = await mounted()
    registerModelCommand(ctx, { selection: { current: BASE, assembled: undefined }, fallback: BASE })
    const text = await run(ctx, agent, '/model')
    expect(text).toContain('model: deepseek/deepseek-chat')
    expect(text).toContain('model discovery is unavailable')
  })

  it('falls back to the starting route before any switch has been recorded', async () => {
    const { ctx, agent } = await mounted()
    registerModelCommand(ctx, { selection: { current: undefined, assembled: undefined }, fallback: BASE })
    expect(await run(ctx, agent, '/model')).toContain('model: deepseek/deepseek-chat')
  })

  it('switches the model on the live selection for the next turn', async () => {
    const { ctx, agent } = await mounted()
    provideLlm(ctx, [{ id: 'deepseek', name: 'DeepSeek' }], async () => [])
    const selection: ModelSelectionRef = { current: BASE, assembled: undefined }
    registerModelCommand(ctx, { selection, fallback: BASE })
    const text = await run(ctx, agent, '/model deepseek-reasoner')
    expect(text).toBe('model: deepseek/deepseek-reasoner (from the next turn)')
    expect(selection.current).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
  })

  it('switches provider and model together', async () => {
    const { ctx, agent } = await mounted()
    provideLlm(ctx, [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'pi-ai', name: 'Pi' }], async () => [])
    const selection: ModelSelectionRef = { current: BASE, assembled: undefined }
    registerModelCommand(ctx, { selection, fallback: BASE })
    await run(ctx, agent, '/model pi-ai/some-model')
    expect(selection.current).toEqual({ provider: 'pi-ai', model: 'some-model' })
  })

  it('rejects an unknown provider and leaves the selection unchanged', async () => {
    const { ctx, agent } = await mounted()
    provideLlm(ctx, [{ id: 'deepseek', name: 'DeepSeek' }], async () => [])
    const selection: ModelSelectionRef = { current: BASE, assembled: undefined }
    registerModelCommand(ctx, { selection, fallback: BASE })
    const execution = await ctx.commands.execute(agent, '/model nope/x', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('error')
    expect(execution?.result.text).toContain('unknown provider "nope"')
    expect(selection.current).toEqual(BASE)
  })

  it('rejects a switch when no provider is registered to validate against', async () => {
    const { ctx, agent } = await mounted()
    const selection: ModelSelectionRef = { current: BASE, assembled: undefined }
    registerModelCommand(ctx, { selection, fallback: BASE })
    const execution = await ctx.commands.execute(agent, '/model pi-ai/x', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('error')
    expect(selection.current).toEqual(BASE)
  })

  it('is discoverable through /help with its argument hint', async () => {
    const { ctx, agent } = await mounted()
    registerTuiCommands(ctx, {
      exit: () => {},
      isTTY: false,
      stdout: { write: () => true },
    })
    registerModelCommand(ctx, { selection: { current: BASE, assembled: undefined }, fallback: BASE })
    const text = await run(ctx, agent, '/help')
    expect(text).toContain('/model <[provider/]model>  Show the live model route, or switch it for the next turn.')
  })

  it('switches the model with no llm service, since only providers are validated', async () => {
    const { ctx, agent } = await mounted()
    const selection: ModelSelectionRef = { current: BASE, assembled: undefined }
    registerModelCommand(ctx, { selection, fallback: BASE })
    await run(ctx, agent, '/model bare-model')
    expect(selection.current).toEqual({ provider: 'deepseek', model: 'bare-model' })
  })
})
