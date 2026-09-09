# Agent Note: Interactive terminal UI (`dsh --profile tui`)

Status: implemented

English | [中文](2026-09-04-interactive-terminal-ui.zh.md)

## Problem

DeepSeek Harness's shipped interactive surfaces were Web (browser) and one-shot CLI (`dsh --profile headless`). There was no interactive terminal experience: an operator could not open a persistent REPL, type messages back-to-back, watch an assistant stream and run tools, interrupt a turn, answer permission or ask-user prompts on the spot, and resume a prior session — all from a plain terminal without a browser. The earlier terminal frontend had been deleted as an unshipped product-sized package ([remove the TUI package](../simplification/2026-08-04-remove-tui-package.md)), and that note's reintroduction condition — "a named product or deployment, an explicit package boundary, a concrete interaction provider, and assembled lifecycle and transcript acceptance" — was exactly the work a real terminal surface needed to earn its place.

## Decision

Ship an interactive terminal UI as a `dsh` profile. `dsh --profile tui` (alias `dsh tui`) boots a new `@deepseek-ai/dsh-tui` bundle over the unchanged `dsh-base` and opens a line-based readline REPL on stdout.

Four facts define the shipped surface:

1. **`@deepseek-ai/dsh-tui` is a small in-process bundle at `packages/bundle/tui`, not the product-sized frontend that was deleted.** Its `cordis.patch.yml` rides over the shared `dsh-base` (host-plane composition, the headless pattern) and adds only two rows of its own: `tui-startup` (parses `--resume`/`--provider`/`--model`/`--help` via the app-owned command line and publishes the `tuiStartup` service) and `tui-client` (the terminal client). It contributes no model-facing tools — every tool row comes unchanged from base, so model behavior is identical to the other surfaces. The client is an ordinary Consumer over the existing service seams (`ctx.agents`, `session/event`, `ctx.commands`, `ctx.userQuestions`, `approval/*`, `ctx.llm`) and changes no core service.
2. **The client drives `ctx.agents` directly in-process**: it creates a fresh Agent (or resumes a persisted one) and drives turns with `agent.followup` + `agent.whenIdle()`, flushing the durable session log after each settled turn. The rendered transcript is a flat plain-text stream to stdout — assistant chunks stream as raw deltas so a reply reads as one wrapped paragraph, while tool calls, results, and errors render as compact whole lines — with no screen-management, Ink, spinners, diffs, or multi-panel layout. Turn boundaries are a blank line, not a counter, and the typed line is echoed only when stdin is not a TTY (a terminal already echoes it at the prompt).
3. **The terminal answers both interaction seams, registered synchronously in the client's `apply()` before the loop starts**: a `ctx.userQuestions` provider (render each `AskUserQuestionItem`, list options, read the selection on the same readline) and an `approval/request` answerer (tool name + reason, with allow/reject, honoring `approval/policy`; `never` fails closed with no prompt). Registering before any followup guarantees a live tool call can never hit `NO_PROVIDER`.
4. **Interrupt semantics are Claude-Code-style**: the first Ctrl-C cancels the running turn (`agent.stop()`/cancellation through the loop), and the second Ctrl-C (or `/quit`) exits. This differs from the old browser/headless surfaces on purpose and is the behavior the operator asked for.
5. **The model route is selectable at startup and mid-session, and needs no session event of its own.** `--provider`/`--model` override the composed `ctx.agentDefaultModel` selection for the session; `/model` reports the live route and switches it by mutating the Agent-scoped `ModelSelectionRef` that `installModelSelection` reads at each step, so the live Agent, session id, and history are preserved rather than replaced. Only the provider is validated against `ctx.llm.listProviders()` — a provider catalog is documented as advisory and never governs request routing, so rejecting an uncatalogued but valid model id would refuse legitimate routes. An unregistered `--provider` fails loud at startup because a bad route has no fallback, unlike a missing `--resume` target which sanely degrades to a fresh session. A switch does not call `saveSelection()`, so a session-scoped override never rewrites the deployment default.

