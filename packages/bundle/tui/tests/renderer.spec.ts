/**
 * Line-based transcript renderer: live event streaming, history summarization,
 * and the hard output limits. Purely presentational — no agent or lifecycle
 * state, so every path is pinned here against captured event logs.
 */

import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { TranscriptRenderer, summarizeHistory } from '../src/client/renderer.ts'

/** Wrap any data object as a log event without inventing the full envelope. */
function event<K extends SessionEvent['type']>(type: K, data: Extract<SessionEvent, { type: K }>['data']): SessionEvent {
  return { type, data, seq: 0, time: 0 } as SessionEvent
}

/** A user prompt message built through the public message factory. */
function prompt(text: string): SessionEvent {
  return event('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

/** An assistant final message with the given plain text. */
function answer(text: string): SessionEvent {
  return event('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'p', model: 'm' } }),
  })
}

/** A tool-result message whose inner content is a single text block. */
function toolText(text: string): SessionEvent {
  return event('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId: 'c1' as never, content: [{ type: 'text', text }], isError: false }),
  })
}

describe('summarizeHistory', () => {
  it('collapses user prompts, assistant final text, and todo snapshots into compact lines', () => {
    const lines = summarizeHistory([
      prompt('hello'),
      answer('hi there'),
      event('todo/write', { todos: [
        { content: 'pending task', status: 'pending' },
        { content: 'doing now', status: 'in_progress' },
        { content: 'done', status: 'completed' },
      ] }),
      event('turn/start', { turn: 1 }),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(lines).toEqual([
      '> hello',
      'hi there',
      '  - pending task',
      '  > doing now',
      '  x done',
    ])
  })

  it('skips empty assistant text and non-user sources', () => {
    const lines = summarizeHistory([
      event('assistant/message', {
        turn: 1,
        step: 1,
        message: createAssistantMessage({ content: [], source: { provider: 'p', model: 'm' } }),
      }),
      event('user/message', createUserMessage({ content: [], source: { kind: 'plugin', plugin: 'x' } })),
      event('user/message', createUserMessage({ content: [{ type: 'text', text: '' }], source: { kind: 'user' } })),
      event('tool/call', { turn: 1, step: 1, callId: 'c1' as never, name: 'bash', arguments: '[]' }),
    ])
    expect(lines).toEqual([])
  })

  it('extracts only the text blocks of a user message that mixes non-text content', () => {
    const lines = summarizeHistory([
      event('user/message', createUserMessage({
        content: [
          { type: 'text', text: 'run it' },
          { type: 'tool-call', id: 't' as never, name: 'bash', arguments: '{}' },
        ],
        source: { kind: 'user' },
      })),
    ])
    expect(lines).toEqual(['> run it'])
  })
})

describe('TranscriptRenderer', () => {
  /**
   * Capture raw renderer output. The live renderer writes partial lines so a
   * streamed reply stays one paragraph, so these tests assert the rendered
   * text and its line breaks rather than one sink call per line.
   * @param isTTY - whether the terminal echoes typed input already.
   */
  interface Capture {
    /** The renderer under test. */
    renderer: TranscriptRenderer
    /** Raw output exactly as written, partial lines included. */
    raw: string
    /**
     * Rendered whole lines. Whole-line output ends with a newline, so the empty
     * tail it produces is dropped; empty output is no lines at all.
     */
    lines: string[]
  }

  function capture(isTTY = false): Capture {
    let out = ''
    const renderer = new TranscriptRenderer((chunk) => { out += chunk }, isTTY)
    return {
      renderer,
      get raw() { return out },
      get lines() { return out === '' ? [] : out.replace(/\n$/u, '').split('\n') },
    }
  }

  it('renders a full quiet turn: user prompt, final answer, end', () => {
    const cap = capture()
    cap.renderer.onEvent(event('turn/start', { turn: 1 }))
    cap.renderer.onEvent(prompt('what is 2+2?'))
    cap.renderer.onEvent(answer('four'))
    cap.renderer.onEvent(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    // No turn counter: internal bookkeeping is not user-facing.
    expect(cap.lines).toEqual(['> what is 2+2?', 'four', ''])
  })

  it('does not echo the user prompt on an interactive terminal', () => {
    const cap = capture(true)
    cap.renderer.onEvent(event('turn/start', { turn: 1 }))
    cap.renderer.onEvent(prompt('what is 2+2?'))
    cap.renderer.onEvent(answer('four'))
    // readline already echoed the typed line at the prompt.
    expect(cap.raw).not.toContain('> what is 2+2?')
    expect(cap.raw).toContain('four')
  })

  it('streams a multi-delta reply as one continuous paragraph', () => {
    const cap = capture()
    cap.renderer.onEvent(event('turn/start', { turn: 1 }))
    for (const text of ['Hello! I', "'m", ' ready to', ' help.']) {
      cap.renderer.onEvent(event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text } }))
    }
    // The reply must not be broken into one line per delta.
    expect(cap.raw).toBe("Hello! I'm ready to help.")
  })

  it('renders tool calls and results inline', () => {
    const cap = capture()
    cap.renderer.onEvent(event('tool/call', { turn: 1, step: 1, callId: 'c1' as never, name: 'bash', arguments: '[]' }))
    cap.renderer.onEvent(toolText('42'))
    expect(cap.lines).toEqual(['  → bash(…)', '  ← ok', '42'])
  })

  it('renders a failed tool result with its error code', () => {
    const cap = capture()
    cap.renderer.onEvent(event('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: 'c1' as never, content: [{ type: 'text', text: '' }], isError: true }),
      error: { name: 'Err', code: 'E2BIG' },
    }))
    expect(cap.lines).toEqual(['  ← E2BIG: error'])
  })

  it('renders a turn that ends in error', () => {
    const cap = capture()
    cap.renderer.onEvent(event('turn/start', { turn: 2 }))
    cap.renderer.onEvent(event('turn/end', { turn: 2, reason: { kind: 'error', error: { code: 'SERVER', message: 'boom' } } }))
    expect(cap.lines).toEqual(['  ✗ SERVER: boom', ''])
  })

  it('streams text deltas as they arrive within budget', () => {
    const cap = capture()
    cap.renderer.onEvent(event('turn/start', { turn: 1 }))
    cap.renderer.onEvent(event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Hel' } }))
    cap.renderer.onEvent(event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'lo' } }))
    cap.renderer.onEvent(event('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'Hello' }], source: { provider: 'p', model: 'm' } }),
    }))
    expect(cap.lines).toEqual(['Hello'])
  })

  it('drops a delta once the per-turn chunk budget is exceeded', () => {
    const cap = capture()
    cap.renderer.onEvent(event('turn/start', { turn: 1 }))
    for (let i = 0; i < 1_026; i += 1) {
      cap.renderer.onEvent(event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } }))
    }
    // The first 1024 render; the 1025th and beyond are dropped.
    // Deltas stream contiguously, so the budget shows as 1024 characters.
    expect(cap.raw).toBe('x'.repeat(1_024))
  })

  it('sends no final text when chunks already streamed', () => {
    const cap = capture()
    cap.renderer.onEvent(event('turn/start', { turn: 1 }))
    cap.renderer.onEvent(event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hi' } }))
    cap.renderer.onEvent(event('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'hi' }], source: { provider: 'p', model: 'm' } }),
    }))
    expect(cap.lines).toEqual(['hi'])
  })

  it('truncates oversized tool results', () => {
    const cap = capture()
    cap.renderer.onEvent(event('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: 'c1' as never, content: [{ type: 'text', text: '' }], isError: true }),
      error: { name: 'Err', code: 'BIG' },
      meta: { original: 'x'.repeat(5_000) },
    }))
    // The text block is empty, so only the ok/error card appears.
    expect(cap.lines).toEqual(['  ← BIG: error'])
  })

  it('defaults to skipping unknown and log-only event types', () => {
    const cap = capture()
    cap.renderer.onEvent({ type: 'unknown/marker', data: {} } as unknown as SessionEvent)
    cap.renderer.onEvent(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    expect(cap.lines).toEqual([''])
  })

  it('drops a text delta when no turn stream is active', () => {
    const cap = capture()
    cap.renderer.onEvent(event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'stray' } }))
    expect(cap.lines).toEqual([])
  })

  it('skips an empty text delta without spending the chunk budget', () => {
    const cap = capture()
    cap.renderer.onEvent(event('turn/start', { turn: 1 }))
    cap.renderer.onEvent(event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '' } }))
    // The empty delta renders nothing and does not consume the budget.
    expect(cap.lines).toEqual([])
  })

  it('truncates oversized tool result text with a trimmed marker', () => {
    const cap = capture()
    cap.renderer.onEvent(toolText('x'.repeat(4_100)))
    // The trimmed marker itself contains a newline, so assert the raw text.
    expect(cap.raw).toBe(`  ← ok\n${'x'.repeat(4_000)}\n… [truncated 100 chars]\n`)
  })

  it('ignores a user message whose content is not text', () => {
    const cap = capture()
    cap.renderer.onEvent(event('user/message', createUserMessage({
      content: [{ type: 'tool-call', id: 't' as never, name: 'bash', arguments: '{}' }],
      source: { kind: 'user' },
    })))
    expect(cap.lines).toEqual([])
  })

  it('ignores an empty todo snapshot', () => {
    const cap = capture()
    cap.renderer.onEvent(event('todo/write', { todos: [] }))
    expect(cap.lines).toEqual([])
  })

  it('renders a non-empty todo snapshot inline', () => {
    const cap = capture()
    cap.renderer.onEvent(event('todo/write', { todos: [
      { content: 'pending task', status: 'pending' },
      { content: 'doing now', status: 'in_progress' },
    ] }))
    expect(cap.lines).toEqual(['  - pending task', '  > doing now'])
  })

  it('ignores a user message whose source is not the user', () => {
    const cap = capture()
    cap.renderer.onEvent(event('user/message', createUserMessage({
      content: [{ type: 'text', text: 'tool said' }],
      source: { kind: 'plugin', plugin: 'x' },
    })))
    expect(cap.lines).toEqual([])
  })
})
