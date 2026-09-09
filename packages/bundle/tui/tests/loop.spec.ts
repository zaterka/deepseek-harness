/**
 * Interactive loop over a scripted agent: input dispatch, turn submission and
 * streaming, slash-command routing, two-phase Ctrl-C, and close/exits. Driven
 * through a PassThrough input so readline delivers real `line` and `SIGINT`
 * events without a live terminal.
 */

import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentCancelCause } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import { TranscriptRenderer } from '../src/client/renderer.ts'
import { InteractiveLoop } from '../src/client/loop.ts'

/** Yield enough event-loop turns for readline to deliver queued input. */
async function tick(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise(resolve => setImmediate(resolve))
    await Promise.resolve()
  }
}

interface Drive {
  input: PassThrough
  read(): string
  exits: number[]
  followups: UserMessage[]
  cancels: AgentCancelCause[]
  settle(): void
  session: Session
  ctx: Context
  loop: InteractiveLoop
}

/** Mount a loop over one fresh Session and return the drive handles. */
async function bench(withCommands: boolean): Promise<Drive> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  if (withCommands) await ctx.plugin(CommandRuntime)
  const session = ctx.sessions.create(SessionId('sess'))
  let resolveIdle: () => void
  const idle = new Promise<void>((resolve) => { resolveIdle = resolve })
  const followups: UserMessage[] = []
  const cancels: AgentCancelCause[] = []
  const agent = {
    session,
    followup: (message: UserMessage) => { followups.push(message) },
    whenIdle: () => idle,
    cancel: (cause: AgentCancelCause) => { cancels.push(cause); resolveIdle() },
  } as unknown as Agent
  const input = new PassThrough()
  let out = ''
  const output = new Writable({
    write: (chunk: Buffer | string, _enc: BufferEncoding, cb: (error?: Error | null) => void) => {
      out += chunk.toString()
      cb()
    },
  })
  const exits: number[] = []
  const loop = new InteractiveLoop(
    ctx,
    agent,
    new TranscriptRenderer((line) => { out += `${line}\n` }),
    { input, output, isTTY: true, exit: (code) => { exits.push(code) } },
  )
  return {
    input,
    read: () => out,
    exits,
    followups,
    cancels,
    settle: () => { resolveIdle() },
    session,
    ctx,
    loop,
  }
}

