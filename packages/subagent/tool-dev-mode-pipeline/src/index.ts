/**
 * Model-facing tools for the Development Mode pipeline: per-role model
 * lookup (`devagent.get-model`), per-component extra-context lookup
 * (`devagent.get-context`), and role-subagent delegation on the role's
 * configured model with its configured extra context prepended
 * (`devagent.spawn`).
 *
 * @module @deepseek-ai/dsh-tool-dev-mode-pipeline
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  DEV_MODE_COMPONENTS, DEV_MODE_ROLES,
} from '@deepseek-ai/dsh-dev-mode-pipeline'
import type { DevModeComponent, DevModeRole } from '@deepseek-ai/dsh-dev-mode-pipeline'
import type {} from '@deepseek-ai/dsh-subagent'

export const name = 'tool-dev-mode-pipeline'
export const inject = ['tools', 'devModePipeline', 'subagents']

/** Config: which registered `ctx.subagents` provider `devagent.spawn` starts children on. */
export interface Config {
  /** The `ctx.subagents` provider name to start role runs on (e.g. `spawn`). */
  provider: string
}

export const Config: z<Config> = z.object({
  provider: z.string().default('spawn'),
})

const ROLE_DESCRIPTION = 'Pipeline role: planReview, implement, or codeReview.'
const COMPONENT_DESCRIPTION = 'Pipeline component: planner, planReview, implement, or codeReview.'

/** Whether a string names one of the three spawnable pipeline roles. */
function isDevModeRole(value: string): value is DevModeRole {
  return (DEV_MODE_ROLES as readonly string[]).includes(value)
}

/** Whether a string names one of the four pipeline components. */
function isDevModeComponent(value: string): value is DevModeComponent {
  return (DEV_MODE_COMPONENTS as readonly string[]).includes(value)
}

/** Collect the text of every text content block, in order, joined with no separator. */
function joinText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

export function apply(ctx: Context, config: Config): void {
  // ctx.tools.register() already returns a disposer owned by this calling
  // fiber (an effect); no additional wrapping is needed for cleanup.
  ctx.tools.register(defineTool({
    name: 'devagent.get-model',
    description:
      'Read the model configured for one Development-Mode pipeline role ("planReview", "implement", or '
      + '"codeReview") and return its provider and model. Call this before spawning a role subagent so the spawn '
      + 'uses the role\u2019s configured model. devagent.spawn already resolves this internally, so calling it '
      + 'first is informational, not required.',
    parameters: {
      role: { type: 'string', required: true, description: ROLE_DESCRIPTION },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string' },
          model: { type: 'string' },
          fromSessionDefault: { type: 'boolean' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `devagent.get-model -> ${JSON.stringify(value)}` }],
    },
    execute(args) {
      if (!isDevModeRole(args.role)) {
        return Promise.resolve({ error: 'role must be one of planReview | implement | codeReview' })
      }
      const defaultModel = ctx.get('agentDefaultModel')
      return Promise.resolve(ctx.devModePipeline.modelFor(args.role, defaultModel))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'devagent.get-context',
    description:
      'Read the extra Development-Mode context configured in Settings > Development Mode for one component '
      + '("planner", "planReview", "implement", or "codeReview"). Call this at the start of the relevant pipeline '
      + 'stage (especially "planner", which this plugin cannot inject on its own since it is the main agent, not '
      + 'a spawned subagent) and fold any provided context into your instructions for that stage. devagent.spawn '
      + 'already resolves and prepends role context internally.',
    parameters: {
      component: { type: 'string', required: true, description: COMPONENT_DESCRIPTION },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          component: { type: 'string' },
          context: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `devagent.get-context -> ${JSON.stringify(value)}` }],
    },
    execute(args) {
      if (!isDevModeComponent(args.component)) {
        return Promise.resolve({ error: 'component must be one of planner | planReview | implement | codeReview' })
      }
      return Promise.resolve({ component: args.component, context: ctx.devModePipeline.contextFor(args.component) })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'devagent.spawn',
    description:
      'Spawn a Development-Mode pipeline role as a one-shot subagent on its configured model, with its '
      + 'configured extra context (if any) prepended to the prompt. role selects the model and context: '
      + '"planReview" critiques a written plan for gaps, "implement" writes code for one planned part, '
      + '"codeReview" compares generated code against the original plan. Returns the role, the resolved '
      + 'provider/model, whether that came from the session default, and the child\u2019s stop reason plus text output.',
    parameters: {
      role: { type: 'string', required: true, description: 'planReview | implement | codeReview.' },
      prompt: { type: 'string', required: true, description: 'Self-contained instructions for the subagent.' },
      label: { type: 'string', description: 'Optional short display label for the subagent.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          role: { type: 'string' },
          provider: { type: 'string' },
          model: { type: 'string' },
          fromSessionDefault: { type: 'boolean' },
          stopReason: { type: 'string' },
          text: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      if (!isDevModeRole(args.role)) {
        return { ok: false, error: 'role must be one of planReview | implement | codeReview' }
      }
      const parent = exec.agent
      if (parent === undefined) {
        return { ok: false, role: args.role, error: 'devagent.spawn requires a calling agent (exec.agent was undefined)' }
      }
      const defaultModel = ctx.get('agentDefaultModel')
      const selection = ctx.devModePipeline.modelFor(args.role, defaultModel)
      const roleContext = ctx.devModePipeline.contextFor(args.role)
      const prompt = roleContext === ''
        ? args.prompt
        : `[Configured Development Mode context for ${args.role}]\n${roleContext}\n\n${args.prompt}`
      try {
        const run = await ctx.subagents.start(config.provider, {
          label: (args.label === undefined || args.label === '') ? `devagent-${args.role}` : args.label,
          prompt: [{ type: 'text', text: prompt }],
          parent,
          signal: exec.signal,
          ...selection.provider !== '' && selection.model !== ''
            ? { agentOptions: { provider: selection.provider, model: selection.model } }
            : {},
        })
        const [execution] = await Promise.allSettled([run.result])
        const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
        if (execution.status === 'rejected') {
          const detail = disposal.status === 'rejected'
            ? `${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`
            : String(execution.reason)
          return { ok: false, role: args.role, provider: selection.provider, model: selection.model, error: detail }
        }
        if (disposal.status === 'rejected') {
          return { ok: false, role: args.role, provider: selection.provider, model: selection.model, error: String(disposal.reason) }
        }
        const result = execution.value
        return {
          ok: result.stopReason === 'completed',
          role: args.role,
          provider: selection.provider,
          model: selection.model,
          fromSessionDefault: selection.fromSessionDefault,
          stopReason: result.stopReason,
          text: joinText(result.output),
          ...result.diagnostic === undefined ? {} : { error: result.diagnostic },
        }
      } catch (err) {
        return {
          ok: false,
          role: args.role,
          provider: selection.provider,
          model: selection.model,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    },
  }))
}
