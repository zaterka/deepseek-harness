/**
 * TUI-local slash commands. Registered through the shared `ctx.commands`
 * registry so they appear in `/help` discovery alongside the plugin commands
 * composed by the harness (`/plan`, `/compact`, …). The loop dispatches every
 * `/`-prefixed line through that same registry, so these handlers are reached
 * exactly like any other command; handlers that need process effects capture
 * the app's IO seam at registration.
 *
 * @module @deepseek-ai/dsh-tui/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'

/** Process/terminal effects the TUI command handlers need. */
export interface TuiCommandDeps {
  /** Request the app exit with a code after the tree disposes. */
  exit: (code: number) => void
  /** Whether stdout is an interactive terminal (drives `/clear`). */
  isTTY: boolean
  stdout: { write(chunk: string): unknown }
}

/** ANSI "clear screen and home cursor" for real terminals. */
const CLEAR_SCREEN = '\x1b[2J\x1b[H'

/**
 * Register the TUI-local slash commands on the shared registry.
 *
 * Commands that only read agent/session state (help, status) are pure of IO;
 * commands that affect the process (quit, exit, clear) capture `deps`.
 * `/resume` is intentionally not implemented interactively — resuming mid-session
 * would require replacing the live agent handle — and answers pointing at the
 * `--resume` startup flag (see the Known Limitations note in the README).
 *
 * @param ctx - plugin context carrying the shared command registry.
 * @param deps - process/terminal effects for the handlers that need them.
 */
export function registerTuiCommands(ctx: Context, deps: TuiCommandDeps): void {
  const commands = ctx.get('commands')
  if (commands === undefined) {
    throw new Error('tui-client: the commands service must be composed to register TUI slash commands')
  }

  const success = (text: string): CommandResult => ({ kind: 'success', text })

  commands.register({
    name: 'help',
    description: 'List the available slash commands for this session.',
    handler: (invocation: CommandInvocation) => {
      const lines = commands.list(invocation.agent).map((cmd) => {
        const suffix = cmd.input?.hint === undefined ? '' : ` <${cmd.input.hint}>`
        return `/${cmd.name}${suffix}  ${cmd.description}`
      })
      return success(lines.join('\n'))
    },
  })

  commands.register({
    name: 'status',
    description: 'Show the live session id for this session.',
    handler: (invocation: CommandInvocation) => {
      return success(`session: ${invocation.agent.session.id}`)
    },
  })

  commands.register({
    // `recordInput: false` — the command carries no payload worth duplicating.
    name: 'clear',
    description: 'Clear the terminal when it is interactive.',
    handler: () => {
      if (deps.isTTY) deps.stdout.write(CLEAR_SCREEN)
      return success('')
    },
  })

  const quit = {
    name: 'quit',
    description: 'Exit the interactive session.',
    handler: () => {
      deps.exit(0)
      return success('exiting')
    },
  }
  commands.register(quit)
  // `exit` is a second name for the same action (Claude-Code convention).
  commands.register({ ...quit, name: 'exit' })

  commands.register({
    name: 'resume',
    description: 'Resume a persisted session (startup flag only; see --resume).',
    handler: () => {
      return {
        kind: 'error',
        text: '/resume is not available mid-session; start with `dsh --profile tui --resume <session-id>`',
      }
    },
  })
}
