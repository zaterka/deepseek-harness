/**
 * Interactive terminal loop for the TUI client: a readline REPL that turns one
 * typed line into either a slash command execution or an agent turn, streams
 * the assistant transcript while the agent is live, and implements two-phase
 * Ctrl-C handling (first cancels the running turn, second exits).
 *
 * The loop is the application's only signal owner in the interactive case: the
 * readline interface keeps the terminal in raw mode while a turn runs, so
 * Ctrl-C surfaces as the interface `SIGINT` event here rather than the
 * process-level handler the launcher installs. An externally delivered
 * `SIGTERM`/`SIGINT` (a supervisor, a second terminal) still reaches the
 * launcher's bounded shutdown.
 * @module @deepseek-ai/dsh-tui/loop
 */

import * as readline from 'node:readline'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TranscriptRenderer } from './renderer.ts'

/** The prompt readline shows at the start of each line. */
export const PROMPT = '❯ '

/** Input/output seam the loop writes through; tests substitute captures. */
export interface LoopIo {
  input: NodeJS.ReadableStream
  output: NodeJS.WritableStream
  /** Whether input is an interactive terminal (drives raw-mode/SIGINT behavior). */
  isTTY: boolean
  /** Request process exit after the tree disposes. */
  exit(code: number): void
}

/**
 * Live, in-process interactive chat loop over one agent.
 *
 * Holds one readline interface plus the agent it drives and the renderer it
 * streams through. The `session/event` feed is wired once at construction and
 * filtered to this agent's exact session so sibling agents never interleave.
 */
export class InteractiveLoop {
  /** Plugin context carrying `session/event` emission and slash-command execution. */
  private readonly ctx: Context
  /** The exact agent this loop drives. */
  private readonly agent: Agent
  /** Renders live session events to the output. */
  private readonly renderer: TranscriptRenderer
  /** Input/output seam, injectable for tests. */
  private readonly io: LoopIo
  /** readline interface over `io.input`/`io.output`. */
  private readonly rl: readline.Interface
  /** Whether a turn or command is currently being awaited. */
  private busy = false
  /** Ctrl-C phase: false until the first interrupt while idle, which requests exit. */
  private interruptArmed = false
  /** Whether the readline interface has closed, after which it must not be prompted. */
  private closed = false
  /** Whether an exit has been requested, after which the loop stops prompting. */
  private exiting = false
  /** Abort controller for the current turn's command signal. */
  private turnAbort: AbortController | undefined
  /** Optional post-settlement persistence callout (flushes the session log). */
  private readonly onSettled: (() => void | Promise<void>) | undefined

  /**
   * Create the interactive loop over `agent`.
   * @param ctx - plugin context carrying session events and slash commands.
   * @param agent - the exact agent this loop drives.
   * @param renderer - the transcript renderer streaming to the output.
   * @param io - input/output seam and exit request.
   * @param onSettled - optional persistence callout awaited after each turn or
   *   command settles, so durable state advances even in a never-exiting loop.
   */
  constructor(
    ctx: Context,
    agent: Agent,
    renderer: TranscriptRenderer,
    io: LoopIo,
    onSettled?: () => void | Promise<void>,
  ) {
    this.ctx = ctx
    this.agent = agent
    this.renderer = renderer
    this.io = io
    this.onSettled = onSettled
    this.rl = readline.createInterface({
      input: io.input,
      output: io.output,
      terminal: io.isTTY,
    })
    this.rl.on('line', (line) => { void this.onLine(line) })
    this.rl.on('SIGINT', () => { this.onSigint() })
    this.rl.on('close', () => {
      // EOF (piped input drained, or Ctrl-D): the interface is gone, so nothing
      // may prompt it again even if a turn is still settling.
      this.closed = true
      if (!this.busy) this.requestExit(0)
    })
    ctx.on('session/event', (session, event: SessionEvent) => {
      if (session === this.agent.session) this.renderer.onEvent(event)
    })
  }

  /**
   * Begin reading input and present the prompt.
   */
  start(): void {
    this.rl.setPrompt(PROMPT)
    this.rl.prompt()
  }

  /**
   * Request the process exit from outside the loop (a slash command handler).
   * Routes through the same terminal release an in-loop exit uses.
   * @param code - the exit status to request.
   */
  requestExitFromCommand(code: number): void {
    this.requestExit(code)
  }

