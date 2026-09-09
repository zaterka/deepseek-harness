/**
 * Line-based flat transcript renderer for the terminal client. It consumes
 * live session events and a resume-time history summary, and writes a single
 * plain-text stream of lines to a destination. Purely presentational: it holds
 * no agent or lifecycle state and is unit-tested against captured event logs.
 * @module @deepseek-ai/dsh-tui/renderer
 */

import type { SessionEvent, TodoItem } from '@deepseek-ai/dsh-session'

/** A destination that consumes one rendered line (without the trailing newline). */
export type LineSink = (line: string) => void

/** A destination that consumes raw output exactly as given, newlines included. */
export type ChunkSink = (chunk: string) => void

/** Prefer a short summary when an argument or result string is enormous. */
function trim(source: string, max = 4_000): string {
  if (source.length <= max) return source
  return `${source.slice(0, max)}\n… [truncated ${source.length - max} chars]`
}

/** Render one todo list snapshot as compact status-prefixed lines. */
function todoLines(todos: readonly TodoItem[]): string[] {
  const marks: Record<TodoItem['status'], string> = { pending: '-', in_progress: '>', completed: 'x' }
  return todos.map(todo => `  ${marks[todo.status]} ${todo.content}`)
}

/**
 * Reduce a resume-time history into compact transcript text, collapsing past
 * multi-chunk turns into their final assistant text. Accepts the persisted
 * event log and narrows the surface types it understands.
 * @param events - the persisted event log of a resumed session.
 * @returns the compact history to show after resumed (already split into lines).
 */
export function summarizeHistory(events: readonly SessionEvent[]): string[] {
  const lines: string[] = []
  for (const event of events) {
    switch (event.type) {
      case 'user/message':
        if (event.data.source.kind === 'user') {
          const text = event.data.content.map(block => block.type === 'text' ? block.text : '').join('')
          if (text !== '') lines.push(`> ${text}`)
        }
        break
      case 'assistant/message': {
        const text = event.data.message.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('')
        if (text !== '') lines.push(text)
        break
      }
      case 'todo/write':
        lines.push(...todoLines(event.data.todos))
        break
      default:
        break
    }
  }
  return lines
}

/**
 * Live transcript renderer for one session. Assistant text streams as raw
 * chunks so a multi-delta reply reads as continuous prose that the terminal
 * wraps, while tool cards and boundaries are whole lines.
 *
 * The renderer tracks whether the current line is mid-text so it can close a
 * streamed paragraph before writing the next whole-line card.
 */
export class TranscriptRenderer {
  /** Destination for raw output, which may be a partial line. */
  private readonly write: ChunkSink
  /** Whether the input stream is an interactive terminal that echoes typing. */
  private readonly isTTY: boolean
  /** Active turn number whose stream is being rendered, when any. */
  private activeTurn: number | undefined
  /** Output-token budget used to avoid an unbounded streaming tail. */
  private chunksRendered = 0
  /** Whether streamed text left the cursor mid-line. */
  private midLine = false

  /**
   * Create a renderer writing to `write`.
   * @param write - destination for raw output, newlines included by the caller.
   * @param isTTY - whether the terminal already echoes typed input, in which
   *   case the renderer does not echo `user/message` a second time.
   */
  constructor(write: ChunkSink, isTTY = false) {
    this.write = write
    this.isTTY = isTTY
  }

  /** Close a streamed paragraph so the next whole line starts cleanly. */
  private closeLine(): void {
    if (!this.midLine) return
    this.write('\n')
    this.midLine = false
  }

  /** Write one whole line, closing any open streamed text first. */
  private emit(line: string): void {
    this.closeLine()
    this.write(`${line}\n`)
  }

  /**
   * Reduce one live session event into rendered lines. Streaming output writes
   * text deltas as they arrive (minus an output budget); tool calls and
   * boundaries render as distinct cards. Unknown event types are skipped
   * without failing the turn.
   * @param event - one event from the live session log.
   */
  onEvent(event: SessionEvent): void {
    switch (event.type) {
      case 'turn/start':
        this.activeTurn = event.data.turn
        break
      case 'turn/end':
        if (event.data.reason.kind === 'error') {
          this.emit(`  ✗ ${event.data.reason.error.code}: ${event.data.reason.error.message}`)
        }
        this.activeTurn = undefined
        // Close the streamed reply and leave one blank line between exchanges.
        this.closeLine()
        this.write('\n')
        break
      case 'assistant/chunk': {
        if (this.activeTurn === undefined || this.chunksRendered >= 1_024) break
        this.chunksRendered += 1
        if (event.data.chunk.type === 'text-delta' && event.data.chunk.text !== '') {
          // Raw write: a reply arrives as many deltas that must read as one
          // continuous paragraph the terminal wraps, not one line per token.
          this.write(event.data.chunk.text)
          this.midLine = true
        }
        break
      }
      case 'assistant/message': {
        const text = event.data.message.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('')
        // Only render the whole message when nothing streamed for this step,
        // so a non-streaming adapter still shows its reply exactly once.
        if (text !== '' && this.chunksRendered === 0) this.emit(text)
        this.chunksRendered = 0
        break
      }
      case 'tool/call':
        this.emit(`  → ${event.data.name}(…)`)
        break
      case 'tool/result': {
        const text = event.data.message.content
          .map(block => block.content)
          .flat()
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('')
        this.emit(`  ← ${event.data.error === undefined ? 'ok' : `${event.data.error.code}: error`}`)
        if (text !== '') this.emit(trim(text))
        break
      }
      case 'todo/write':
        if (event.data.todos.length > 0) {
          for (const line of todoLines(event.data.todos)) this.emit(line)
        }
        break
      case 'user/message':
        // An interactive terminal already echoed the typed line at the prompt,
        // so echoing it again would duplicate it. A non-TTY (piped or scripted)
        // stdin never echoes, so the transcript needs this line to stay readable.
        if (!this.isTTY && event.data.source.kind === 'user') {
          const text = event.data.content.map(block => block.type === 'text' ? block.text : '').join('')
          if (text !== '') this.emit(`> ${text}`)
        }
        break
      default:
        // Unknown, ignorable, or log-only boundary event — nothing to render.
        break
    }
  }
}
