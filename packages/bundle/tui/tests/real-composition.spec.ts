/**
 * REAL-composition Loader boot of the `tui-client` plugin (packages/AGENTS.md
 * "Product-visible plugins require a non-unit REAL-composition test"): a real
 * Cordis tree assembled from a fixture `cordis.yml` through
 * `@deepseek-ai/cordis-plugin-loader`, composing the real core session/agent
 * stack and the real `@deepseek-ai/dsh-session-persistence-jsonl` durable
 * backend over a temp directory. The only mock is the LLM adapter — the
 * external, nondeterministic dependency `docs/testing.md` allows.
 *
 * Two-phase persist → resume flow:
 *   Phase A boots the tree once, lets `tui-client` create a fresh agent, and
 *   drives one turn through the scripted adapter so a durable session log is
 *   written to disk; the tree is then disposed.
 *   Phase B boots a second, independent tree over the SAME durable root with
 *   `resumeSessionId` set to the persisted id. This exercises the true resume
 *   branch in `src/index.ts` (`createAgent`'s `persistence.list()` +
 *   `.inspect()` + `agents.resume()`), not the missing-session fallback
 *   already covered by `index.spec.ts`. `internals.stdout` is asserted for
 *   both the rendered persisted history (`summarizeHistory`) and the
 *   restarted `session: <id>` line, proving user-visible resume output.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { MessageId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as TuiClient from '../src/index.ts'
import { internals } from '../src/index.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const originalInternals = { ...internals }
const dirs: string[] = []
const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  Object.assign(internals, originalInternals)
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** One booted tree's observed process-facing output. */
interface BootObserved {
  ctx: Context
  out: string
  err: string
  exitCode: number | undefined
}

/**
 * Boot the real dsh-tui composition through the Loader over a fixture
 * cordis.yml. Every plugin except the LLM adapter is the genuine package;
 * the JSONL persistence backend is pointed at `root` so both boots share one
 * durable log directory.
 * @param root - durable JSONL persistence root shared across boots.
 * @param adapter - scripted mock LLM adapter (the sole external mock).
 * @param resumeSessionId - optional persisted session id to resume.
 * @returns the booted context and captured stdout/stderr/exit code.
 */
async function boot(
  root: string,
  adapter: MockAdapter,
  resumeSessionId?: string,
): Promise<BootObserved> {
  const configDir = await mkdtemp(join(tmpdir(), 'dsh-tui-real-composition-cfg-'))
  dirs.push(configDir)
  const configPath = join(configDir, 'cordis.yml')
  const configLines = [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    '  config:',
    '    agents: []',
    "- name: '@deepseek-ai/dsh-agent-default-model'",
    '  config:',
    '    provider: mock',
    '    model: mock',
    "- name: '@deepseek-ai/dsh-user-questions'",
    "- name: '@deepseek-ai/dsh-commands'",
    "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
    '  config:',
    `    root: ${JSON.stringify(root)}`,
    "- name: '@deepseek-ai/dsh-tui'",
    '  config:',
    ...resumeSessionId === undefined ? [] : [`    resumeSessionId: ${JSON.stringify(resumeSessionId)}`],
  ]
  await import('node:fs/promises').then(fs => fs.writeFile(configPath, `${configLines.join('\n')}\n`))

  let out = ''
  let err = ''
  internals.stdout = { write: (chunk: string) => { out += chunk; return true } } as unknown as NodeJS.WritableStream
  internals.stderr = { write: (chunk: string) => { err += chunk; return true } } as unknown as NodeJS.WritableStream
  let exitCode: number | undefined
  // The real seam calls process.exit; record the forced termination instead.
  internals.exitProcess = (code: number) => { exitCode = code }
  const ctx = new Context()
  ctx.provide('appExit', (code: number) => { exitCode = code })
  // tui-client's static `inject` requires the startup-flag service; this test
  // drives the client directly (no dsh-cmdline flags), so provide the empty
  // value ambiently, mirroring how a launcher pre-provides `appExit`.
  ctx.provide('tuiStartup', {})
  ctx.baseUrl = pathToFileURL(configDir).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-agent-default-model', AgentDefaultModelConfig],
    ['@deepseek-ai/dsh-user-questions', UserQuestionService],
    ['@deepseek-ai/dsh-commands', CommandRuntime],
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlSessionPersistence],
    ['@deepseek-ai/dsh-tui', TuiClient],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  ctx.get('llm')!.registerAdapter(['mock'], adapter)
  disposers.push(async () => { await ctx.fiber.dispose() })

  // tui-client's run() is fire-and-forget: poll until it has written the boot
  // transcript (session: <id>), the same convergence signal used by
  // index.spec.ts's bench().
  // tui-client's run() is fire-and-forget: poll for the terminal boot line
  // (`session: <id>`). run() writes it only after createAgent/resume finishes,
  // so its presence is the convergence signal that the live agent is registered
  // for the caller to grab. Resume loads from the JSONL backend first, so bound
  // the wait in wall-clock time rather than a tight setImmediate spin.
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline && !out.includes('session: ')) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  // Live getters: tui-client's run() keeps writing to internals.stdout after
  // boot returns (each turn, the login loop). Returning a frozen snapshot would
  // hide every post-boot write, so expose the same live accessors index.spec.ts
  // uses.
  return {
    ctx,
    get out() { return out },
    get err() { return err },
    get exitCode() { return exitCode },
  }
}