  /**
   * Request the process exit and release the terminal.
   *
   * Closing the interface and releasing `stdin` is what lets an interactive
   * surface end: the launcher's `appExit` disposes the tree and sets
   * `process.exitCode` rather than calling `process.exit`, so an open readline
   * holding `stdin` referenced (and a TTY in raw mode) would keep the event
   * loop alive forever.
   * @param code - the exit status to request.
   */
  private requestExit(code: number): void {
    if (this.exiting) return
    this.exiting = true
    if (!this.closed) this.rl.close()
    // A raw-mode TTY keeps `stdin` active even after the interface closes;
    // `unref` is a socket/TTY facility absent from the generic stream type.
    this.io.input.pause()
    const unrefable = this.io.input as NodeJS.ReadableStream & { unref?: () => void }
    unrefable.unref?.()
    this.io.exit(code)
  }

  /**
   * Ask a single-line question on the shared terminal and resolve with the raw
   * submitted line (no trailing newline). Used by the interaction providers so
   * approval/ask-user prompts and the chat input share one readline interface —
   * `rl.question` temporarily takes over line delivery, so this may be called
   * while a turn is busy without racing the main prompt.
   * @param prompt - the question text written before input.
   * @returns the submitted line, or an empty string on an aborted read.
   */
  askLine(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl.question(prompt, (line) => { resolve(line) })
    })
  }

  /**
   * Handle one submitted line: empty input re-prompts, a leading `/` dispatches
   * a command, and anything else starts an agent turn.
   * @param line - the raw submitted line without the trailing newline.
   */
  private async onLine(line: string): Promise<void> {
    if (this.busy) return
    if (line.trim() === '') {
      this.rl.prompt()
      return
    }
    if (line.startsWith('/')) {
      await this.dispatchCommand(line)
    } else {
      // Terminate the echoed prompt line before assistant output streams so
      // streamed text starts on a fresh line rather than beside the `❯ `.
      this.io.output.write('\n')
      await this.runTurn(line)
    }
    // EOF that arrived while this turn ran deferred its exit so the turn's
    // output and durable flush stayed intact; honor it now rather than
    // prompting a closed interface (piped input always ends this way).
    if (this.closed) {
      this.requestExit(0)
      return
    }
    this.rl.prompt()
  }

  /**
   * Dispatch one slash-command line through the global command runtime.
   * @param line - the full command line starting with `/`.
   */
  private async dispatchCommand(line: string): Promise<void> {
    const commands = this.ctx.get('commands')
    if (commands === undefined) {
      this.io.output.write('commands are unavailable in this composition\n')
      return
    }
    this.busy = true
    const controller = new AbortController()
    this.turnAbort = controller
    try {
      const execution = await commands.execute(this.agent, line, [], controller.signal)
      if (execution === undefined) {
        this.io.output.write(`unknown command: ${line}\n`)
        return
      }
      const result = execution.result
      if (result.text !== undefined) this.io.output.write(`${result.text}\n`)
      if (result.kind === 'error') {
        this.io.output.write('/command failed\n')
      }
    } finally {
      this.turnAbort = undefined
      this.busy = false
      await this.onSettled?.()
    }
  }

  /**
   * Submit `line` as an ordinary user turn and stream the assistant transcript
   * until quiescence.
   * @param line - the user prompt text.
   */
  private async runTurn(line: string): Promise<void> {
    this.busy = true
    this.agent.followup(createUserMessage({
      content: [{ type: 'text', text: line }],
      source: { kind: 'user' },
    }))
    await this.agent.whenIdle()
    this.busy = false
    await this.onSettled?.()
  }

  /**
   * Handle Ctrl-C (readline interface `SIGINT`). While a turn is running, the
   * first interrupt cancels it and returns to the prompt; while idle, the first
   * interrupt requests exit and the second forces it.
   */
  private onSigint(): void {
    if (this.busy) {
      // Cancel the running turn; its `whenIdle()` converges and `onLine`
      // re-prompts. The second Ctrl-C during that (usually brief) convergence
      // cancels again rather than force-exiting.
      this.agent.cancel({ kind: 'user' })
      this.turnAbort?.abort()
      this.io.output.write('\ninterrupted\n')
      return
    }
    if (!this.interruptArmed) {
      this.interruptArmed = true
      this.io.output.write('\npress Ctrl-C again to exit\n')
      this.rl.prompt()
      return
    }
    this.requestExit(130)
  }
}
