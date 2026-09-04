/**
 * Development Mode settings plugin, browser half. It registers the
 * `settings.section` page (id `dev-mode-pipeline`) with its Models and
 * Prompts tabs, binds the pipeline's settings namespace through the shared
 * settings scope, and keeps the store fresh on pushed invalidations exactly
 * as `ui-settings-models` does for its own section.
 * Export discipline: packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.remote merge and the forwarded-event key face
// (settings invalidations ride the allowlist) into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { DevModePipelineSection } from './DevModePipelineSection.tsx'
import type { DevModePipelineSectionInjected } from './DevModePipelineSection.tsx'
import { DevModePipelineSettingsStore } from './store.ts'
import { decodeDevModePipelineSection, DEV_MODE_PIPELINE_SETTINGS_NAMESPACE } from '../pipeline-copy.ts'
import { en, zh, type DevModePipelineSettingsKey } from './locales.ts'

export type { DevModePipelineSectionInjected, DevModePipelineSectionProps } from './DevModePipelineSection.tsx'
export type { DevModePipelineSettingsKey } from './locales.ts'
export type { DevModePipelineSettingsState } from './store.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Development Mode settings page copy. */
    'settings.dev-mode-pipeline': DevModePipelineSettingsKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.dev-mode-pipeline'

/**
 * Refetch the model catalog only after its first load: an unopened page must
 * not fetch on background invalidations.
 * @param controller - the page store.
 */
function refreshIfLoaded(controller: DevModePipelineSettingsStore): void {
  if (controller.store.getSnapshot().status === 'idle') return
  void controller.load()
}

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * ui-settings' apply, whose activation order relative to this one is NOT
 * constrained; registration depends on the slot through `slots.inject()`.
 */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/**
 * Register the Development Mode section once the `settings.section`
 * declaration is on the ledger, bind its settings scope, and keep the model
 * catalog fresh on every pushed invalidation.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-dev-mode-pipeline: copy dictionaries')

  const connection = ctx.get('connection') as ConnectionHandle
  const scope = ctx.settingsScope.bind({
    namespace: DEV_MODE_PIPELINE_SETTINGS_NAMESPACE,
    decode: decodeDevModePipelineSection,
  })
  const controller = new DevModePipelineSettingsStore(connection.api.llm, scope)
  // Registration-time text (the nav label thunk) shares one bound translate
  // with the inject face; copy freshness rides the locale revision.
  const t = ctx.locale.bind(NS) as DevModePipelineSectionInjected['t']
  const injected = (): DevModePipelineSectionInjected => ({
    controller,
    hooks: { snapshot: controller.store },
    t,
  })

  ctx.effect(() => {
    const refresh = (): void => { refreshIfLoaded(controller) }
    const disposers = [
      ctx.remote.$on('settings/document-updated', refresh),
      ctx.remote.$on('llm/adapters-updated', refresh),
      ctx.on('connection/reset', refresh),
    ]
    return () => {
      controller.dispose()
      for (const dispose of disposers) dispose()
    }
  }, 'ui-settings-dev-mode-pipeline: pushed invalidations')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dev-mode-pipeline',
    order: 90,
    label: () => t('nav'),
    inject: injected,
  }, DevModePipelineSection))
}
