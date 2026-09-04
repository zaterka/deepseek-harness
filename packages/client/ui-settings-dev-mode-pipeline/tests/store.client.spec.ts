/**
 * DevModePipelineSettingsStore over a real mirror-derived settings scope and
 * a scripted `llm.models` wire face. Mirrors `ui-settings-models`'s
 * `welcome-store.client.spec.ts` template.
 */
import { describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '@deepseek-ai/dsh-api-remotes/client'
import { Context } from '@deepseek-ai/cordis'
import { SettingsSchemaService } from '@deepseek-ai/dsh-client-ui-settings/src/client/schema.ts'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { SettingsScopeController } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-scope.ts'
import { decodeDevModePipelineSection, DEV_MODE_PIPELINE_SETTINGS_NAMESPACE } from '../src/pipeline-copy.ts'
import { DevModePipelineSettingsStore, messageOf } from '../src/client/store.ts'

const schemaService = new SettingsSchemaService(new Context())

let rpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `dev-mode-${rpc++}` as never, result: { ok: true, value } }
}

function namespace(value: unknown = {}, revision = 0) {
  return {
    ns: DEV_MODE_PIPELINE_SETTINGS_NAMESPACE,
    schema: {},
    value,
    applies: 'live' as const,
    secrets: [],
    revision,
  }
}

/** The page store over a real mirror-derived scope, plus a scripted llm face. */
function buildStore(
  settingsApi: { describe?: ReturnType<typeof vi.fn>; mutate?: ReturnType<typeof vi.fn> },
  llm: { models: ReturnType<typeof vi.fn> },
  persistence: 'host' | 'memory' = 'host',
) {
  const wire = { settings: settingsApi } as never
  const mirror = new SettingsDescribeMirror(wire, persistence)
  const scope = new SettingsScopeController(
    wire,
    { namespace: DEV_MODE_PIPELINE_SETTINGS_NAMESPACE, decode: decodeDevModePipelineSection },
    mirror,
    persistence,
    schemaService,
  )
  return { mirror, scope, store: new DevModePipelineSettingsStore(llm as never, scope) }
}

describe('messageOf', () => {
  it('reads the message off an Error', () => {
    expect(messageOf(new Error('boom'))).toBe('boom')
  })

  it('stringifies a non-Error rejection', () => {
    expect(messageOf('plain string failure')).toBe('plain string failure')
  })
})

describe('DevModePipelineSettingsStore', () => {
  it('surfaces a well-formed RPC failure response, not just a thrown rejection', async () => {
    const models = vi.fn(() => Promise.resolve({
      rpcId: 'dev-mode-rpc-failure' as never,
      result: { ok: false as const, error: { code: 'SOME_ERROR', message: 'catalog denied' } },
    }))
    const describe = vi.fn(() => Promise.resolve(ok({ writable: true, hasDocument: false, namespaces: [namespace()] })))
    const { store } = buildStore({ describe }, { models })

    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({ status: 'error', error: 'SOME_ERROR: catalog denied' })
  })

  it('loads the model catalog independently of the settings scope', async () => {
    const models = vi.fn(() => Promise.resolve(ok({
      groups: [{ id: 'acme', name: 'Acme', models: [{ id: 'acme-large', name: 'Acme Large' }] }],
      failures: [],
    })))
    const describe = vi.fn(() => Promise.resolve(ok({ writable: true, hasDocument: false, namespaces: [namespace()] })))
    const { store } = buildStore({ describe }, { models })

    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({
      status: 'ready',
      groups: [{ id: 'acme', name: 'Acme', models: [{ id: 'acme-large', name: 'Acme Large' }] }],
      failures: [],
    })
  })

  it('surfaces a catalog load failure without losing the last good groups', async () => {
    const models = vi.fn()
      .mockResolvedValueOnce(ok({ groups: [{ id: 'acme', name: 'Acme', models: [] }], failures: [] }))
      .mockRejectedValueOnce(new Error('catalog unreachable'))
    const describe = vi.fn(() => Promise.resolve(ok({ writable: true, hasDocument: false, namespaces: [namespace()] })))
    const { store } = buildStore({ describe }, { models })

    await store.load()
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({
      status: 'error', error: 'catalog unreachable', groups: [{ id: 'acme', name: 'Acme', models: [] }],
    })
  })

  it('derives the pipeline section from the bound settings scope', async () => {
    const models = vi.fn(() => Promise.resolve(ok({ groups: [], failures: [] })))
    const describe = vi.fn(() => Promise.resolve(ok({
      writable: true,
      hasDocument: false,
      namespaces: [namespace({ planReview: { provider: 'acme', model: 'acme-large' } }, 1)],
    })))
    const { store, mirror } = buildStore({ describe }, { models })
    await mirror.ensure()

    expect(store.store.getSnapshot().writable).toBe(true)
    expect(store.store.getSnapshot().section?.planReview).toEqual({ provider: 'acme', model: 'acme-large' })
    expect(store.store.getSnapshot().section?.implement).toEqual({ provider: '', model: '' })
  })

  it('saves a role model selection through the bound scope', async () => {
    const models = vi.fn(() => Promise.resolve(ok({ groups: [], failures: [] })))
    const describe = vi.fn(() => Promise.resolve(ok({ writable: true, hasDocument: false, namespaces: [namespace()] })))
    const mutate = vi.fn(() => Promise.resolve(ok(namespace({ codeReview: { provider: 'acme', model: 'acme-large' } }, 1))))
    const { store, mirror } = buildStore({ describe, mutate }, { models })
    await mirror.ensure()

    await store.saveModel('codeReview', { provider: 'acme', model: 'acme-large' })
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({
      ns: DEV_MODE_PIPELINE_SETTINGS_NAMESPACE,
      ops: [{ op: 'set', path: ['codeReview'], value: { provider: 'acme', model: 'acme-large' } }],
    }))
  })

  it('saves one component context without touching the others', async () => {
    const models = vi.fn(() => Promise.resolve(ok({ groups: [], failures: [] })))
    const describe = vi.fn(() => Promise.resolve(ok({
      writable: true,
      hasDocument: false,
      namespaces: [namespace({ context: { planner: 'existing planner context' } })],
    })))
    const mutate = vi.fn(() => Promise.resolve(ok(namespace({}, 1))))
    const { store, mirror } = buildStore({ describe, mutate }, { models })
    await mirror.ensure()

    await store.saveContext('implement', 'new implement context')
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({
      ns: DEV_MODE_PIPELINE_SETTINGS_NAMESPACE,
      ops: [{
        op: 'set',
        path: ['context'],
        value: {
          planner: 'existing planner context',
          planReview: '',
          implement: 'new implement context',
          codeReview: '',
        },
      }],
    }))
  })

  it('stops deriving after dispose', async () => {
    const models = vi.fn(() => Promise.resolve(ok({ groups: [], failures: [] })))
    const describe = vi.fn(() => Promise.resolve(ok({ writable: true, hasDocument: false, namespaces: [namespace()] })))
    const { store, mirror } = buildStore({ describe }, { models })
    await mirror.ensure()
    store.dispose()
    const before = store.store.getSnapshot()
    mirror.acceptView(namespace({ planReview: { provider: 'acme', model: 'acme-large' } }, 1))
    expect(store.store.getSnapshot()).toBe(before)
  })
})
