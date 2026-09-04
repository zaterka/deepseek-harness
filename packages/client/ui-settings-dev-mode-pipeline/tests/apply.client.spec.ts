/**
 * Development Mode settings section registration: slot declaration
 * injection, the locale-following label thunk, and pushed invalidations.
 * Mirrors `ui-settings-models`'s `apply.client.spec.ts` template.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-settings-dev-mode-pipeline/client'
import { DevModePipelineSection } from '../src/client/DevModePipelineSection.tsx'
import type { DevModePipelineSectionInjected } from '../src/client/DevModePipelineSection.tsx'

// These specs assert the shipped Chinese copy. The lane has no jsdom `window`,
// so browser-language detection never runs and a fresh LocaleRuntime opens on
// FALLBACK_LOCALE (en); bench stages zh explicitly on the locale instead.

async function bench(services: { llm?: object; settings?: object } = {}) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  new TestRemote(ctx)
  ctx.provide('connection', {
    api: {
      llm: services.llm ?? { models: () => Promise.resolve({ rpcId: 'bench-models', result: { ok: true, value: { groups: [], failures: [] } } }) },
      ...services.settings === undefined ? {} : { settings: services.settings },
    },
    isLoopback: true,
  } as never)
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register(
    {
      name: 'root',
      children: {
        'settings.section': { kind: 'list', scope: 'root' },
      },
    } as never,
    () => null,
  )
}

describe('ui-settings-dev-mode-pipeline apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'remote', 'settingsScope'])
  })

  it('registers the Development Mode nav entry for declarations before or after apply', async () => {
    const before = await bench()
    declare(before.slots)
    await before.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = before.slots.entries('settings.section')[0]!
    expect(entry.component).toBe(DevModePipelineSection)
    expect(entry.options).toMatchObject({ id: 'dev-mode-pipeline', order: 90 })
    // The nav label is a locale-following thunk; owners resolve at read time.
    expect(resolveSlotLabel(entry.options.label)).toBe('开发模式')
    const injected = (entry.inject as unknown as () => DevModePipelineSectionInjected)()
    expect(injected.t('nav')).toBe('开发模式')
    expect(typeof injected.controller.load).toBe('function')
    expect(injected.hooks.snapshot).toBe(injected.controller.store)

    const after = await bench()
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    expect(after.slots.entries('settings.section')).toHaveLength(0)
    declare(after.slots)
    await Promise.resolve()
    expect(after.slots.entries('settings.section')[0]!.component).toBe(DevModePipelineSection)
  })

  it('the label thunk follows the active locale without re-registration', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    b.locale.setLocale('en')
    expect(resolveSlotLabel(b.slots.entries('settings.section')[0]!.options.label)).toBe('Development Mode')
    const injected = b.slots.entries('settings.section')[0]!.inject as unknown as () => DevModePipelineSectionInjected
    expect(injected().t('tabPrompts')).toBe('Prompts')
    b.locale.setLocale('zh')
    expect(resolveSlotLabel(b.slots.entries('settings.section')[0]!.options.label)).toBe('开发模式')
    expect(injected().t('tabPrompts')).toBe('提示词')
  })

  it('re-registers after an HMR collapse re-declares the slot (stale disposer must not block)', async () => {
    const b = await bench()
    const redeclare = declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.slots.entries('settings.section')).toHaveLength(1)
    redeclare()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    declare(b.slots)
    await Promise.resolve()
    expect(b.slots.entries('settings.section')[0]!.component).toBe(DevModePipelineSection)
  })

  it('registers the zh/en nav dictionaries and disposes everything with the fiber', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.locale.bind('settings.dev-mode-pipeline')('nav')).toBe('开发模式')
    await fiber.dispose()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    // The (ns, locale) seats are free again — the dictionary disposers ran.
    expect(() => b.locale.register('settings.dev-mode-pipeline', 'zh', {})).not.toThrow()
    expect(() => b.locale.register('settings.dev-mode-pipeline', 'en', {})).not.toThrow()
  })
})

describe('pushed invalidations', () => {
  it('ignores invalidations before the page ever loaded', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    b.ctx.remote.$dispatch('settings/document-updated', ['dev-mode-pipeline', 1])
    b.ctx.remote.$dispatch('llm/adapters-updated', [])
    b.ctx.emit('connection/reset')
  })

  it('refreshes a loaded page on a settings invalidation', async () => {
    const models = vi.fn(() => Promise.resolve({
      rpcId: 'apply-dev-mode-models' as never,
      result: { ok: true as const, value: { groups: [], failures: [] } },
    }))
    const b = await bench({ llm: { models } })
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('settings.section')[0]!
    const injected = (entry.inject as unknown as () => DevModePipelineSectionInjected)()
    await injected.controller.load()
    expect(models).toHaveBeenCalledTimes(1)

    b.ctx.remote.$dispatch('settings/document-updated', ['dev-mode-pipeline', 1])
    expect(models).toHaveBeenCalledTimes(2)
  })
})
