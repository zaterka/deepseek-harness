/**
 * Per-role model selection and per-component prompt context for the
 * Development Mode pipeline: the settings-backed store the pipeline's
 * planner (main agent), plan-review, implementation, and code-review
 * components read from.
 *
 * @module @deepseek-ai/dsh-dev-mode-pipeline
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Per-role model selection and per-component prompt context for the pipeline. */
    devModePipeline: DevModePipelineConfig
  }
}

/** A pipeline component whose prompt may carry extra developer-supplied context. */
export type DevModeComponent = 'planner' | 'planReview' | 'implement' | 'codeReview'

/** Every pipeline component, in stage order. */
export const DEV_MODE_COMPONENTS: readonly DevModeComponent[] = ['planner', 'planReview', 'implement', 'codeReview']

/** A pipeline role the plugin spawns as a subagent (excludes `planner`, the main agent). */
export type DevModeRole = Exclude<DevModeComponent, 'planner'>

/** Every spawnable pipeline role, in stage order. */
export const DEV_MODE_ROLES: readonly DevModeRole[] = ['planReview', 'implement', 'codeReview']

/** Settings namespace carrying the pipeline's per-role models and per-component contexts. */
export const DEV_MODE_PIPELINE_SETTINGS_NAMESPACE = settingsNamespace('dev-mode-pipeline')

/** One role's stored model selection. */
export interface DevModeRoleSettings {
  /** Registered provider route; empty string defers to the session default. */
  provider: string
  /** Provider-owned model id; empty string defers to the session default. */
  model: string
}

/** Stored and composed Development Mode pipeline settings. */
export interface DevModePipelineSettings {
  /** Model selection for the `planReview` role. */
  planReview: DevModeRoleSettings
  /** Model selection for the `implement` role. */
  implement: DevModeRoleSettings
  /** Model selection for the `codeReview` role. */
  codeReview: DevModeRoleSettings
  /** Extra developer-supplied context per component, prepended to its baseline prompt. */
  context: Record<DevModeComponent, string>
}

const roleSchema: z<DevModeRoleSettings> = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
})

/** Schema of the Development Mode pipeline settings section. */
export const DEV_MODE_PIPELINE_SETTINGS_SCHEMA: z<DevModePipelineSettings> = z.object({
  planReview: roleSchema,
  implement: roleSchema,
  codeReview: roleSchema,
  context: z.object({
    planner: z.string().default(''),
    planReview: z.string().default(''),
    implement: z.string().default(''),
    codeReview: z.string().default(''),
  }),
})

/**
 * Baseline (read-only) prompt text for each pipeline component. A settings
 * surface shows this alongside the component's editable extra context; a
 * spawned role's actual prompt is authored by the calling agent and is not
 * reconstructed from this text.
 */
export const DEV_MODE_BASELINE_PROMPTS: Readonly<Record<DevModeComponent, string>> = {
  planner:
    'Interview the developer on open or ambiguous requirements (ask_user_question for anything not already '
    + 'decided or discoverable by inspection), explore the real repository, then write a decision-complete plan '
    + 'to a Markdown file covering the goal, success criteria, grouped changes by subsystem, API/schema/data-flow '
    + 'changes, edge cases, failure modes, tests, and explicit assumptions.',
  planReview:
    'Critique the written plan for gaps before any code is written: missing or ambiguous requirements, unhandled '
    + 'edge cases and failure modes, missing tests or acceptance criteria, and any part of the plan that is not '
    + 'decision-complete. Return concrete, actionable recommendations.',
  implement:
    'Implement exactly the assigned part of the approved plan. Follow existing repository patterns, keep changes '
    + 'focused, add tests, and do not expand scope beyond what the plan specifies.',
  codeReview:
    'Compare the generated code against the original plan. Verify every planned change was implemented, flag '
    + 'deviations and correctness issues, check that tests cover the plan, and report concrete fixes for any '
    + 'legitimate gaps.',
}

const emptyRole: DevModeRoleSettings = { provider: '', model: '' }

/** The settings section's shape before a role defers to the session default. */
function defaultSettings(): DevModePipelineSettings {
  return {
    planReview: { ...emptyRole },
    implement: { ...emptyRole },
    codeReview: { ...emptyRole },
    context: { planner: '', planReview: '', implement: '', codeReview: '' },
  }
}

/** One role's resolved model selection: the stored choice, or the session default. */
export interface DevModeModelSelection {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Whether this selection came from the session default rather than a stored role choice. */
  fromSessionDefault: boolean
}

/**
 * Owns the Development Mode pipeline's per-role model selection and
 * per-component extra context, independently of any Host or transport. A
 * role with no stored provider/model defers to the session default model
 * ({@link AgentDefaultModelConfig}), read live at each call.
 */
export class DevModePipelineConfig extends Service {
  private source: () => DevModePipelineSettings

  constructor(ctx: Context) {
    super(ctx, 'devModePipeline')
    const entry = defaultSettings()
    this.source = () => entry
    installSettingsSection(ctx, DEV_MODE_PIPELINE_SETTINGS_NAMESPACE, DEV_MODE_PIPELINE_SETTINGS_SCHEMA, entry, {
      setSource: (current) => { this.source = current },
      onChange: () => {},
    })
  }

  /**
   * Resolve one role's model selection: the stored provider/model when both
   * are set, otherwise the session's default model.
   * @param role - the pipeline role to resolve.
   * @param defaultModel - optional default-model service; absent falls back to an empty selection.
   * @returns the resolved provider, model, and whether the default supplied it.
   */
  modelFor(role: DevModeRole, defaultModel: AgentDefaultModelConfig | undefined): DevModeModelSelection {
    const stored = this.source()[role]
    if (stored.provider !== '' && stored.model !== '') {
      return { provider: stored.provider, model: stored.model, fromSessionDefault: false }
    }
    if (defaultModel === undefined) return { provider: '', model: '', fromSessionDefault: true }
    const fallback = defaultModel.currentSelection()
    return { provider: fallback.provider, model: fallback.model, fromSessionDefault: true }
  }

  /**
   * Read one component's stored extra context.
   * @param component - the pipeline component to read.
   * @returns the stored context, or an empty string when none was set.
   */
  contextFor(component: DevModeComponent): string {
    return this.source().context[component]
  }

  /**
   * Save one role's model selection. An empty provider or model clears the
   * override, so the role reverts to the session default.
   * @param role - the pipeline role to update.
   * @param selection - the next provider/model, or empty strings to clear.
   */
  async saveModel(role: DevModeRole, selection: DevModeRoleSettings): Promise<void> {
    await this.ctx.get('settings')?.update(DEV_MODE_PIPELINE_SETTINGS_NAMESPACE, {
      [role]: { provider: selection.provider, model: selection.model },
    })
  }

  /**
   * Save one component's extra context.
   * @param component - the pipeline component to update.
   * @param context - the next extra context text.
   */
  async saveContext(component: DevModeComponent, context: string): Promise<void> {
    await this.ctx.get('settings')?.update(DEV_MODE_PIPELINE_SETTINGS_NAMESPACE, {
      context: { [component]: context },
    })
  }
}

export default DevModePipelineConfig
