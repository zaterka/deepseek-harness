/**
 * TUI-local slash commands over the real command runtime: registration,
 * discovery through `/help`, and the process/terminal effects the handlers
 * capture. The compose-without-commands failure is asserted on a bare context.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { registerTuiCommands, type TuiCommandDeps } from '../src/client/commands.ts'

/** A bare context with no commands service. */
function bareContext(): Context {
  return new Context()
}

/** Mount the real session store and command runtime and mint one agent/session. */
async function mounted(): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  const session = ctx.sessions.create(SessionId('sess'))
  const agent = { id: session.id, session } as Agent
  await ctx.plugin(Object.assign((inner: Context) => { createScope(inner, agent) }, { inject: ['commands'] }))
  return { ctx, agent }
}

/** A recording IO seam for the handler effects. */
function deps(): TuiCommandDeps & { exits: number[]; read(): string } {
  let out = ''
  const exits: number[] = []
  return {
    exit: (code) => { exits.push(code) },
    isTTY: true,
    stdout: { write: (chunk: string) => { out += chunk; return true } },
    exits,
    read: () => out,
  }
}

describe('registerTuiCommands', () => {
  it('throws on a composition without the commands service', () => {
    expect(() => { registerTuiCommands(bareContext(), deps()) }).toThrow(
      'the commands service must be composed',
    )
  })

  it('registers the full command set discoverable through /help', async () => {
    const { ctx, agent } = await mounted()
    registerTuiCommands(ctx, deps())
    const execution = await ctx.commands.execute(agent, '/help', [], new AbortController().signal)
    const text = execution?.result.text ?? ''
    expect(text).toContain('/help')
    expect(text).toContain('/status')
    expect(text).toContain('/clear')
    expect(text).toContain('/quit')
    expect(text).toContain('/exit')
    expect(text).toContain('/resume')
  })

  it('/help renders an input hint as a suffix for commands that declare one', async () => {
    const { ctx, agent } = await mounted()
    ctx.commands.register({
      name: 'target',
      description: 'Do something to a target.',
      input: { hint: '<target>' },
      handler: () => ({ kind: 'success', text: 'done' } as const),
    })
    registerTuiCommands(ctx, deps())
    const execution = await ctx.commands.execute(agent, '/help', [], new AbortController().signal)
    const text = execution?.result.text ?? ''
    expect(text).toContain('/target <<target>>  Do something to a target.')
  })

  it('reports the live session id through /status', async () => {
    const { ctx, agent } = await mounted()
    registerTuiCommands(ctx, deps())
    const execution = await ctx.commands.execute(agent, '/status', [], new AbortController().signal)
    expect(execution?.result).toEqual({ kind: 'success', text: 'session: sess' })
  })

  it('/clear writes the ANSI escape only on a TTY', async () => {
    {
      const { ctx, agent } = await mounted()
      const tty = deps()
      registerTuiCommands(ctx, { ...tty, isTTY: true })
      await ctx.commands.execute(agent, '/clear', [], new AbortController().signal)
      expect(tty.read()).toContain('\x1b[2J\x1b[H')
    }
    {
      const { ctx, agent } = await mounted()
      const nonTty = deps()
      registerTuiCommands(ctx, { ...nonTty, isTTY: false })
      await ctx.commands.execute(agent, '/clear', [], new AbortController().signal)
      expect(nonTty.read()).toBe('')
    }
  })

  it('/quit and /exit both request a clean exit', async () => {
    const { ctx, agent } = await mounted()
    const seen = deps()
    registerTuiCommands(ctx, seen)
    const quit = await ctx.commands.execute(agent, '/quit', [], new AbortController().signal)
    expect(quit?.result.text).toBe('exiting')
    const exit = await ctx.commands.execute(agent, '/exit', [], new AbortController().signal)
    expect(exit?.result.text).toBe('exiting')
    expect(seen.exits).toEqual([0, 0])
  })

  it('/resume rejects with startup-flag guidance', async () => {
    const { ctx, agent } = await mounted()
    registerTuiCommands(ctx, deps())
    const execution = await ctx.commands.execute(agent, '/resume', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('error')
    expect(execution?.result.text).toContain('--resume')
  })
})
