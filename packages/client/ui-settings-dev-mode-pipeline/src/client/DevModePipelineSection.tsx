/**
 * Development Mode settings section: tabs around the Models panel (per-role
 * provider/model pickers) and the Prompts panel (per-component baseline
 * prompt plus editable extra context). Both panels derive from one
 * {@link DevModePipelineSettingsStore} bound to the pipeline's settings
 * namespace, joined with the host-scoped model catalog for the Models panel.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import {
  DEV_MODE_BASELINE_PROMPTS, DEV_MODE_COMPONENTS, DEV_MODE_ROLES,
} from '../pipeline-copy.ts'
import type { DevModeComponent, DevModeRole, DevModeRoleSection } from '../pipeline-copy.ts'
import type { DevModePipelineSettingsKey } from './locales.ts'
import type { DevModePipelineSettingsState, DevModePipelineSettingsStore } from './store.ts'
import css from './DevModePipelineSection.module.css'

/** Bound translate for this plugin's dictionary namespace. */
type Translate = (key: DevModePipelineSettingsKey, params?: Record<string, string>) => string

/** Injected dependencies of {@link DevModePipelineSection} (slot `inject`). */
export interface DevModePipelineSectionInjected {
  /** The page store (loaded on mount, refreshed on pushed invalidations). */
  controller: DevModePipelineSettingsStore
  hooks: {
    /** Page snapshot bound by the UI renderer as useSnapshot. */
    snapshot: DevModePipelineSettingsStore['store']
  }
  /** Section copy. */
  t: Translate
}

/** Props delivered by the slot outlet: the `hooks` compartment arrives bound as `useSnapshot`. */
export type DevModePipelineSectionProps =
  Omit<DevModePipelineSectionInjected, 'hooks'> & { useSnapshot: SnapshotSelectorHook<DevModePipelineSettingsState> }

const ROLE_LABEL_KEY: Record<DevModeRole, DevModePipelineSettingsKey> = {
  planReview: 'roleLabelPlanReview',
  implement: 'roleLabelImplement',
  codeReview: 'roleLabelCodeReview',
}

const COMPONENT_LABEL_KEY: Record<DevModeComponent, DevModePipelineSettingsKey> = {
  planner: 'componentLabelPlanner',
  planReview: 'componentLabelPlanReview',
  implement: 'componentLabelImplement',
  codeReview: 'componentLabelCodeReview',
}

type Tab = 'models' | 'prompts'

/**
 * Render the Development Mode settings page.
 * @param props - injected controller/snapshot plus the bound locale seat.
 * @returns the tabbed section.
 */
export function DevModePipelineSection({ controller, useSnapshot, t }: DevModePipelineSectionProps) {
  const [tab, setTab] = useState<Tab>('models')
  const tabsId = useId()
  const state = useSnapshot(snapshot => snapshot)

  useEffect(() => { void controller.load() }, [controller])

  return (
    <div className={css.section}>
      <h2 className={css.heading}>{t('title')}</h2>
      <p className={css.intro}>{t('intro')}</p>
      <div id={`${tabsId}-tabs`} className={css.tabs} role="tablist" aria-label={t('tabs')}>
        <button
          type="button"
          role="tab"
          className={css.tab}
          aria-selected={tab === 'models'}
          data-active={tab === 'models' ? 'true' : undefined}
          onClick={() => { setTab('models') }}
        >
          {t('tabModels')}
        </button>
        <button
          type="button"
          role="tab"
          className={css.tab}
          aria-selected={tab === 'prompts'}
          data-active={tab === 'prompts' ? 'true' : undefined}
          onClick={() => { setTab('prompts') }}
        >
          {t('tabPrompts')}
        </button>
      </div>
      <div className={css.panel} role="tabpanel">
        {tab === 'models'
          ? <ModelsPanel controller={controller} state={state} t={t} />
          : <PromptsPanel controller={controller} state={state} t={t} />}
      </div>
    </div>
  )
}

interface PanelProps {
  controller: DevModePipelineSettingsStore
  state: DevModePipelineSettingsState
  t: Translate
}

/** The Models tab: one provider/model picker per spawnable role. */
function ModelsPanel({ controller, state, t }: PanelProps) {
  if (state.status === 'loading' && state.groups.length === 0) {
    return <p className={css.status}>{t('loadingModels')}</p>
  }
  return (
    <>
      <p className={css.intro}>{t('modelsIntro')}</p>
      {!state.writable && <p className={css.error}>{t('readOnly')}</p>}
      {state.status === 'error' && state.error !== null && (
        <div>
          <p className={css.error}>{t('loadFailed', { message: state.error })}</p>
          <button type="button" className={css.tab} onClick={() => { void controller.load() }}>{t('retry')}</button>
        </div>
      )}
      {DEV_MODE_ROLES.map(role => (
        <RoleRow key={role} role={role} controller={controller} state={state} t={t} />
      ))}
    </>
  )
}

