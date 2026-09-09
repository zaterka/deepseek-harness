/**
 * The interactive client over real core registries and a scripted Agent
 * factory: fresh-create and model-override wiring, resume fallback, the boot
 * transcript, provider registration, and the missing-exit failure. The real
 * Loader composition (with a durable persisted session) lives in
 * `real-composition.spec.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import SessionStore from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, UserMessage } from '@deepseek-ai/dsh-session'
import type { SessionInspection, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { UserQuestionProvider } from '@deepseek-ai/dsh-user-questions'
import { apply, internals } from '../src/index.ts'

const originalInternals = { ...internals }
afterEach(() => { Object.assign(internals, originalInternals) })

/** Wrap any data object as a log event without inventing the full envelope. */
function event<K extends SessionEvent['type']>(type: K, data: Extract<SessionEvent, { type: K }>['data']): SessionEvent {
  return { type, data, seq: 0, time: 0 } as SessionEvent
}

interface MountOptions {
  /** Mount the real command runtime so slash commands dispatch. */
  withCommands?: boolean
  /** Skip mounting the user-questions service (defaults to mounting it). */
  withoutUserQuestions?: boolean
  /** Durable sessions the scripted factory can resume (id -> history events). */
  persisted?: Record<string, readonly SessionEvent[]>
}

interface FactoryObserved {
  createdOptions: CreateAgentOptions[]
  resumeOptions: ResumeAgentOptions[]
}

/** Mount the real registries around a scripted Agent factory. */
async function bench(opts: MountOptions = {}): Promise<{
  ctx: Context
  observed: FactoryObserved
  exits: number[]
  forcedExits: number[]
  run(config: { resumeSessionId?: string; provider?: string; model?: string }): Promise<{ out: string; err: string }>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
  if (!opts.withoutUserQuestions) await ctx.plugin(UserQuestionService)
  if (opts.withCommands === true) await ctx.plugin(CommandRuntime)
  if (opts.persisted !== undefined) {
    const keys = new Set(Object.keys(opts.persisted))
    const sessionPersistence = {
      list: async () => [...keys].map(id => ({ id: SessionId(id) }) as SessionHeader),
      inspect: async (id: SessionId) => ({
        meta: { id } as SessionHeader,
        events: opts.persisted?.[id] ?? [],
      }) as SessionInspection,
    } as unknown as SessionPersistence
    ctx.provide('sessionPersistence', sessionPersistence)
  }
  const observed: FactoryObserved = { createdOptions: [], resumeOptions: [] }
  const buildAgent = async (ownerCtx: Context, sessionId: SessionId, agentOptions: unknown): Promise<AgentHandle> => {
    const session = ctx.sessions.create(sessionId)
    const idle = Promise.resolve()
    const agent = {} as Agent
    const agentCtx = ownerCtx.extend({ agent })
    Object.assign(agent, {
      id: session.id,
      options: agentOptions ?? {},
      session,
      inbox: { append: () => {} } as unknown as Agent['inbox'],
      status: 'idle',
      ctx: agentCtx,
      cancel: () => {},
      followup: (message: UserMessage) => { agent.inbox.append('next-turn', message) },
      whenIdle: () => idle,
    } satisfies Partial<Agent>)
    ctx.agents.register(agent)
    return { agent, dispose: () => Promise.resolve() }
  }
  ctx.agents.setFactory({
    async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
      observed.createdOptions.push(options)
      const handle = await buildAgent(ownerCtx, options.sessionId, options.agentOptions)
      await options.setup?.(ownerCtx.extend({ agent: handle.agent }))
      return handle
    },
    async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
      observed.resumeOptions.push(options)
      if (opts.persisted === undefined) {
        // The direct bench never drives resume (no durable persistence is
        // composed); it only observes whether the id was requested.
        throw new Error('resume is not exercised in the direct bench')
      }
      const handle = await buildAgent(ownerCtx, options.resumeSessionId, options.agentOptions)
      await options.setup?.(ownerCtx.extend({ agent: handle.agent }))
      return handle
    },
  })
  const exits: number[] = []
  const forcedExits: number[] = []
  return {
    ctx,
    observed,
    exits,
    forcedExits,
    run: async (config) => {
      let out = ''
      let err = ''
      internals.stdout = { write: (chunk: string) => { out += chunk; return true } } as unknown as NodeJS.WritableStream
      internals.stderr = { write: (chunk: string) => { err += chunk; return true } } as unknown as NodeJS.WritableStream
      // The real seam calls process.exit; record the forced termination
      // separately so a test can assert the request and the termination apart.
      internals.exitProcess = (code: number) => { forcedExits.push(code) }
      ctx.provide('appExit', (code: number) => { exits.push(code) })
      apply(ctx, config)
      // run() is fire-and-forget; wait until the boot transcript shows it has
      // mounted the loop (providers registered before this line is written).
      for (let i = 0; i < 100 && !out.includes('session: '); i += 1) {
        await new Promise(resolve => setImmediate(resolve))
      }
      // Live getters so post-mount transcript (approval prompts, later writes)
      // keeps appearing in the returned handles.
      return { get out() { return out }, get err() { return err } }
    },
  }
}