describe('InteractiveLoop', () => {
  it('submits a typed line as a user turn and streams its assistant output', async () => {
    const drive = await bench(false)
    drive.input.write('howdy\n')
    await new Promise(resolve => setImmediate(resolve))
    // The turn is now live; events emitted on the agent's session render.
    drive.session.append('turn/start', { turn: 1 })
    drive.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'howdy' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    drive.session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Hel' } })
    drive.session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'Hello' }], source: { provider: 'p', model: 'm' } }),
    }, { surfaceOp: 'append' })
    drive.settle()
    await tick()
    expect(drive.followups).toHaveLength(1)
    expect(drive.followups[0]?.content).toMatchObject([{ type: 'text', text: 'howdy' }])
    expect(drive.read()).toContain('Hel')
  })

  it('re-prompts on a blank line without submitting a turn', async () => {
    const drive = await bench(false)
    drive.input.write('\n')
    await tick()
    expect(drive.followups).toHaveLength(0)
  })

  it('reports unavailable commands when no runtime is composed', async () => {
    const drive = await bench(false)
    drive.input.write('/plan\n')
    await tick()
    expect(drive.read()).toContain('commands are unavailable')
  })

  it('routes an unrecognized slash command through the runtime as unknown', async () => {
    const drive = await bench(true)
    drive.input.write('/nope\n')
    await tick()
    expect(drive.read()).toContain('unknown command: /nope')
  })

  it('cancels a running turn on the first Ctrl-C', async () => {
    const drive = await bench(false)
    drive.input.write('long task\n')
    await new Promise(resolve => setImmediate(resolve))
    // The turn is busy awaiting whenIdle; Ctrl-C cancels it.
    drive.input.write('\u0003')
    await tick()
    expect(drive.cancels).toEqual([{ kind: 'user' }])
    expect(drive.read()).toContain('interrupted')
  })

  it('arms then exits on two Ctrl-C presses while idle', async () => {
    const drive = await bench(false)
    drive.input.write('\u0003')
    await tick()
    expect(drive.read()).toContain('press Ctrl-C again to exit')
    drive.input.write('\u0003')
    await tick()
    expect(drive.exits).toEqual([130])
  })

  it('requests a clean exit when the input closes while idle', async () => {
    const drive = await bench(false)
    drive.input.end()
    await tick()
    expect(drive.exits).toEqual([0])
  })

  it('drops a line submitted while a turn is busy', async () => {
    const drive = await bench(false)
    drive.input.write('first\n')
    await new Promise(resolve => setImmediate(resolve))
    // The turn is busy awaiting whenIdle; a second line is dropped.
    drive.input.write('second\n')
    drive.settle()
    await tick()
    expect(drive.followups).toHaveLength(1)
  })

  it('does not exit when the input closes while a turn is busy', async () => {
    const drive = await bench(false)
    drive.input.write('working\n')
    await new Promise(resolve => setImmediate(resolve))
    // The turn is still busy awaiting whenIdle when the input closes.
    drive.input.end()
    await tick()
    expect(drive.exits).toEqual([])
  })

  it('ignores session events for a different session', async () => {
    const drive = await bench(false)
    const other = drive.ctx.sessions.create(SessionId('other'))
    drive.ctx.emit('session/event', other, { type: 'turn/start', data: { turn: 9 } } as never)
    await tick()
    // Nothing rendered for a sibling session's events.
    expect(drive.read()).not.toContain('turn 9')
  })

  it('answers a question through the shared readline', async () => {
    const drive = await bench(false)
    const pending = drive.loop.askLine('Color? ')
    drive.input.write('blue\n')
    await tick()
    await expect(pending).resolves.toBe('blue')
    expect(drive.read()).toContain('Color?')
  })

  it('prints the text of a successful command result', async () => {
    const drive = await bench(true)
    drive.ctx.commands.register({
      name: 'status',
      description: 'status',
      handler: () => ({ kind: 'success', text: 'all good' } as const),
    })
    drive.input.write('/status\n')
    await tick()
    expect(drive.read()).toContain('all good')
  })

  it('writes nothing for a successful command result without text', async () => {
    const drive = await bench(true)
    drive.ctx.commands.register({
      name: 'quiet',
      description: 'quiet',
      handler: () => ({ kind: 'success' } as const),
    })
    drive.input.write('/quiet\n')
    await tick()
    // No result text and no failure marker are written; the loop just re-prompts.
    expect(drive.read()).not.toContain('/command failed')
  })

  it('flags a failed command result after printing its text', async () => {
    const drive = await bench(true)
    drive.ctx.commands.register({
      name: 'boom',
      description: 'boom',
      handler: () => ({ kind: 'error', text: 'bad thing happened' } as const),
    })
    drive.input.write('/boom\n')
    await tick()
    expect(drive.read()).toContain('bad thing happened')
    expect(drive.read()).toContain('/command failed')
  })
  it('honors an EOF that arrives while a turn is still running', async () => {
    const drive = await bench(false)
    drive.input.write('do the thing\n')
    await tick()
    // EOF now, mid-turn: the close cannot exit yet without truncating the turn.
    drive.input.end()
    await tick()
    expect(drive.exits).toEqual([])
    // The turn settles; the deferred exit is honored instead of re-prompting a
    // closed readline (which would throw ERR_USE_AFTER_CLOSE).
    drive.settle()
    await tick()
    expect(drive.exits).toEqual([0])
  })
  it('suppresses the arm re-prompt when Ctrl-C lands after the interface closed', async () => {
    const drive = await bench(false)
    drive.loop.start()
    await tick()
    // Ctrl-C and EOF in one write: readline emits SIGINT, then closes. The arm
    // branch then re-prompts a closed interface, which must be suppressed
    // rather than throwing ERR_USE_AFTER_CLOSE.
    drive.input.write('\u0003')
    drive.input.end()
    await tick()
    expect(drive.read()).toContain('press Ctrl-C again to exit')
    expect(drive.exits).toEqual([0])
  })
})
