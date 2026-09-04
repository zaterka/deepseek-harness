/**
 * Static identity shared with `@deepseek-ai/dsh-dev-mode-pipeline`: the
 * settings namespace, the pipeline's role/component keys, and the read-only
 * baseline prompt copy shown next to each component's extra-context field.
 * Kept as plain data here (not imported from the Host package) because a
 * client plugin package depends only on other `@deepseek-ai/dsh-client-*`
 * packages and a few universal wire packages — the same convention
 * `ui-settings-models`'s `onboarding-copy.ts` follows for its own namespace
 * literal. Update both sides together when the pipeline's keys change.
 */

/** Durable settings namespace carrying the pipeline's per-role models and per-component contexts. */
export const DEV_MODE_PIPELINE_SETTINGS_NAMESPACE = 'dev-mode-pipeline'

/** A pipeline role the plugin spawns as a subagent. */
export type DevModeRole = 'planReview' | 'implement' | 'codeReview'

/** Every spawnable pipeline role, in stage order. */
export const DEV_MODE_ROLES: readonly DevModeRole[] = ['planReview', 'implement', 'codeReview']

/** A pipeline component whose prompt may carry extra developer-supplied context. */
export type DevModeComponent = DevModeRole | 'planner'

/** Every pipeline component, in stage order. */
export const DEV_MODE_COMPONENTS: readonly DevModeComponent[] = ['planner', 'planReview', 'implement', 'codeReview']

/** One role's stored model selection, as it rides the settings wire. */
export interface DevModeRoleSection {
  provider: string
  model: string
}

/** The pipeline's settings section, as it rides the settings wire. */
export interface DevModePipelineSection {
  planReview: DevModeRoleSection
  implement: DevModeRoleSection
  codeReview: DevModeRoleSection
  context: Record<DevModeComponent, string>
}

/**
 * Baseline (read-only) prompt text for each pipeline component, shown next to
 * its editable extra-context field. Descriptive copy only — the spawned
 * role's actual prompt is authored by the calling agent, and the pipeline
 * plugin prepends the stored extra context to it, not this text.
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

/** An empty role section: defers to the session default model. */
const EMPTY_ROLE: DevModeRoleSection = { provider: '', model: '' }

/**
 * The pipeline section's shape before any user override.
 * @returns a fresh, fully-empty pipeline section.
 */
export function emptyDevModePipelineSection(): DevModePipelineSection {
  return {
    planReview: { ...EMPTY_ROLE },
    implement: { ...EMPTY_ROLE },
    codeReview: { ...EMPTY_ROLE },
    context: { planner: '', planReview: '', implement: '', codeReview: '' },
  }
}

/** Whether a value is a plain data object (not an array or null). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Decode one role's section, defaulting a malformed or absent value to empty. */
function decodeRoleSection(value: unknown): DevModeRoleSection {
  if (!isPlainObject(value)) return { ...EMPTY_ROLE }
  return {
    provider: typeof value.provider === 'string' ? value.provider : '',
    model: typeof value.model === 'string' ? value.model : '',
  }
}

/**
 * Decode the wire section into a complete {@link DevModePipelineSection},
 * defaulting any malformed or absent field to empty — the same total-read
 * rule `decodeWelcomeSection` follows, so a settings document edited by hand
 * never strands the page on `undefined`.
 * @param section - the wire section value (`SettingsNamespaceView.value`).
 * @returns the decoded, complete pipeline section.
 */
export function decodeDevModePipelineSection(section: unknown): DevModePipelineSection {
  const empty = emptyDevModePipelineSection()
  if (!isPlainObject(section)) return empty
  const context = isPlainObject(section.context) ? section.context : {}
  return {
    planReview: decodeRoleSection(section.planReview),
    implement: decodeRoleSection(section.implement),
    codeReview: decodeRoleSection(section.codeReview),
    context: {
      planner: typeof context.planner === 'string' ? context.planner : '',
      planReview: typeof context.planReview === 'string' ? context.planReview : '',
      implement: typeof context.implement === 'string' ? context.implement : '',
      codeReview: typeof context.codeReview === 'string' ? context.codeReview : '',
    },
  }
}
