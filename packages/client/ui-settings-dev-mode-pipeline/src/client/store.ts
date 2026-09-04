/**
 * Development Mode settings page store: one snapshot joining the host-scoped
 * model catalog (`llm.models`) with the pipeline's settings namespace (bound
 * through the shared settings scope). The Host stays the single fact source
 * for both; every mutation writes through the scope, and the page re-renders
 * from the next resolved snapshot, pushed or refetched.
 */

import type { IApiClient, ModelCatalogFailure, ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  DEV_MODE_COMPONENTS, DEV_MODE_ROLES,
} from '../pipeline-copy.ts'
import type {
  DevModeComponent, DevModePipelineSection, DevModeRole, DevModeRoleSection,
} from '../pipeline-copy.ts'

/** Page snapshot. */
export interface DevModePipelineSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load failure text (model catalog load); the settings scope carries its own status. */
  error: string | null
  /** Successfully loaded provider groups (last good load). */
  groups: readonly ModelProviderGroup[]
  /** Provider-local catalog failures from the last load; usable groups stay usable. */
  failures: readonly ModelCatalogFailure[]
  /** Whether the settings scope is ready and accepts writes. */
  writable: boolean
  /** The resolved pipeline section, once the settings scope is ready. */
  section: DevModePipelineSection | undefined
}

/**
 * Human text for a rejected wire call. A transport failure rejects with an
 * Error; a host or a runtime can reject with anything, and the page still
 * has to say something.
 * @param error - the rejection value.
 * @returns the message to show.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type LlmFace = Pick<IApiClient['llm'], 'models'>

/**
 * The Development Mode settings page's store: derives from the bound
 * settings scope and independently loads the host-scoped model catalog.
 */
export class DevModePipelineSettingsStore {
  /** Page snapshot both panels render from (uSES-safe store). */
  readonly store: SnapshotStore<DevModePipelineSettingsState> = createSnapshotStore<DevModePipelineSettingsState>({
    status: 'idle', error: null, groups: [], failures: [], writable: false, section: undefined,
  })

  private readonly unsubscribe: () => void

  /**
   * @param llm - the host-scoped model-catalog wire face.
   * @param scope - the bound settings scope for the pipeline namespace.
   */
  constructor(
    private readonly llm: LlmFace,
    private readonly scope: SettingsScope<DevModePipelineSection>,
  ) {
    this.unsubscribe = scope.subscribe(() => { this.deriveFromScope() })
    this.deriveFromScope()
  }

  /** Fetch the host-scoped model catalog; failure preserves the last good groups. */
  async load(): Promise<void> {
    this.store.update((s) => { s.status = 'loading'; s.error = null })
    try {
      const { result } = await this.llm.models({})
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      this.store.update((s) => {
        s.groups = result.value.groups
        s.failures = result.value.failures
        s.status = 'ready'
        s.error = null
      })
    } catch (error) {
      this.store.update((s) => { s.status = 'error'; s.error = messageOf(error) })
    }
  }

  /**
   * Save one role's model selection. Both fields empty clears the override,
   * so the role reverts to the session default at read time.
   * @param role - the pipeline role to update.
   * @param selection - the next provider/model, or empty strings to clear.
   */
  async saveModel(role: DevModeRole, selection: DevModeRoleSection): Promise<void> {
    await this.scope.set(role, selection)
  }

  /**
   * Save one component's extra context.
   * @param component - the pipeline component to update.
   * @param context - the next extra-context text.
   */
  async saveContext(component: DevModeComponent, context: string): Promise<void> {
    const current = this.scope.getSnapshot().value
    const next = { ...current?.context, [component]: context }
    await this.scope.set('context', next)
  }

  /** Release the scope subscription. */
  dispose(): void {
    this.unsubscribe()
  }

  private deriveFromScope(): void {
    const snapshot = this.scope.getSnapshot()
    this.store.update((s) => {
      s.writable = snapshot.writable
      s.section = snapshot.value
    })
  }
}

export { DEV_MODE_COMPONENTS, DEV_MODE_ROLES }
export type { DevModeComponent, DevModePipelineSection, DevModeRole, DevModeRoleSection }
