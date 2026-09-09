/**
 * Terminal interaction providers: the user-questions provider and the approval
 * answerer. Both read through a scripted prompter so the option-index, custom
 * text, and decision parsing paths are pinned without a live terminal.
 */

import type { AskUserQuestionItem, AskUserQuestionOption, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it } from 'vitest'
import { createApprovalAnswerer, createUserQuestionProvider, type TuiPrompter } from '../src/client/providers.ts'

/** A prompter that returns the queued replies in order and exposes a live read of output. */
function scripted(replies: string[]): { prompter: TuiPrompter; read(): string } {
  let out = ''
  const prompter: TuiPrompter = {
    write: (chunk) => { out += chunk },
    askLine: async () => replies.shift() ?? '',
  }
  return { prompter, read: () => out }
}

/** One question item with the id required by the answer protocol. */
function item(partial: Partial<AskUserQuestionItem> & { id: string }): AskUserQuestionItem {
  return { question: 'choose', ...partial }
}

function request(questions: AskUserQuestionItem[]): AskUserQuestionRequest {
  return { questions }
}

function approval(partial: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return { agent: {} as Agent, toolName: 'bash', ...partial }
}

describe('createUserQuestionProvider', () => {
  it('answers a free-text question with no options as custom text', async () => {
    const harness = scripted(['Put it in src/'])
    const answer = await createUserQuestionProvider(harness.prompter).ask(request([
      item({ id: 'q1', question: 'Where?', detail: 'a detail', header: 'Note' }),
    ]))
    expect(answer).toEqual({ answers: [{ id: 'q1', selected: [], custom: 'Put it in src/' }] })
    expect(harness.read()).toContain('## Note')
    expect(harness.read()).toContain('Where?')
    expect(harness.read()).toContain('a detail')
  })

  it('selects multi-select options by numeric index and folds unrecognized tokens into custom text', async () => {
    const { prompter } = scripted(['1, 3 extra,2'])
    const answer = await createUserQuestionProvider(prompter).ask(request([
      item({
        id: 'q1',
        question: 'pick',
        multiSelect: true,
        options: [
          { label: 'one', description: 'first' },
          { label: 'two' },
          { label: 'three' },
        ],
      }),
    ]))
    expect(answer).toEqual({ answers: [{ id: 'q1', selected: ['one', 'three', 'two'], custom: 'extra' }] })
  })

  it('keeps only the first choice for single-select and demotes the rest to custom text', async () => {
    const { prompter } = scripted(['2 3'])
    const answer = await createUserQuestionProvider(prompter).ask(request([
      item({
        id: 'q1',
        question: 'pick',
        options: [
          { label: 'one' },
          { label: 'two' },
          { label: 'three' },
        ],
      }),
    ]))
    expect(answer).toEqual({ answers: [{ id: 'q1', selected: ['two'], custom: 'three' }] })
  })

  it('selects nothing on an empty reply and tolerates an empty option list', async () => {
    const { prompter } = scripted([''])
    const answer = await createUserQuestionProvider(prompter).ask(request([
      item({ id: 'q1', question: 'pick', options: [] }),
    ]))
    expect(answer).toEqual({ answers: [{ id: 'q1', selected: [] }] })
  })

  it('folds multiple non-option tokens into one custom answer and skips holes', async () => {
    const { prompter } = scripted(['1 2 3 extra foo'])
    const answer = await createUserQuestionProvider(prompter).ask(request([
      // One option, then a hole at index 1, then another option.
      item({
        id: 'q1',
        question: 'pick',
        multiSelect: true,
        options: [{ label: 'one' }, , { label: 'three' }] as unknown as AskUserQuestionOption[],
      }),
    ]))
    // "2" indexes the hole (skipped), "1" and "3" select, the rest is custom.
    const first = answer.answers[0]!
    expect(first.selected).toEqual(['one', 'three'])
    expect(first.custom).toEqual('extra foo')
  })

  it('demotes extra single-select picks and appends to an existing custom answer', async () => {
    const { prompter } = scripted(['1 2 foo'])
    const answer = await createUserQuestionProvider(prompter).ask(request([
      item({
        id: 'q1',
        question: 'pick',
        options: [{ label: 'one' }, { label: 'two' }, { label: 'three' }],
      }),
    ]))
    const first = answer.answers[0]!
    // "2" demotes to custom, joined after the existing custom token "foo".
    expect(first.selected).toEqual(['one'])
    expect(first.custom).toEqual('two foo')
  })
})

describe('createApprovalAnswerer', () => {
  it('delegates back-line requests with an empty tool name', async () => {
    const answerer = createApprovalAnswerer(scripted([]).prompter)
    const decided = await answerer(approval({ toolName: '' }), async () => 'unavailable')
    expect(decided).toBe('unavailable')
  })

  it('withdraws an aborted request as cancelled without prompting', async () => {
    const harness = scripted([])
    const answerer = createApprovalAnswerer(harness.prompter)
    const signal = new AbortController()
    signal.abort()
    const decided = await answerer(approval({ signal: signal.signal }), async () => 'unavailable')
    expect(decided).toBe('cancelled')
    expect(harness.read()).toBe('')
  })

  it('asks the terminal and returns the decision on a, r, or c', async () => {
    const harness = scripted(['a'])
    const answerer = createApprovalAnswerer(harness.prompter)
    const decided = await answerer(approval({ toolName: 'bash', reason: 'needs exec' }), async () => 'unavailable')
    expect(decided).toBe('allowed-once')
    expect(harness.read()).toContain('permission: bash')
    expect(harness.read()).toContain('needs exec')
  })

  it('re-prompts until a recognized answer and honors reject/cancel', async () => {
    const allowed = createApprovalAnswerer(scripted(['x', 'r']).prompter)
    expect(await allowed(approval(), async () => 'unavailable')).toBe('rejected')

    const cancelled = createApprovalAnswerer(scripted(['c']).prompter)
    expect(await cancelled(approval(), async () => 'unavailable')).toBe('cancelled')
  })
})