describe('tui client direct composition', () => {
  it('creates a fresh agent with the default selection and prints the session the loop drives', async () => {
    const test = await bench()
    const { out } = await test.run({})
    expect(test.observed.createdOptions).toHaveLength(1)
    expect(test.observed.createdOptions[0]?.agentOptions).toEqual({ provider: 'test-provider', model: 'test-model' })
    expect(test.observed.resumeOptions).toEqual([])
    expect(out).toMatch(/^session: session-/u)
  })

  it('honors the --model override in the created agent options', async () => {
    const test = await bench()
    const { out } = await test.run({ model: 'override-model' })
    expect(test.observed.createdOptions[0]?.agentOptions).toEqual({ provider: 'test-provider', model: 'override-model' })
    expect(out).toMatch(/^session: session-/u)
  })

  it('honors the --provider override when the route is registered', async () => {
    const test = await bench()
    test.ctx.provide('llm', {
      listProviders: () => [{ id: 'test-provider', name: 'Test' }, { id: 'other', name: 'Other' }],
      listModels: async () => [],
    } as unknown as Context['llm'])
    const { out } = await test.run({ provider: 'other', model: 'other-model' })
    expect(test.observed.createdOptions[0]?.agentOptions).toEqual({ provider: 'other', model: 'other-model' })
    expect(out).toMatch(/^session: session-/u)
  })

  it('fails loud and exits non-zero on an unregistered --provider', async () => {
    const test = await bench()
    test.ctx.provide('llm', {
      listProviders: () => [{ id: 'test-provider', name: 'Test' }],
      listModels: async () => [],
    } as unknown as Context['llm'])
    const { out, err } = await test.run({ provider: 'nope' })
    expect(err).toContain('unknown provider "nope"; registered providers: test-provider')
    expect(test.observed.createdOptions).toEqual([])
    expect(out).toBe('')
    expect(test.exits).toContain(1)
  })

  it('falls back to a fresh session with a warning when resume targets an absent persistence', async () => {
    const test = await bench()
    const { out, err } = await test.run({ resumeSessionId: 's-gone' })
    expect(err).toContain('no persisted session "s-gone" found; starting a fresh session')
    expect(test.observed.resumeOptions).toEqual([])
    expect(test.observed.createdOptions).toHaveLength(1)
    expect(out).toMatch(/^session: session-/u)
  })

  it('falls back to a fresh session even when a persistence exists but lacks the target', async () => {
    // A composed persistence whose list does not contain the requested id: the
    // client still warns and starts fresh rather than resuming.
    const test = await bench({ persisted: { 's-kept': [] } })
    const { out, err } = await test.run({ resumeSessionId: 's-gone' })
    expect(err).toContain('no persisted session "s-gone" found; starting a fresh session')
    expect(test.observed.resumeOptions).toEqual([])
    expect(test.observed.createdOptions).toHaveLength(1)
    expect(out).toMatch(/^session: session-/u)
  })

  it('resumes a persisted session, renders its history, and drives it', async () => {
    const history = [
      event('user/message', createUserMessage({ content: [{ type: 'text', text: 'how were tests' }], source: { kind: 'user' } })),
      event('assistant/message', {
        turn: 1,
        step: 1,
        message: createAssistantMessage({ content: [{ type: 'text', text: 'they pass' }], source: { provider: 'p', model: 'm' } }),
      }),
    ]
    const test = await bench({ persisted: { 's-kept': history } })
    const { out } = await test.run({ resumeSessionId: 's-kept' })
    expect(test.observed.resumeOptions).toHaveLength(1)
    expect(test.observed.resumeOptions[0]?.resumeSessionId).toBe('s-kept')
    expect(test.observed.createdOptions).toHaveLength(0)
    // The persisted history is rendered as transcript lines before the session banner.
    expect(out).toContain('how were tests')
    expect(out).toContain('they pass')
    expect(out).toContain('session: s-kept')
  })

  it('throws when the launcher did not provide an exit request', () => {
    const bare = new Context()
    expect(() => { apply(bare, {}) }).toThrow('the launcher must provide ctx.appExit')
  })

  it('registers the user-questions provider as a disposable effect (HMR-safe)', async () => {
    // The client contributes its interaction provider through
    // `userQuestions.registerProvider`, whose returned disposer removes the
    // contribution — the disposal the client's registration inherits. Prove it:
    // after disposing, a fresh ask goes back to NO_PROVIDER.
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const disposer = ctx.userQuestions.registerProvider({} as unknown as UserQuestionProvider)
    disposer()
    await expect(ctx.userQuestions.ask({ questions: [{ id: 'q', question: 'x' }] }))
      .rejects.toMatchObject({ code: 'NO_PROVIDER' })
  })

  it('fails with a boot diagnostic when the user-questions service is absent', async () => {
    const test = await bench({ withoutUserQuestions: true })
    const { err } = await test.run({})
    // The missing user-questions service surfaces as a failing boot.
    for (let i = 0; i < 100 && err === '' && test.exits.length === 0; i += 1) {
      await new Promise(resolve => setImmediate(resolve))
    }
    expect(err).toContain('tui-client: the user-questions service must be composed')
    expect(test.exits).toEqual([1])
  })

  it('surfaces a non-Error factory failure as its string form and requests a failing exit', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentDefaultModelConfig, { provider: 'p', model: 'm' })
    let err = ''
    const exits: number[] = []
    internals.stdout = { write: () => true } as unknown as NodeJS.WritableStream
    internals.stderr = { write: (chunk: string) => { err += chunk; return true } } as unknown as NodeJS.WritableStream
    ctx.provide('appExit', (code: number) => { exits.push(code) })
    ctx.agents.setFactory({
      async createAgent(): Promise<AgentHandle> {
        throw 'factory exploded'
      },
      async resume(): Promise<AgentHandle> {
        throw new Error('factory failure')
      },
    })
    apply(ctx, {})
    for (let i = 0; i < 100 && err === ''; i += 1) {
      await new Promise(resolve => setImmediate(resolve))
    }
    expect(err).toContain('dsh: factory exploded')
    expect(exits).toEqual([1])
  })

  it('starts nothing and exits cleanly when a core service is missing', async () => {
    const ctx = new Context()
    ctx.provide('appExit', () => {})
    let out = ''
    internals.stdout = { write: (chunk: string) => { out += chunk; return true } } as unknown as NodeJS.WritableStream
    apply(ctx, {})
    await new Promise(resolve => setImmediate(resolve))
    // With no agents/default-model/sessions the driver returns before mounting.
    expect(out).toBe('')
  })

  it('answers a permission prompt through the loop readline', async () => {
    const test = await bench()
    // Substitute the process stdin the loop reads with a controllable stream.
    const stdin = new PassThrough()
    internals.stdin = stdin
    const run = await test.run({})
    expect(run.out).toContain('session: ')
    // A permission request after the loop mounts routes through the prompter.
    const decided = test.ctx.waterfall(
      'approval/request',
      { agent: {} as unknown as Agent, toolName: 'bash', reason: 'needs exec' },
      () => Promise.resolve('unavailable' as const),
    ) as unknown as Promise<string>
    // The answerer wrote the prompt; feed the "allow once" answer.
    stdin.write('a\n')
    expect(await decided).toBe('allowed-once')
    expect(run.out).toContain('permission: bash')
  })

  it('flushes the durable log after a settled turn', async () => {
    const test = await bench()
    const stdin = new PassThrough()
    internals.stdin = stdin
    await test.run({})
    // The bench agent resolves whenIdle immediately, so a typed line settles a
    // turn and the loop's post-settlement callout flushes the session log.
    stdin.write('howdy\n')
    for (let i = 0; i < 100; i += 1) {
      await new Promise(resolve => setImmediate(resolve))
    }
    expect(test.observed.createdOptions).toHaveLength(1)
  })

  it('exits through the loop when a slash command requests it', async () => {
    const test = await bench({ withCommands: true })
    const stdin = new PassThrough()
    internals.stdin = stdin
    await test.run({})
    // `/quit` runs the command handler's exit, which must route through the
    // loop so the readline interface closes and stdin is released; otherwise
    // the tree disposes but the process hangs at a dead prompt.
    stdin.write('/quit\n')
    for (let i = 0; i < 200 && test.forcedExits.length === 0; i += 1) {
      await new Promise(resolve => setImmediate(resolve))
    }
    expect(test.exits).toEqual([0])
    expect(test.forcedExits).toEqual([0])
  })

  it('forces process termination after the bounded shutdown, so an exit cannot hang', async () => {
    const test = await bench()
    const stdin = new PassThrough()
    internals.stdin = stdin
    await test.run({})
    stdin.end()
    for (let i = 0; i < 100 && test.forcedExits.length === 0; i += 1) {
      await new Promise(resolve => setImmediate(resolve))
    }
    // `appExit` only disposes the tree and sets `process.exitCode`; the
    // launcher's signal handlers and profile-patch watchers keep this
    // long-lived surface's event loop alive, so the exit must be forced.
    expect(test.exits).toEqual([0])
    expect(test.forcedExits).toEqual([0])
  })

  it('requests a clean exit through the loop when the input stream closes', async () => {
    const test = await bench()
    const stdin = new PassThrough()
    internals.stdin = stdin
    await test.run({})
    // EOF on the loop's input fires the readline `close`, which requests the
    // exit through the flush-then-exit path (covering the pending durable log).
    stdin.end()
    for (let i = 0; i < 100 && test.exits.length === 0; i += 1) {
      await new Promise(resolve => setImmediate(resolve))
    }
    expect(test.exits).toEqual([0])
  })

  it('still requests the exit when the durable flush rejects', async () => {
    const test = await bench()
    const stdin = new PassThrough()
    internals.stdin = stdin
    // A failing durable flush must not block the requested exit: the
    // flush-then-exit path swallows the rejection and still runs appExit.
    test.ctx.sessions.flush = () => Promise.reject(new Error('disk full'))
    await test.run({})
    stdin.end()
    for (let i = 0; i < 100 && test.exits.length === 0; i += 1) {
      await new Promise(resolve => setImmediate(resolve))
    }
    expect(test.exits).toEqual([0])
  })
})
