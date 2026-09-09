/**
 * The module-load `internals` TTY detection. The client reads
 * `process.stdin.isTTY && process.stdout.isTTY` once at import time, so this
 * spec re-imports the module (per-file module isolation) with that input
 * forced interactive to exercise the short-circuit's second operand. All other
 * specs observe the normal non-interactive default.
 */

import { afterEach, describe, expect, it } from 'vitest'

describe('internals TTY detection', () => {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')

  afterEach(() => {
    if (stdinDescriptor !== undefined) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor)
  })

  it('evaluates both TTY operands when the input stream is interactive', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    const mod = await import('../src/index.ts')
    // Forcing the first operand true makes the conjunction read the second
    // stream's TTY flag too, so the detected value tracks stdout.
    expect(mod.internals.isTTY).toBe(process.stdout.isTTY)
  })

  it('terminates through the default exitProcess seam', async () => {
    const mod = await import('../src/index.ts')
    // The default seam is this package's one real `process.exit` call: a
    // long-lived surface needs it because appExit only sets `process.exitCode`.
    // The runner owns the real `process.exit`, so substitute it for this call
    // and restore it immediately, executing the seam's own body.
    const codes: number[] = []
    const owned = Object.getOwnPropertyDescriptor(process, 'exit')
    Object.defineProperty(process, 'exit', {
      value: (code?: number) => { codes.push(code ?? 0) },
      configurable: true,
      writable: true,
    })
    try {
      mod.internals.exitProcess(130)
    } finally {
      if (owned !== undefined) Object.defineProperty(process, 'exit', owned)
    }
    expect(codes).toEqual([130])
  })
})
