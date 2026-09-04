// @vitest-environment jsdom
/** DevModePipelineSection rendered over a stubbed settings scope and llm face. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { DevModePipelineSection } from '../src/client/DevModePipelineSection.tsx'
import { DevModePipelineSettingsStore } from '../src/client/store.ts'
import { emptyDevModePipelineSection } from '../src/pipeline-copy.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
})

function translate(key: keyof typeof en, params?: Record<string, string>): string {
  let text: string = en[key]
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, value)
  }
  return text
}

function mount(models: ReturnType<typeof vi.fn>, section = emptyDevModePipelineSection()) {
  const stub = stubSettingsScope<ReturnType<typeof emptyDevModePipelineSection>>()
  const store = new DevModePipelineSettingsStore({ models } as never, stub.scope)
  stub.publish({ status: 'ready', writable: true, value: section, revision: 1 })
  const useSnapshot = bindSnapshotSelector(store.store)
  const view = render(
    <DevModePipelineSection controller={store} useSnapshot={useSnapshot} t={translate} />,
  )
  return { store, stub, view }
}

describe('DevModePipelineSection', () => {
  it('shows the Models tab by default with one row per role', async () => {
    const models = vi.fn(() => Promise.resolve({
      rpcId: 'component-models' as never,
      result: {
        ok: true as const,
        value: { groups: [{ id: 'acme', name: 'Acme', models: [{ id: 'acme-large', name: 'Acme Large' }] }], failures: [] },
      },
    }))
    mount(models)
    await waitFor(() => { expect(models).toHaveBeenCalledTimes(1) })
    expect(screen.getByText('Plan Review')).toBeTruthy()
    expect(screen.getByText('Implementation')).toBeTruthy()
    expect(screen.getByText('Code Review')).toBeTruthy()
    expect(screen.queryByText('Planner')).not.toBeTruthy()
  })

  it('switches to the Prompts tab, shows all four components, then back to Models', async () => {
    const models = vi.fn(() => Promise.resolve({
      rpcId: 'component-models' as never,
      result: { ok: true as const, value: { groups: [], failures: [] } },
    }))
    mount(models)
    await waitFor(() => { expect(models).toHaveBeenCalledTimes(1) })
    fireEvent.click(screen.getByRole('tab', { name: 'Prompts' }))
    expect(screen.getByText('Planner')).toBeTruthy()
    expect(screen.getByText('Plan Review')).toBeTruthy()
    expect(screen.getByText('Implementation')).toBeTruthy()
    expect(screen.getByText('Code Review')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Models' }))
    expect(screen.getByText('Plan Review')).toBeTruthy()
    expect(screen.queryByText('Planner')).not.toBeTruthy()
  })

  it('saves a role model selection when both dropdowns are set', async () => {
    const models = vi.fn(() => Promise.resolve({
      rpcId: 'component-models' as never,
      result: {
        ok: true as const,
        value: { groups: [{ id: 'acme', name: 'Acme', models: [{ id: 'acme-large', name: 'Acme Large' }] }], failures: [] },
      },
    }))
    const { stub } = mount(models)
    await waitFor(() => { expect(models).toHaveBeenCalledTimes(1) })

    const row = screen.getByText('Plan Review').closest('div')!
    const [providerSelect] = within(row).getAllByRole('combobox')
    fireEvent.change(providerSelect!, { target: { value: 'acme' } })
    await waitFor(() => { expect(stub.set).toHaveBeenCalledTimes(1) })
    expect(stub.set).toHaveBeenCalledWith('planReview', { provider: 'acme', model: '' })
  })

  it('saves extra context when a Prompts textarea blurs with a changed value', async () => {
    const models = vi.fn(() => Promise.resolve({
      rpcId: 'component-models' as never,
      result: { ok: true as const, value: { groups: [], failures: [] } },
    }))
    const { stub } = mount(models)
    fireEvent.click(screen.getByRole('tab', { name: 'Prompts' }))
    const textareas = screen.getAllByPlaceholderText('Optional context to add\u2026')
    const plannerTextarea = textareas[0]!
    fireEvent.change(plannerTextarea, { target: { value: 'Always check the CHANGELOG first.' } })
    fireEvent.blur(plannerTextarea)
    await waitFor(() => { expect(stub.set).toHaveBeenCalledTimes(1) })
    expect(stub.set).toHaveBeenCalledWith('context', expect.objectContaining({
      planner: 'Always check the CHANGELOG first.',
    }))
  })

  it('shows the read-only notice when the settings document is not writable', async () => {
    const models = vi.fn(() => Promise.resolve({
      rpcId: 'component-models' as never,
      result: { ok: true as const, value: { groups: [], failures: [] } },
    }))
    const stub = stubSettingsScope<ReturnType<typeof emptyDevModePipelineSection>>()
    const store = new DevModePipelineSettingsStore({ models }, stub.scope)
    stub.publish({ status: 'ready', writable: false, value: emptyDevModePipelineSection(), revision: 1 })
    const useSnapshot = bindSnapshotSelector(store.store)
    render(<DevModePipelineSection controller={store} useSnapshot={useSnapshot} t={translate} />)
    expect(await screen.findByText('The settings document is read-only in this deployment.')).toBeTruthy()
  })

  it('shows a retry action when the model catalog load fails', async () => {
    const models = vi.fn(() => Promise.reject(new Error('catalog unreachable')))
    mount(models)
    expect(await screen.findByText('Loading the model catalog failed: catalog unreachable')).toBeTruthy()
    const retry = screen.getByText('Retry')
    fireEvent.click(retry)
    await waitFor(() => { expect(models).toHaveBeenCalledTimes(2) })
  })

  it('falls back to an empty role draft and empty context before the settings scope resolves', async () => {
    const models = vi.fn(() => Promise.resolve({
      rpcId: 'component-models' as never,
      result: { ok: true as const, value: { groups: [], failures: [] } },
    }))
    const stub = stubSettingsScope<ReturnType<typeof emptyDevModePipelineSection>>()
    const store = new DevModePipelineSettingsStore({ models }, stub.scope)
    // No publish: the scope stays in its initial `loading` state, so
    // `state.section` is undefined.
    const useSnapshot = bindSnapshotSelector(store.store)
    render(<DevModePipelineSection controller={store} useSnapshot={useSnapshot} t={translate} />)
    await waitFor(() => { expect(models).toHaveBeenCalledTimes(1) })
    const providerSelect = screen.getAllByRole('combobox')[0] as HTMLSelectElement
    expect(providerSelect.value).toBe('')
    fireEvent.click(screen.getByRole('tab', { name: 'Prompts' }))
    const textarea = screen.getAllByPlaceholderText('Optional context to add\u2026')[0] as HTMLTextAreaElement
    expect(textarea.value).toBe('')
  })

  it('saves a role model selection when the model dropdown changes with a provider already set', async () => {
    const models = vi.fn(() => Promise.resolve({
      rpcId: 'component-models' as never,
      result: {
        ok: true as const,
        value: { groups: [{ id: 'acme', name: 'Acme', models: [{ id: 'acme-large', name: 'Acme Large' }] }], failures: [] },
      },
    }))
    const section = emptyDevModePipelineSection()
    section.implement = { provider: 'acme', model: '' }
    const { stub } = mount(models, section)
    await waitFor(() => { expect(models).toHaveBeenCalledTimes(1) })

    const row = screen.getByText('Implementation').closest('div')!
    const [, modelSelect] = within(row).getAllByRole('combobox')
    fireEvent.change(modelSelect!, { target: { value: 'acme-large' } })
    await waitFor(() => { expect(stub.set).toHaveBeenCalledTimes(1) })
    expect(stub.set).toHaveBeenCalledWith('implement', { provider: 'acme', model: 'acme-large' })
  })

  it('surfaces a role save failure without losing the attempted draft', async () => {
    const models = vi.fn(() => Promise.resolve({
      rpcId: 'component-models' as never,
      result: {
        ok: true as const,
        value: { groups: [{ id: 'acme', name: 'Acme', models: [] }], failures: [] },
      },
    }))
    const { stub } = mount(models)
    await waitFor(() => { expect(models).toHaveBeenCalledTimes(1) })
    stub.set.mockRejectedValueOnce(new Error('write refused'))

    const row = screen.getByText('Plan Review').closest('div')!
    const [providerSelect] = within(row).getAllByRole('combobox')
    fireEvent.change(providerSelect!, { target: { value: 'acme' } })
    expect(await screen.findByText('Save failed: write refused')).toBeTruthy()
  })

  it('surfaces a role save failure whose rejection is not an Error instance', async () => {
    const models = vi.fn(() => Promise.resolve({
      rpcId: 'component-models' as never,
      result: {
        ok: true as const,
        value: { groups: [{ id: 'acme', name: 'Acme', models: [] }], failures: [] },
      },
    }))
    const { stub } = mount(models)
    await waitFor(() => { expect(models).toHaveBeenCalledTimes(1) })
    stub.set.mockRejectedValueOnce('plain rejection')

    const row = screen.getByText('Plan Review').closest('div')!
    const [providerSelect] = within(row).getAllByRole('combobox')
    fireEvent.change(providerSelect!, { target: { value: 'acme' } })
    expect(await screen.findByText('Save failed: plain rejection')).toBeTruthy()
  })

  it('follows a fresh Host role section while the row has no unsaved draft', async () => {
    const models = vi.fn(() => Promise.resolve({
      rpcId: 'component-models' as never,
      result: {
        ok: true as const,
        value: { groups: [{ id: 'acme', name: 'Acme', models: [] }], failures: [] },
      },
    }))
    const { stub } = mount(models)
    await waitFor(() => { expect(models).toHaveBeenCalledTimes(1) })

    const next = emptyDevModePipelineSection()
    next.planReview = { provider: 'acme', model: '' }
    stub.publish({ value: next, revision: 2 })
    await waitFor(() => {
      const row = screen.getByText('Plan Review').closest('div')!
      const [providerSelect] = within(row).getAllByRole('combobox') as HTMLSelectElement[]
      expect(providerSelect!.value).toBe('acme')
    })
  })

  it('shows the Prompts read-only notice when the settings document is not writable', () => {
    const models = vi.fn(() => Promise.resolve({
      rpcId: 'component-models' as never,
      result: { ok: true as const, value: { groups: [], failures: [] } },
    }))
    const stub = stubSettingsScope<ReturnType<typeof emptyDevModePipelineSection>>()
    const store = new DevModePipelineSettingsStore({ models }, stub.scope)
    stub.publish({ status: 'ready', writable: false, value: emptyDevModePipelineSection(), revision: 1 })
    const useSnapshot = bindSnapshotSelector(store.store)
    render(<DevModePipelineSection controller={store} useSnapshot={useSnapshot} t={translate} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Prompts' }))
    expect(screen.getByText('The settings document is read-only in this deployment.')).toBeTruthy()
  })

  it('does not save when a Prompts textarea blurs without a changed value', async () => {
    const models = vi.fn(() => Promise.resolve({
      rpcId: 'component-models' as never,
      result: { ok: true as const, value: { groups: [], failures: [] } },
    }))
    const { stub } = mount(models)
    fireEvent.click(screen.getByRole('tab', { name: 'Prompts' }))
    const textarea = screen.getAllByPlaceholderText('Optional context to add\u2026')[0]!
    fireEvent.blur(textarea)
    expect(stub.set).not.toHaveBeenCalled()
  })

  it('surfaces a context save failure', async () => {
    const models = vi.fn(() => Promise.resolve({
      rpcId: 'component-models' as never,
      result: { ok: true as const, value: { groups: [], failures: [] } },
    }))
    const { stub } = mount(models)
    stub.set.mockRejectedValueOnce(new Error('context write refused'))
    fireEvent.click(screen.getByRole('tab', { name: 'Prompts' }))
    const textarea = screen.getAllByPlaceholderText('Optional context to add\u2026')[0]!
    fireEvent.change(textarea, { target: { value: 'new context' } })
    fireEvent.blur(textarea)
    expect(await screen.findByText('Save failed: context write refused')).toBeTruthy()
  })

  it('surfaces a context save failure whose rejection is not an Error instance', async () => {
    const models = vi.fn(() => Promise.resolve({
      rpcId: 'component-models' as never,
      result: { ok: true as const, value: { groups: [], failures: [] } },
    }))
    const { stub } = mount(models)
    stub.set.mockRejectedValueOnce('plain rejection')
    fireEvent.click(screen.getByRole('tab', { name: 'Prompts' }))
    const textarea = screen.getAllByPlaceholderText('Optional context to add\u2026')[0]!
    fireEvent.change(textarea, { target: { value: 'new context' } })
    fireEvent.blur(textarea)
    expect(await screen.findByText('Save failed: plain rejection')).toBeTruthy()
  })

  it('follows a fresh Host context while the row has no unsaved draft', async () => {
    const models = vi.fn(() => Promise.resolve({
      rpcId: 'component-models' as never,
      result: { ok: true as const, value: { groups: [], failures: [] } },
    }))
    const { stub } = mount(models)
    fireEvent.click(screen.getByRole('tab', { name: 'Prompts' }))

    const next = emptyDevModePipelineSection()
    next.context = { ...next.context, planner: 'updated from another tab' }
    stub.publish({ value: next, revision: 2 })
    await waitFor(() => {
      const textarea = screen.getAllByPlaceholderText('Optional context to add\u2026')[0] as HTMLTextAreaElement
      expect(textarea.value).toBe('updated from another tab')
    })
  })
})