interface RoleRowProps {
  role: DevModeRole
  controller: DevModePipelineSettingsStore
  state: DevModePipelineSettingsState
  t: Translate
}

/** One role's provider/model picker row, with its own save status. */
function RoleRow({ role, controller, state, t }: RoleRowProps) {
  const stored = state.section?.[role]
  const [draft, setDraft] = useState<DevModeRoleSection>(stored ?? { provider: '', model: '' })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastStored = useRef(stored)

  // Follow a fresh Host section (another tab's save, or the initial load)
  // unless the row has an unsaved local draft in flight.
  useEffect(() => {
    if (stored !== undefined && stored !== lastStored.current && !saving) {
      setDraft(stored)
    }
    lastStored.current = stored
  }, [stored, saving])

  const modelsForProvider = useMemo(
    () => state.groups.find(group => group.id === draft.provider)?.models ?? [],
    [state.groups, draft.provider],
  )

  const save = (next: DevModeRoleSection): void => {
    setDraft(next)
    setSaving(true)
    setSaved(false)
    setError(null)
    controller.saveModel(role, next).then(() => {
      setSaved(true)
    }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err))
    }).finally(() => {
      setSaving(false)
    })
  }

  return (
    <div className={css.row}>
      <span className={css.rowLabel}>{t(ROLE_LABEL_KEY[role])}</span>
      <div className={css.controls}>
        <select
          className={css.select}
          aria-label={t('provider')}
          value={draft.provider}
          disabled={!state.writable}
          onChange={(event) => { save({ provider: event.target.value, model: '' }) }}
        >
          <option value="">{t('sessionDefault')}</option>
          {state.groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
        </select>
        <select
          className={css.select}
          aria-label={t('model')}
          value={draft.model}
          disabled={!state.writable || draft.provider === ''}
          onChange={(event) => { save({ provider: draft.provider, model: event.target.value }) }}
        >
          <option value="" />
          {modelsForProvider.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select>
      </div>
      <div className={css.footer}>
        {saving && <span className={css.status}>{t('saving')}</span>}
        {!saving && saved && <span className={css.saved}>{t('saved')}</span>}
        {error !== null && <span className={css.error}>{t('saveFailed', { message: error })}</span>}
      </div>
    </div>
  )
}

/** The Prompts tab: one baseline-prompt/extra-context editor per component. */
function PromptsPanel({ controller, state, t }: PanelProps) {
  return (
    <>
      <p className={css.intro}>{t('promptsIntro')}</p>
      {!state.writable && <p className={css.error}>{t('readOnly')}</p>}
      {DEV_MODE_COMPONENTS.map(component => (
        <ComponentRow key={component} component={component} controller={controller} state={state} t={t} />
      ))}
    </>
  )
}

interface ComponentRowProps {
  component: DevModeComponent
  controller: DevModePipelineSettingsStore
  state: DevModePipelineSettingsState
  t: Translate
}

/** One component's baseline prompt (read-only) and editable extra-context field. */
function ComponentRow({ component, controller, state, t }: ComponentRowProps) {
  const stored = state.section?.context[component] ?? ''
  const [draft, setDraft] = useState(stored)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastStored = useRef(stored)

  useEffect(() => {
    if (stored !== lastStored.current && !saving) setDraft(stored)
    lastStored.current = stored
  }, [stored, saving])

  const save = (): void => {
    setSaving(true)
    setSaved(false)
    setError(null)
    controller.saveContext(component, draft).then(() => {
      setSaved(true)
    }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err))
    }).finally(() => {
      setSaving(false)
    })
  }

  return (
    <div className={css.row}>
      <span className={css.rowLabel}>{t(COMPONENT_LABEL_KEY[component])}</span>
      <span className={css.hint}>{t('baselineLabel')}</span>
      <p className={css.baseline}>{DEV_MODE_BASELINE_PROMPTS[component]}</p>
      <span className={css.hint}>{t('contextLabel')}</span>
      <textarea
        className={css.textarea}
        value={draft}
        placeholder={t('contextPlaceholder')}
        disabled={!state.writable}
        onChange={(event) => { setDraft(event.target.value) }}
        onBlur={() => { if (draft !== stored) save() }}
      />
      <div className={css.footer}>
        {saving && <span className={css.status}>{t('saving')}</span>}
        {!saving && saved && <span className={css.saved}>{t('saved')}</span>}
        {error !== null && <span className={css.error}>{t('saveFailed', { message: error })}</span>}
      </div>
    </div>
  )
}
