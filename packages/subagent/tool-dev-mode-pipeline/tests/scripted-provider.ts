/** Package-local scripted subagent boundary reused from `@deepseek-ai/dsh-tool-subagent`'s fixture pattern. */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
  SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'

const DEFAULT_CAPABILITIES: SubagentCapabilities = {
  outputSchema: true,
  depthLimit: true,
  toolFilter: true,
  persona: true,
}

/** Options for one scripted provider fixture. */
export interface Config {
  /** Registry name to register under. */
  name: string
  /** Final text returned by the scripted child. */
  reply?: string
  /** Terminal result reason. */
  stopReason?: SubagentStopReason
  /** Safe non-assistant detail for a non-completed result. */
  diagnostic?: string
  /** Observes each start request; the test asserts against the captured value. */
  onStart?: (request: SubagentStartRequest) => void
  /** When set, `start()` rejects with this reason instead of publishing a run. */
  startRejection?: unknown
  /** When set, the published run's `result` rejects with this reason instead of resolving. */
  resultRejection?: unknown
  /** When set, the published run's `dispose()` rejects with this reason instead of resolving. */
  disposeRejection?: unknown
}

/** Scripted provider that resolves immediately with a fixed reply. */
class ScriptedSubagentProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = DEFAULT_CAPABILITIES
  readonly inheritsParentContext = false

  constructor(
    readonly name: string,
    private readonly config: Config,
  ) {}

  async start(request: SubagentStartRequest): Promise<SubagentRun> {
    this.config.onStart?.(request)
    if (this.config.startRejection !== undefined) throw this.config.startRejection
    const output: ContentBlock[] = [{ type: 'text', text: this.config.reply ?? 'scripted subagent reply' }]
    const stopReason = this.config.stopReason ?? 'completed'
    const result: SubagentResult = {
      output,
      stopReason,
      ...this.config.diagnostic !== undefined && stopReason !== 'completed'
        ? { diagnostic: this.config.diagnostic }
        : {},
    }
    return {
      id: SessionId(`scripted-subagent:${this.name}:${request.parent.id}`),
      localAgent: undefined,
      // eslint-disable-next-line prefer-promise-reject-errors -- config-owned test rejection may be a non-Error value by design
      result: this.config.resultRejection === undefined ? Promise.resolve(result) : Promise.reject(this.config.resultRejection),
      // eslint-disable-next-line prefer-promise-reject-errors -- config-owned test rejection may be a non-Error value by design
      dispose: () => this.config.disposeRejection === undefined ? Promise.resolve() : Promise.reject(this.config.disposeRejection),
    }
  }
}

/**
 * Mount one scripted provider through an effect-scoped local plugin.
 * @param ctx - context carrying the real subagent registry.
 * @param config - scripted provider identity and outcome.
 * @returns the fixture plugin's disposable fiber.
 */
export function mountScriptedProvider(ctx: Context, config: Config) {
  return ctx.plugin({
    name: 'scripted-subagent-provider',
    inject: ['subagents'],
    apply(pluginCtx: Context): void {
      pluginCtx.subagents.registerProvider(new ScriptedSubagentProvider(config.name, config))
    },
  })
}
