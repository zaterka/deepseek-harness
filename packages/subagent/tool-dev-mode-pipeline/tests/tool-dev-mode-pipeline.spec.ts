/**
 * Drives the REAL plugin body of `dsh-tool-dev-mode-pipeline`: mounts it on
 * a real `ToolRuntime` + `SubagentRuntime` + `DevModePipelineConfig`, with a
 * package-local scripted child boundary, and invokes each registered tool
 * through `ctx.tools.execute`. Everything downstream of the child boundary
 * is the shipping code path.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import DevModePipelineConfig from '@deepseek-ai/dsh-dev-mode-pipeline'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import * as mock from './scripted-provider.ts'
import * as tool from '../src/index.ts'

const testToolSignal = new AbortController().signal

/** The smallest real settings provider: one in-memory document, always writable. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

/** A minimal parent Agent passed through to the provider request. */
function fakeAgent(id = 'parent-1'): Agent {
  return { id: SessionId(id) } as unknown as Agent
}

async function setup(toolConfig: tool.Config, mockConfig: Partial<mock.Config> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemorySettings)
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  await ctx.plugin(DevModePipelineConfig)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SubagentRuntime)
  await mock.mountScriptedProvider(ctx, { name: 'spawn', ...mockConfig })
  await ctx.plugin(tool, toolConfig)
  return ctx
}

/** Setup without a mounted `agentDefaultModel` service, so an unconfigured role resolves to an empty selection. */
async function setupWithoutDefaultModel(toolConfig: tool.Config, mockConfig: Partial<mock.Config> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemorySettings)
  await ctx.plugin(DevModePipelineConfig)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SubagentRuntime)
  await mock.mountScriptedProvider(ctx, { name: 'spawn', ...mockConfig })
  await ctx.plugin(tool, toolConfig)
  return ctx
}

