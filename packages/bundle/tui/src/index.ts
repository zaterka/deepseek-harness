/**
 * @deepseek-ai/dsh-tui — interactive terminal client. The bundle patch rides
 * over dsh-base without Host, HTTP, or browser plugins; this client creates (or
 * resumes) one Agent through the core registry, drives it from a readline REPL,
 * streams the assistant transcript and tool output as plain lines to stdout,
 * and answers permission/ask-user prompts on the same terminal.
 *
 * @module @deepseek-ai/dsh-tui
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { AgentHandle, AgentRegistry, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
// Empty type import carries the agentDefaultModel service into the Context merge.
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Empty type import carries the sessionPersistence service into the Context merge.
import type {} from '@deepseek-ai/dsh-session-persistence'
// Empty type import carries the llm service in for provider discovery.
import type {} from '@deepseek-ai/dsh-llm'
// Empty type imports carry the loader Context merge for the settlement await
// and the cmdline Context merge for the appExit host value.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import { TranscriptRenderer, summarizeHistory } from './client/renderer.ts'
import { InteractiveLoop } from './client/loop.ts'
import type { LoopIo } from './client/loop.ts'
import { registerTuiCommands } from './client/commands.ts'
import { registerModelCommand, resolveRequestedSelection } from './client/model-command.ts'
import { createApprovalAnswerer, createUserQuestionProvider } from './client/providers.ts'
import type { TuiPrompter } from './client/providers.ts'
import { TUI_STARTUP_SERVICE } from './startup.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-client'

/** Core services (plus the startup-flag provider) required before the loop mounts. */
export const inject = ['agentDefaultModel', 'agents', 'sessions', TUI_STARTUP_SERVICE]

/** Plugin config: the startup-flag values resolved from the injected provider. */
export interface Config {
  /** Optional persisted session id to resume instead of starting fresh. */
  resumeSessionId?: string
  /** Optional provider route override for the interactive session. */
  provider?: string
  /** Optional model id override for the interactive session. */
  model?: string
}

export const Config: z<Config> = z.object({
  resumeSessionId: z.string(),
  provider: z.string(),
  model: z.string(),
})

/** Process-facing IO the client runs over; tests substitute captures. */
export interface TuiIo {
  stdin: NodeJS.ReadableStream
  /** Terminal output stream; readline renders the prompt and cursor through it. */
  stdout: NodeJS.WritableStream
  /** Error stream for boot-time diagnostics. */
  stderr: NodeJS.WritableStream
  /** Whether input is an interactive terminal. */
  isTTY: boolean
  /**
   * Terminate the process after the launcher's bounded shutdown has run. A
   * long-lived surface needs this because `appExit` only sets `process.exitCode`
   * and the launcher's own watchers and signal handlers keep the loop alive.
   */
  exitProcess(code: number): void
}

/** The process streams the client runs over; tests substitute captures. */
export const internals: TuiIo = {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  isTTY: process.stdin.isTTY && process.stdout.isTTY,
  exitProcess: (code: number) => { process.exit(code) },
}

/** Render an unexpected direct-driver failure and request a failing exit. */
function fail(io: Pick<TuiIo, 'stderr'>, appExit: (code: number) => void, error: unknown): void {
  io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
  appExit(1)
}

/** Write the persisted history of a resumed session as compact transcript lines. */
function renderResumeHistory(events: readonly SessionEvent[], sink: (line: string) => void): void {
  for (const line of summarizeHistory(events)) sink(line)
}

/**
 * Resolve the session's starting route: the composed default overridden by the
 * `--provider`/`--model` flags. Validation runs through the same resolver the
 * `/model` command uses, so an unregistered provider is refused in one place.
 * @param registered - every registered provider route id.
 * @param base - the composed default selection.
 * @param config - validated startup config carrying the flag overrides.
 * @returns the resolved selection, or a message naming the valid providers.
 */
function resolveSelection(
  registered: readonly string[],
  base: ModelSelection,
  config: Config,
): { selection: ModelSelection } | { error: string } {
  return resolveRequestedSelection(registered, base, {
    ...config.provider === undefined ? {} : { provider: config.provider },
    ...config.model === undefined ? {} : { model: config.model },
  })
}

/**
 * Create (or resume) the interactive Agent. On `--resume` the persisted log is
 * verified first and its history rendered before the registry's own durability
 * `prepare()` resumes the live session.
 *
 * The mutable selection is created here and returned, so `/model` can switch the
 * route on the live Agent instead of replacing it.
 * @param ctx - plugin context carrying the agent registry and persistence.
 * @param agents - the core agent registry.
 * @param selection - the resolved starting route for this session.
 * @param config - validated startup config (resume id, route overrides).
 * @param renderHistory - sink for the resumed session's compact history.
 * @param stderr - error stream for the missing-session fallback warning.
 * @returns the Agent handle and the mutable selection driving its route.
 */
