/**
 * The interactive terminal app's command-line provider: it parses the optional
 * `--resume` and `--model` flags plus `--help`, then publishes
 * {@link TUI_STARTUP_SERVICE}. The client is an ordinary consumer whose lazy
 * loop waits for that service.
 * @module @deepseek-ai/dsh-tui/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'tui-startup'

/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the interactive client row. */
export const TUI_STARTUP_SERVICE = 'tuiStartup'

/** What the client row reads from {@link TUI_STARTUP_SERVICE}. */
export interface TuiStartupValues {
  /** Optional persisted session id to resume in place of a fresh session. */
  resumeSessionId?: string
  /** Optional provider route override for the interactive session. */
  provider?: string
  /** Optional model id override for the interactive session. */
  model?: string
}

/**
 * This app's command: the resume/provider/model flags, its description, and
 * help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function tuiCommand(): Command {
  return new Command()
    .name('dsh --profile tui')
    .description('Start an interactive DeepSeek Harness chat in the terminal.')
    .helpOption('-h, --help', 'show this help')
    .option('--resume <sessionId>', 'resume an existing persisted session by id instead of starting fresh')
    .option('--provider <provider>', 'route this session to a registered provider instead of the default')
    .option('--model <model>', 'override the default model for this session')
    .addHelpText('after', `
Examples:
  dsh --profile tui                 start a fresh interactive session
  dsh --profile tui --resume s-abc  resume the persisted session s-abc
  dsh --profile tui --model <m>     start with an explicit model
  dsh --profile tui --provider <p> --model <m>
                                    start on an explicit provider route

Switch the route without restarting with the /model command.
`)
}

/**
 * Parse and provide the interactive session's flags as an ordinary Cordis
 * service. `program.opts()` returns a record whose optional string fields are
 * `undefined` when the flags are absent; the action publishes the resolved
 * values, or nothing on `--help`.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = tuiCommand()
  program.action(() => {
    const opts = program.opts<Record<string, unknown>>()
    const value: TuiStartupValues = {
      ...(typeof opts.resume === 'string' ? { resumeSessionId: opts.resume } : {}),
      ...(typeof opts.provider === 'string' ? { provider: opts.provider } : {}),
      ...(typeof opts.model === 'string' ? { model: opts.model } : {}),
    }
    ctx.provide(TUI_STARTUP_SERVICE, value)
  })
  parseCmdline(ctx, program)
}