let callCounter = 0
function callTool(ctx: Context, name: string, args: unknown, over: { agent?: Agent | undefined } = {}) {
  const agent = 'agent' in over ? over.agent : fakeAgent()
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${++callCounter}`),
    name,
    arguments: args,
    ...agent ? { agent } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe('dsh-tool-dev-mode-pipeline', () => {
  describe('devagent_get_model', () => {
    it('resolves an unconfigured role to the session default model', async () => {
      const ctx = await setup({ provider: 'spawn' })
      const result = await callTool(ctx, 'devagent_get_model', { role: 'planReview' })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(result.value).toEqual({
        provider: 'deepseek-official', model: 'deepseek-v4-flash', fromSessionDefault: true,
      })
    })

    it('resolves a configured role to its stored model', async () => {
      const ctx = await setup({ provider: 'spawn' })
      await ctx.devModePipeline.saveModel('codeReview', { provider: 'acme-gateway', model: 'acme-large' })
      const result = await callTool(ctx, 'devagent_get_model', { role: 'codeReview' })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(result.value).toEqual({
        provider: 'acme-gateway', model: 'acme-large', fromSessionDefault: false,
      })
    })

    it('rejects an unknown role', async () => {
      const ctx = await setup({ provider: 'spawn' })
      const result = await callTool(ctx, 'devagent_get_model', { role: 'planner' })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected a soft error value, not a pipeline failure')
      expect(result.value).toEqual({ error: 'role must be one of planReview | implement | codeReview' })
    })
  })

  describe('devagent_get_context', () => {
    it('reads an unconfigured component as empty context', async () => {
      const ctx = await setup({ provider: 'spawn' })
      const result = await callTool(ctx, 'devagent_get_context', { component: 'planner' })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(result.value).toEqual({ component: 'planner', context: '' })
    })

    it('reads a configured component context', async () => {
      const ctx = await setup({ provider: 'spawn' })
      await ctx.devModePipeline.saveContext('planner', 'Always check the CHANGELOG first.')
      const result = await callTool(ctx, 'devagent_get_context', { component: 'planner' })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(result.value).toEqual({ component: 'planner', context: 'Always check the CHANGELOG first.' })
    })

    it('rejects an unknown component', async () => {
      const ctx = await setup({ provider: 'spawn' })
      const result = await callTool(ctx, 'devagent_get_context', { component: 'nope' })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected a soft error value, not a pipeline failure')
      expect(result.value).toEqual({ error: 'component must be one of planner | planReview | implement | codeReview' })
    })
  })

  describe('devagent_spawn', () => {
    it('spawns the role on the session default model when unconfigured', async () => {
      const ctx = await setup({ provider: 'spawn' }, { reply: 'plan looks solid' })
      const result = await callTool(ctx, 'devagent_spawn', { role: 'planReview', prompt: 'review PLAN.md' })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(result.value).toEqual({
        ok: true,
        role: 'planReview',
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        fromSessionDefault: true,
        stopReason: 'completed',
        text: 'plan looks solid',
      })
      expect(text(result)).toContain('plan looks solid')
    })

    it('spawns the role on its configured model when set', async () => {
      const ctx = await setup({ provider: 'spawn' }, { reply: 'done' })
      await ctx.devModePipeline.saveModel('implement', { provider: 'acme-gateway', model: 'acme-large' })
      const result = await callTool(ctx, 'devagent_spawn', { role: 'implement', prompt: 'implement part 1' })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(result.value).toMatchObject({
        ok: true, role: 'implement', provider: 'acme-gateway', model: 'acme-large', fromSessionDefault: false,
      })
    })

    it('prepends the configured extra context to the subagent prompt', async () => {
      let captured: SubagentStartRequest | undefined
      const ctx = await setup({ provider: 'spawn' }, { onStart: (request) => { captured = request } })
      await ctx.devModePipeline.saveContext('codeReview', 'Pay extra attention to test coverage.')
      await callTool(ctx, 'devagent_spawn', { role: 'codeReview', prompt: 'review the diff' })
      const promptText = captured?.prompt.find(b => b.type === 'text')
      expect(promptText).toMatchObject({
        type: 'text',
        text: '[Configured Development Mode context for codeReview]\nPay extra attention to test coverage.\n\nreview the diff',
      })
    })

    it('sends the plain prompt when no extra context is configured', async () => {
      let captured: SubagentStartRequest | undefined
      const ctx = await setup({ provider: 'spawn' }, { onStart: (request) => { captured = request } })
      await callTool(ctx, 'devagent_spawn', { role: 'implement', prompt: 'implement part 1' })
      expect(captured?.prompt).toEqual([{ type: 'text', text: 'implement part 1' }])
    })

    it('reports a non-completed stop reason without failing the tool call', async () => {
      const ctx = await setup(
        { provider: 'spawn' },
        { stopReason: 'error', diagnostic: 'scripted child transport failure' },
      )
      const result = await callTool(ctx, 'devagent_spawn', { role: 'planReview', prompt: 'review PLAN.md' })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(result.value).toMatchObject({
        ok: false, role: 'planReview', stopReason: 'error', error: 'scripted child transport failure',
      })
    })

    it('uses an explicit label when provided instead of the default devagent-<role> label', async () => {
      let captured: SubagentStartRequest | undefined
      const ctx = await setup({ provider: 'spawn' }, { onStart: (request) => { captured = request } })
      await callTool(ctx, 'devagent_spawn', { role: 'implement', prompt: 'implement part 1', label: 'custom label' })
      expect(captured?.label).toBe('custom label')
    })

    it('omits agentOptions when no default model service is mounted and the role is unconfigured', async () => {
      let captured: SubagentStartRequest | undefined
      const ctx = await setupWithoutDefaultModel({ provider: 'spawn' }, { onStart: (request) => { captured = request } })
      const result = await callTool(ctx, 'devagent_spawn', { role: 'implement', prompt: 'implement part 1' })
      expect(captured?.agentOptions).toBeUndefined()
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(result.value).toMatchObject({ ok: true, provider: '', model: '' })
    })

    it('reports a run.result rejection as a failed call', async () => {
      const ctx = await setup({ provider: 'spawn' }, { resultRejection: new Error('child crashed') })
      const result = await callTool(ctx, 'devagent_spawn', { role: 'planReview', prompt: 'review PLAN.md' })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected a soft error value, not a pipeline failure')
      expect(result.value).toMatchObject({ ok: false, role: 'planReview', error: 'Error: child crashed' })
    })

    it('reports a run.dispose rejection when result settles successfully', async () => {
      const ctx = await setup({ provider: 'spawn' }, { disposeRejection: new Error('dispose failed') })
      const result = await callTool(ctx, 'devagent_spawn', { role: 'planReview', prompt: 'review PLAN.md' })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected a soft error value, not a pipeline failure')
      expect(result.value).toMatchObject({ ok: false, role: 'planReview', error: 'Error: dispose failed' })
    })

    it('combines a run.result rejection and a run.dispose rejection into one detail', async () => {
      const ctx = await setup(
        { provider: 'spawn' },
        { resultRejection: new Error('child crashed'), disposeRejection: new Error('dispose failed') },
      )
      const result = await callTool(ctx, 'devagent_spawn', { role: 'planReview', prompt: 'review PLAN.md' })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected a soft error value, not a pipeline failure')
      expect(result.value).toMatchObject({
        ok: false, role: 'planReview', error: 'Error: child crashed; dispose failed: Error: dispose failed',
      })
    })

    it('reports a start() throw (Error) as a failed call', async () => {
      const ctx = await setup({ provider: 'spawn' }, { startRejection: new Error('provider rejected start') })
      const result = await callTool(ctx, 'devagent_spawn', { role: 'planReview', prompt: 'review PLAN.md' })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected a soft error value, not a pipeline failure')
      expect(result.value).toMatchObject({ ok: false, role: 'planReview', error: 'provider rejected start' })
    })

    it('reports a start() throw (non-Error) as a failed call', async () => {
      const ctx = await setup({ provider: 'spawn' }, { startRejection: 'plain rejection string' })
      const result = await callTool(ctx, 'devagent_spawn', { role: 'planReview', prompt: 'review PLAN.md' })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected a soft error value, not a pipeline failure')
      expect(result.value).toMatchObject({ ok: false, role: 'planReview', error: 'plain rejection string' })
    })

    it('rejects an unknown role', async () => {
      const ctx = await setup({ provider: 'spawn' })
      const result = await callTool(ctx, 'devagent_spawn', { role: 'planner', prompt: 'plan it' })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected a soft error value, not a pipeline failure')
      expect(result.value).toEqual({ ok: false, error: 'role must be one of planReview | implement | codeReview' })
    })

    it('rejects a call with no calling agent', async () => {
      const ctx = await setup({ provider: 'spawn' })
      const result = await callTool(ctx, 'devagent_spawn', { role: 'planReview', prompt: 'review' }, { agent: undefined })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected a soft error value, not a pipeline failure')
      expect(result.value).toEqual({
        ok: false,
        role: 'planReview',
        error: 'devagent_spawn requires a calling agent (exec.agent was undefined)',
      })
    })
  })
})