The profile template ships in `packages/boot/app-boot` as `tui: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-tui']`, and `apps/cli` adds the `tui` subcommand alias mirroring `web` (`dsh tui` == `--profile tui`).

### Deterministic scripted mode

`tui-client` detects a non-TTY stdin/stdout (`isTTY === false`) and runs in a scripted mode that reads user messages line-by-line from stdin and renders them to stdout — the same in-process code path, minus the interactive readline niceties. This is the deterministic surface the keyless test rides: a real Loader composition boots the client with a scripted mock LLM and a real JSONL persistence backend, drives a turn, flushes, disposes, then boots a second independent tree with `--resume` and asserts the rendered history plus the reused durable id.

## Testing

- **Package tests** cover `startup` flag parsing, the renderer (pure functions over synthetic `SessionEvent` arrays), the slash-command parser, the user-questions provider and approval answerer, the loop, `/model` argument parsing and the shared route validator, and `index` create/resume/fallback/`--provider`/`--model`/exit behavior.
- **Real composition** (`tests/real-composition.spec.ts`) boots a fixture `cordis.yml` through the Loader with the real session/agent/core stack, the real command registry, and the real `dsh-session-persistence-jsonl` backend over a temp directory; the only mock is the scripted LLM adapter. It drives a persist → flush → dispose → resume → second-turn → `/model` switch → third-turn flow across two independent trees and asserts user-visible history, exactly three `turn/start` events, and a `request/header` event with `reason: 'change'` carrying the switched model. This satisfies the product-visible-plugin REAL-composition requirement.

## Alternatives considered

**Reuse the deleted earlier terminal frontend.** Rejected: that package was a product-sized frontend whose only consumer was the project generator, and its terminal sophistication (PTY, panels, timing, XML parsing) had no shipped deployment. The reintroduction starts from the actual host and interaction requirements — a lean in-process client over existing seams — rather than resurrecting that frontend.

**A full-screen Ink/`pi-tui` TUI.** Rejected: screen management, panels, and cursor addressing add complexity with no operator requirement here; a line-based flat render is simpler, survives piped output, and is deterministically snapshot-testable.

**An HTTP/RPC remote client.** Rejected: an in-process client can register providers and answerer directly and ride the event stream, and it is snapshot-testable without a browser or server.

**Make the terminal surface only a Web downgrade (keep the loop headless and ignore stdin).** Rejected: the point of the profile is an interactive REPL with terminal-provided permission and ask-user answers, which a headless loop cannot supply.

**Record a mid-session model switch as its own session event.** Rejected: `EpochHeader.config` already carries the provider and model, and the loop appends `request/header` with `reason: 'change'` whenever the assembled route differs from the folded baseline, so `foldRequestHeader` reconstructs the route in force at any point in the log. A dedicated `model/select` event would duplicate that authoritative source and add a `SessionEventMap` member with no reader, so the "model-visible ⟺ logged" rule is satisfied by the existing header stream instead.

**Replace the Agent to switch models.** Rejected: `ModelSelectionRef.current` is documented as the selection read by the next step entering prompt assembly, and prompt assembly snapshots it into `assembled` so the prompt and the request cannot disagree within a step. Mutating the ref is therefore the sanctioned switch; tearing down the Agent would lose the session id, the live history, and every terminal-owned provider and command registration.

## Consequences

- `dsh --profile tui` and `dsh tui` are now shipped entry points alongside Web and headless; the earlier "no terminal UI package" state of [remove the TUI package](../simplification/2026-08-04-remove-tui-package.md) is superseded for the shipped surface, while that note's rationale — don't over-build a frontend without a deployment — continues to own why this client is deliberately thin.
- Model behavior is shared: because the client adds no tool rows, a TUI session offers the same model-facing roster as the base surface; model-, durable-, and user-visible behavior is covered by the real-composition test rather than a hand-built mock suite.
- The deterministic scripted mode is a new snapshot-test surface for interactive terminal input, previously unavailable (the existing snapshot harness drove headless/ACP transcripts, not readline input).
