/**
 * Terminal interaction providers for the TUI client: the user-questions UI
 * provider (renders `ask_user_question` items and reads selections) and the
 * approval answerer (renders permission requests and reads a decision). Both
 * read through the shared readline via {@link TuiPrompter.askLine}, so they
 * never open a second stream over the same terminal as the chat loop.
 *
 * The host-plane TUI rides the default `'ask'` approval policy; the approval
 * service decides the `'never'` policy before answerers run, so this answerer
 * only ever sees requests the harness wants answered interactively.
 *
 * @module @deepseek-ai/dsh-tui/providers
 */

import type { AskUserQuestionAnswer, AskUserQuestionItem, UserQuestionProvider } from '@deepseek-ai/dsh-user-questions'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'

/** Terminal prompt seam shared by the interaction providers. */
export interface TuiPrompter {
  /** Write a chunk of terminal output. */
  write(chunk: string): void
  /** Ask for one line of input, resolving with the raw line. */
  askLine(prompt: string): Promise<string>
}

/** Render one option line with its 1-based index. */
function optionLine(index: number, label: string, description: string | undefined): string {
  const suffix = description === undefined ? '' : ` — ${description}`
  return `  ${index}. ${label}${suffix}`
}

/**
 * Build the user-questions provider that renders each question and reads the
 * selections. Rendering is intentional and line-based: a question with options
 * asks for a comma/space-separated list of option numbers, an empty reply
 * selects nothing, and an `Other`-style free-text answer is read when the
 * reply is not a pure option list. Multi-select applies; single-select uses the
 * first token.
 *
 * @param prompter - terminal prompt seam.
 * @returns the provider registered with `ctx.userQuestions`.
 */
export function createUserQuestionProvider(prompter: TuiPrompter): UserQuestionProvider {
  return {
    async ask(request) {
      const answers: AskUserQuestionAnswer['answers'] = []
      for (const item of request.questions) {
        answers.push(await answerItem(prompter, item))
      }
      return { answers }
    },
  }
}

/** Render one question and collect its answer across selection/custom text. */
async function answerItem(prompter: TuiPrompter, item: AskUserQuestionItem): Promise<AskUserQuestionAnswer['answers'][number]> {
  prompter.write('\n')
  if (item.header !== undefined) prompter.write(`## ${item.header}\n`)
  prompter.write(`${item.question}\n`)
  if (item.detail !== undefined) prompter.write(`${item.detail}\n`)
  if (item.options !== undefined && item.options.length > 0) {
    item.options.forEach((option, index) => { prompter.write(`${optionLine(index + 1, option.label, option.description)}\n`) })
  }
  const prompt = item.options === undefined
    ? 'Answer: '
    : `Choose ${item.multiSelect === true ? ' (comma/space separated, empty=none)' : ''}: `
  const reply = (await prompter.askLine(prompt)).trim()
  if (item.options === undefined) {
    // Free-text question with no options: everything is custom text.
    return { id: item.id, selected: [], custom: reply }
  }
  const selected: string[] = []
  let custom: string | undefined
  for (const token of reply.split(/[\s,]+/u)) {
    const index = Number(token) - 1
    if (Number.isInteger(index) && index >= 0 && index < item.options.length) {
      const option = item.options[index]
      if (option !== undefined) selected.push(option.label)
    } else if (token !== '') {
      custom = custom === undefined ? token : `${custom} ${token}`
    }
  }
  if (!item.multiSelect && selected.length > 1) {
    // Single-select: keep the first choice and treat the rest as free text.
    custom = `${selected.slice(1).join(' ')}${custom === undefined ? '' : ` ${custom}`}`
    selected.length = 1
  }
  return { id: item.id, selected, ...custom === undefined ? {} : { custom } }
}

/** Render a permission decision prompt and read a one-key/one-line outcome. */
async function answerApproval(prompter: TuiPrompter, request: ApprovalRequest): Promise<ApprovalOutcome> {
  prompter.write('\n')
  prompter.write(`permission: ${request.toolName}\n`)
  if (request.reason !== undefined) prompter.write(`${request.reason}\n`)
  for (;;) {
    const reply = (await prompter.askLine('Allow once (a), reject (r), cancel (c): ')).trim().toLowerCase()
    if (reply.startsWith('a')) return 'allowed-once'
    if (reply.startsWith('r')) return 'rejected'
    if (reply.startsWith('c')) return 'cancelled'
    prompter.write('reply with a, r, or c\n')
  }
}

/**
 * Build the `approval/request` waterfall listener that asks the human on the
 * terminal and returns the decision, calling `next()` to delegate when the
 * request is not one a terminal can answer for.
 *
 * @param prompter - terminal prompt seam.
 * @returns the listener passed to `ctx.on('approval/request', …)`.
 */
export function createApprovalAnswerer(
  prompter: TuiPrompter,
): (request: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome> {
  return (request: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> => {
    if (request.toolName === '') return next()
    // An aborting request withdraws the question; an outcome must not grant it.
    if (request.signal?.aborted) return Promise.resolve('cancelled')
    return answerApproval(prompter, request)
  }
}
