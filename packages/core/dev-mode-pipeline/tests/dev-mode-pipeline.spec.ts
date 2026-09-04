/** Development Mode pipeline settings layered over a real settings provider. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import DevModePipelineConfig, { DEV_MODE_PIPELINE_SETTINGS_NAMESPACE } from '../src/index.ts'

/** The smallest real provider: one in-memory document, always writable. */
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

async function boot(): Promise<{
  ctx: Context
  settingsFiber: Context['fiber']
  pipeline: DevModePipelineConfig
}> {
  const ctx = new Context()
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  await ctx.plugin(DevModePipelineConfig)
  return { ctx, settingsFiber, pipeline: ctx.devModePipeline }
}

describe('DevModePipelineConfig', () => {
  it('defers an unconfigured role to the session default model', async () => {
    const bench = await boot()
    expect(bench.pipeline.modelFor('planReview', bench.ctx.agentDefaultModel)).toEqual({
      provider: 'deepseek-official', model: 'deepseek-v4-flash', fromSessionDefault: true,
    })
    await bench.ctx.fiber.dispose()
  })

  it('resolves an unconfigured role to an empty selection when no default model service is mounted', async () => {
    const bench = await boot()
    expect(bench.pipeline.modelFor('implement', undefined)).toEqual({
      provider: '', model: '', fromSessionDefault: true,
    })
    await bench.ctx.fiber.dispose()
  })

  it('saves and resolves a role-specific model override', async () => {
    const bench = await boot()
    await bench.pipeline.saveModel('codeReview', { provider: 'acme-gateway', model: 'acme-large' })
    expect(bench.pipeline.modelFor('codeReview', bench.ctx.agentDefaultModel)).toEqual({
      provider: 'acme-gateway', model: 'acme-large', fromSessionDefault: false,
    })
    await bench.ctx.fiber.dispose()
  })

  it('reverts to the session default after clearing a role override', async () => {
    const bench = await boot()
    await bench.pipeline.saveModel('implement', { provider: 'acme-gateway', model: 'acme-large' })
    await bench.pipeline.saveModel('implement', { provider: '', model: '' })
    expect(bench.pipeline.modelFor('implement', bench.ctx.agentDefaultModel)).toEqual({
      provider: 'deepseek-official', model: 'deepseek-v4-flash', fromSessionDefault: true,
    })
    await bench.ctx.fiber.dispose()
  })

  it('saves and reads one component context independently of the others', async () => {
    const bench = await boot()
    await bench.pipeline.saveContext('planner', 'Always check the CHANGELOG first.')
    expect(bench.pipeline.contextFor('planner')).toBe('Always check the CHANGELOG first.')
    expect(bench.pipeline.contextFor('implement')).toBe('')

    await bench.pipeline.saveContext('implement', 'Use vitest, not jest.')
    expect(bench.pipeline.contextFor('planner')).toBe('Always check the CHANGELOG first.')
    expect(bench.pipeline.contextFor('implement')).toBe('Use vitest, not jest.')
    await bench.ctx.fiber.dispose()
  })

  it('layers a hand-written partial section over the entry', async () => {
    const bench = await boot()
    await bench.settingsFiber.ctx.settings.replace(DEV_MODE_PIPELINE_SETTINGS_NAMESPACE, {
      planReview: { provider: 'hand-written', model: 'hand-written-model' },
    })
    expect(bench.pipeline.modelFor('planReview', bench.ctx.agentDefaultModel)).toEqual({
      provider: 'hand-written', model: 'hand-written-model', fromSessionDefault: false,
    })
    await bench.ctx.fiber.dispose()
  })

  it('falls back to empty role settings when the settings provider detaches', async () => {
    const bench = await boot()
    await bench.pipeline.saveModel('planReview', { provider: 'acme-gateway', model: 'acme-large' })
    expect(bench.pipeline.modelFor('planReview', bench.ctx.agentDefaultModel).provider).toBe('acme-gateway')
    await bench.settingsFiber.dispose()
    expect(bench.pipeline.modelFor('planReview', bench.ctx.agentDefaultModel)).toEqual({
      provider: 'deepseek-official', model: 'deepseek-v4-flash', fromSessionDefault: true,
    })
    await bench.ctx.fiber.dispose()
  })

  it('keeps the composition entry when no settings provider is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentDefaultModelConfig, { provider: 'p', model: 'm' })
    await ctx.plugin(DevModePipelineConfig)
    await ctx.devModePipeline.saveModel('codeReview', { provider: 'other', model: 'other' })
    expect(ctx.devModePipeline.modelFor('codeReview', ctx.agentDefaultModel)).toEqual({
      provider: 'p', model: 'm', fromSessionDefault: true,
    })
    await ctx.fiber.dispose()
  })
})