describe('tui-client REAL Loader composition with durable JSONL persistence', () => {
  it(
    'persists a turn, then resumes it through the Loader: history renders and the durable id is reused',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'dsh-tui-real-composition-'))
      dirs.push(root)

      // --- Phase A: persist. Boot fresh, drive one turn, flush, dispose. ---
      const first = await boot(root, new MockAdapter([textResponse('hello from the model')]))
      const sessionIdLine = first.out.match(/^session: (\S+)$/mu)
      expect(sessionIdLine).not.toBeNull()
      const sessionId = SessionId(sessionIdLine![1]!)
      const agent = first.ctx.get('agents')!.get(sessionId)
      expect(agent).toBeDefined()

      agent!.followup({
        role: 'user',
        id: MessageId('user-msg-1'),
        content: [{ type: 'text', text: 'say hello' }],
        source: { kind: 'user' },
      })
      await agent!.whenIdle()
      await first.ctx.get('sessions')!.flush(agent!.session)
      // The live renderer echoes the user turn and streams assistant deltas as
      // separate lines (never a contiguous reply), so assert the user echo that
      // proves the loop rendered this turn; the contiguous reply text is
      // asserted when the persisted history is resumed in Phase B below.
      expect(first.out).toContain('> say hello')

      await first.ctx.fiber.dispose()

      // The durable JSONL log is on disk: list() finds the header without a
      // live Session, proving persistence outlives the disposed tree.
      const verify = new Context()
      await verify.plugin(SessionStore)
      const verifyFiber = await verify.plugin(JsonlSessionPersistence, { root })
      const persistedHeaders = await verify.sessionPersistence.list()
      expect(persistedHeaders.map(header => header.id)).toContain(sessionId)
      await verifyFiber.dispose()

      // --- Phase B: resume. Boot a second, independent tree over the same
      // durable root with resumeSessionId set to the persisted id. ---
      const second = await boot(
        root,
        new MockAdapter([textResponse('welcome back'), textResponse('after the switch, then')]),
        sessionId,
      )

      // The persisted history rendered as compact transcript lines (renderResumeHistory
      // -> summarizeHistory): the prior user prompt and assistant reply both
      // appear BEFORE the resumed boot's own "session: " line.
      const historyIndex = second.out.indexOf('say hello')
      const replyIndex = second.out.indexOf('hello from the model')
      const sessionLineIndex = second.out.indexOf(`session: ${sessionId}`)
      expect(historyIndex).toBeGreaterThanOrEqual(0)
      expect(replyIndex).toBeGreaterThanOrEqual(0)
      expect(sessionLineIndex).toBeGreaterThan(historyIndex)
      expect(sessionLineIndex).toBeGreaterThan(replyIndex)
      // No "no persisted session" fallback warning: the true resume branch ran.
      expect(second.err).not.toContain('no persisted session')

      // The resumed agent carries the SAME durable session id (agents.resume
      // was actually taken, not agents.create as a fresh fallback).
      const resumedAgent = second.ctx.get('agents')!.get(sessionId)
      expect(resumedAgent).toBeDefined()
      expect(resumedAgent!.session.id).toBe(sessionId)

      // Drive a second turn on the resumed agent and observe it extends the
      // SAME durable log rather than starting a new one.
      resumedAgent!.followup({
        role: 'user',
        id: MessageId('user-msg-2'),
        content: [{ type: 'text', text: 'continue please' }],
        source: { kind: 'user' },
      })
      await resumedAgent!.whenIdle()
      await second.ctx.get('sessions')!.flush(resumedAgent!.session)
      // Live streaming renders deltas per line; the resumed turn's user echo
      // proves the second turn ran through the loop, and the durable log below
      // carries that turn's assistant reply.
      expect(second.out).toContain('> continue please')

      // --- Phase C: switch the route mid-session through the real /model
      // command, then drive a third turn. The switch mutates the Agent-scoped
      // ModelSelectionRef the client installed at creation, so the next turn's
      // assembled route changes and the loop logs a `request/header` event with
      // reason 'change' carrying the new model. That durable header is the
      // model-visible evidence the switch reached an actual model request. ---
      const switched = await second.ctx.get('commands')!.execute(
        resumedAgent!,
        '/model switched-model',
        [],
        new AbortController().signal,
      )
      expect(switched?.result.kind).toBe('success')
      expect(switched?.result.text).toContain('switched-model')

      resumedAgent!.followup({
        role: 'user',
        id: MessageId('user-msg-3'),
        content: [{ type: 'text', text: 'after the switch' }],
        source: { kind: 'user' },
      })
      await resumedAgent!.whenIdle()
      await second.ctx.get('sessions')!.flush(resumedAgent!.session)

      await second.ctx.fiber.dispose()

      const finalVerify = new Context()
      await finalVerify.plugin(SessionStore)
      const finalVerifyFiber = await finalVerify.plugin(JsonlSessionPersistence, { root })
      const finalHeaders = await finalVerify.sessionPersistence.list()
      expect(finalHeaders.map(header => header.id)).toEqual([sessionId])
      const inspected = await finalVerify.sessionPersistence.inspect(sessionId)
      const turnStarts = inspected.events.filter(event => event.type === 'turn/start')
      expect(turnStarts).toHaveLength(3)

      // The switch is durable and reconstructable: a `request/header` event
      // records the changed route, so the model in force for the third turn is
      // recoverable from the log alone with no bespoke selection event.
      const switchedHeader = inspected.events.find(
        event => event.type === 'request/header' && event.data.header.config.model === 'switched-model',
      )
      expect(switchedHeader).toBeDefined()
      expect(switchedHeader?.type === 'request/header' && switchedHeader.data.reason).toBe('change')
      await finalVerifyFiber.dispose()
    },
    30_000,
  )
})
