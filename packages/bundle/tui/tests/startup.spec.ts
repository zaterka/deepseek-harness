/**
 * The interactive app's optional-flags provider over a real Loader tree: the
 * resume/model flags become injected client config, while `--help` and parse
 * errors leave the client row pending.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, TUI_STARTUP_SERVICE, type TuiStartupValues } from '../src/startup.ts'

/** What one boot of the fixture tree observed. */
interface Observed {
  exits: number[]
  out: string
  clientConfig?: unknown
}

const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  internals.stdout = process.stdout
  internals.stderr = process.stderr
})

/**
 * Mount the real provider over a client-row stand-in.
 * @param args - the invocation's inner arguments.
 * @returns the resolved service value and observed client/process effects.
 */
async function bootStartup(args: string[]): Promise<{ values: TuiStartupValues | undefined; observed: Observed }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-startup-'))
  const observed: Observed = { exits: [], out: '' }
  writeFileSync(join(dir, 'row.mjs'), 'export function apply(_ctx, config) { globalThis.__tuiStartupObserved.clientConfig = config }\n')
  // Loader imports through Node's resolver, so this fixture delegates to the
  // source-plane plugin already imported by the test.
  writeFileSync(join(dir, 'startup.mjs'), `
export const name = 'tui-startup'
export const inject = ['cmdlineArgs']
export const apply = ctx => globalThis.__tuiStartupApply(ctx)
`)
  writeFileSync(join(dir, 'cordis.yml'), [
    '- id: tui-client',
    `  name: ${pathToFileURL(join(dir, 'row.mjs')).href}`,
    `  inject: [${TUI_STARTUP_SERVICE}]`,
    '  config:',
    '    resumeSessionId: !!js ctx.tuiStartup.resumeSessionId',
    '    provider: !!js ctx.tuiStartup.provider',
    '    model: !!js ctx.tuiStartup.model',
    '- id: tui-startup',
    `  name: ${pathToFileURL(join(dir, 'startup.mjs')).href}`,
    '',
  ].join('\n'))
  const observing = { write: (chunk: string) => { observed.out += chunk; return true } }
  internals.stdout = observing
  internals.stderr = observing
  const globals = globalThis as unknown as {
    __tuiStartupApply: typeof apply
    __tuiStartupObserved: Observed
  }
  globals.__tuiStartupApply = apply
  globals.__tuiStartupObserved = observed

  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  provideCmdline(ctx, { args, exit: code => void observed.exits.push(code) })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })
  return {
    values: ctx.get(TUI_STARTUP_SERVICE) as TuiStartupValues | undefined,
    observed,
  }
}

describe('tui command-line provider', () => {
  it('publishes nothing when invoked with no flags', async () => {
    const { values, observed } = await bootStartup([])
    expect(values).toEqual({})
    expect(observed.clientConfig).toEqual({ resumeSessionId: undefined, provider: undefined, model: undefined })
    expect(observed.exits).toEqual([])
  })

  it('publishes the resume and model flags into the injected client config', async () => {
    const { values, observed } = await bootStartup(['--resume', 's-abc', '--model', 'deepseek-chat'])
    expect(values).toEqual({ resumeSessionId: 's-abc', model: 'deepseek-chat' })
    expect(observed.clientConfig).toEqual({
      resumeSessionId: 's-abc',
      provider: undefined,
      model: 'deepseek-chat',
    })
    expect(observed.exits).toEqual([])
  })

  it('publishes the provider flag alongside the model', async () => {
    const { values, observed } = await bootStartup(['--provider', 'pi-ai', '--model', 'some-model'])
    expect(values).toEqual({ provider: 'pi-ai', model: 'some-model' })
    expect(observed.clientConfig).toEqual({
      resumeSessionId: undefined,
      provider: 'pi-ai',
      model: 'some-model',
    })
  })

  it('publishes the provider flag on its own', async () => {
    const { values } = await bootStartup(['--provider', 'pi-ai'])
    expect(values).toEqual({ provider: 'pi-ai' })
  })

  it('prints its own help and leaves the client row pending on --help', async () => {
    const { values, observed } = await bootStartup(['--help'])
    expect(observed.out).toContain('dsh --profile tui')
    expect(observed.out).toContain('--resume <sessionId>')
    expect(values).toBeUndefined()
    expect(observed.clientConfig).toBeUndefined()
    expect(observed.exits).toEqual([0])
  })
})