async function createAgent(
  ctx: Context,
  agents: AgentRegistry,
  selection: ModelSelection,
  config: Config,
  renderHistory: (events: readonly SessionEvent[]) => void,
  stderr: { write(chunk: string): unknown },
): Promise<{ handle: AgentHandle; selected: ModelSelectionRef }> {
  const selected: ModelSelectionRef = { current: selection, assembled: undefined }
  const setup = (agentCtx: Context) => {
    installModelSelection(agentCtx, selected)
  }
  const agentOptions = { provider: selection.provider, model: selection.model }

  if (config.resumeSessionId !== undefined) {
    const persistence = ctx.get('sessionPersistence')
    const target = SessionId(config.resumeSessionId)
    const stored = persistence === undefined ? [] : await persistence.list()
    const header = stored.find(candidate => candidate.id === target)
    if (persistence !== undefined && header !== undefined) {
      const inspected = await persistence.inspect(target)
      renderHistory(inspected.events)
      return { handle: await agents.resume({ resumeSessionId: target, agentOptions, setup }), selected }
    }
    stderr.write(`dsh: no persisted session "${config.resumeSessionId}" found; starting a fresh session\n`)
  }

  return {
    handle: await agents.create({
      sessionId: SessionId(`session-${randomUUID()}`),
      meta: { cwd: process.cwd() },
      agentOptions,
      setup,
    }),
    selected,
  }
}

/**
 * The client plugin entry: validate the launcher-provided exit request and hand
 * control to the async driver, surfacing unexpected failures as a failing exit.
 * @param ctx - plugin context carrying core services and the injected startup flags.
 * @param config - validated startup config (resume id, model override).
 */
export function apply(ctx: Context, config: Config): void {
  const appExit = ctx.get('appExit')
  if (appExit === undefined) {
    throw new Error('tui-client: the launcher must provide ctx.appExit before the tree mounts')
  }
  const io: TuiIo = internals
  void run(ctx, config, io, appExit).catch((error: unknown) => { fail(io, appExit, error) })
}

/**
 * Main asynchronous body: compose the agent, register the terminal interaction
 * providers and slash commands, then run the input loop until it requests exit.
 * @param ctx - plugin context carrying core services.
 * @param config - validated startup config.
 * @param io - process-facing IO.
 * @param appExit - launcher-provided bounded exit request.
 */
async function run(ctx: Context, config: Config, io: TuiIo, appExit: (code: number) => void): Promise<void> {
  /* jscpd:ignore-start -- bundle drivers share the loader-await / service-get preamble */
  // Loader siblings mount concurrently; ensure core services and tools are fully
  // composed before creating an Agent so its scoped adapters are not half-built.
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return
  /* jscpd:ignore-end */

  const writeLine = (line: string): void => { io.stdout.write(`${line}\n`) }
  // The renderer writes raw chunks so a streamed reply stays one wrapped
  // paragraph; resumed history is whole lines and keeps the line sink.
  const renderer = new TranscriptRenderer((chunk: string) => { io.stdout.write(chunk) }, io.isTTY)

  // An unregistered `--provider` has no sane fallback, so it fails loud here
  // rather than surfacing as an adapter routing error mid-turn.
  const registered = ctx.get('llm')?.listProviders().map(entry => entry.id) ?? []
  const resolved = resolveSelection(registered, defaultModel.currentSelection(), config)
  if ('error' in resolved) {
    io.stderr.write(`dsh: ${resolved.error}\n`)
    appExit(1)
    return
  }

  const { handle, selected } = await createAgent(ctx, agents, resolved.selection, config, (events) => {
    renderResumeHistory(events, writeLine)
  }, io.stderr)
  const agent = handle.agent

  // Flush the durable session log after each settled turn/command so progress
  // survives a later forceful kill; also flush once more when exiting.
  const flush = (): Promise<void> => sessions.flush(agent.session).then(() => undefined)
  const requestExit = (code: number): void => {
    void flush().catch(() => undefined).then(() => {
      appExit(code)
      // `appExit` disposes the tree and sets `process.exitCode`, leaving the
      // process to end once the event loop drains. That never happens on this
      // surface: the launcher keeps signal handlers and the profile-patch file
      // watchers alive for a long-lived app. Terminate after the bounded
      // shutdown has had its window, so `/quit`, `/exit`, EOF, and a second
      // Ctrl-C actually exit instead of hanging at a dead prompt.
      io.exitProcess(code)
    })
  }

  const loopIo: LoopIo = {
    input: io.stdin,
    output: io.stdout,
    isTTY: io.isTTY,
    exit: requestExit,
  }
  const loop = new InteractiveLoop(ctx, agent, renderer, loopIo, () => flush())

  // Commands exit through the loop so the terminal is released the same way as
  // an in-loop exit: the launcher's shutdown sets `process.exitCode` instead of
  // calling `process.exit`, so an open readline would keep the process alive.
  const exitThroughLoop = (code: number): void => { loop.requestExitFromCommand(code) }

  // Interaction providers and slash commands must be registered before the loop
  // starts (and before any followup runs) so an interactive tool call can never
  // hit NO_PROVIDER. The prompter routes through the loop's shared readline.
  const prompter: TuiPrompter = {
    write: (chunk: string): void => { io.stdout.write(chunk) },
    askLine: (prompt: string) => loop.askLine(prompt),
  }
  const userQuestions = ctx.get('userQuestions')
  if (userQuestions === undefined) {
    throw new Error('tui-client: the user-questions service must be composed to answer ask_user_question')
  }
  userQuestions.registerProvider(createUserQuestionProvider(prompter))
  ctx.on('approval/request', createApprovalAnswerer(prompter))
  try {
    registerTuiCommands(ctx, { exit: exitThroughLoop, isTTY: io.isTTY, stdout: io.stdout })
    registerModelCommand(ctx, { selection: selected, fallback: resolved.selection })
  } catch {
    // A composition without the commands service cannot dispatch commands; the
    // loop tolerates that absence and the chat input still works.
  }

  io.stdout.write(`session: ${agent.session.id}\n`)
  loop.start()
}
