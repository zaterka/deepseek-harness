# @deepseek-ai/dsh-tool-dev-mode-pipeline

English | [中文](README.zh.md)

Model-facing tools for the Development Mode pipeline (the `dev-mode` agent preset): per-role model lookup, per-component extra-context lookup, and role-subagent delegation on a role's configured model with its configured extra context prepended. All three read `ctx.devModePipeline` (`@deepseek-ai/dsh-dev-mode-pipeline`) and the last resolves through one configured `ctx.subagents` provider.

## Tools

- `devagent.get-model(role)` — resolve `"planReview" | "implement" | "codeReview"` to its configured `{ provider, model, fromSessionDefault }`. Informational: `devagent.spawn` resolves the same selection internally, so calling this first is optional.
- `devagent.get-context(component)` — resolve `"planner" | "planReview" | "implement" | "codeReview"` to its configured extra context (`''` when unset). The planner component exists because this plugin cannot inject context into the main agent's own turn the way it can prepend a role subagent's prompt; the preset's persona calls this tool at the start of planning instead.
- `devagent.spawn(role, prompt, label?)` — start `role` as a one-shot subagent on the `provider` configured for this plugin instance (default `spawn`), using the role's configured model when both fields are set and the session default otherwise. When the role has configured extra context, it is prepended to `prompt` as `[Configured Development Mode context for <role>]\n<context>\n\n<prompt>`. Awaits the run's result, always disposes the run, and returns `{ ok, role, provider, model, fromSessionDefault, stopReason, text, error? }` — `ok` is `stopReason === 'completed'`; a non-completed result carries the provider's safe diagnostic (or the caught error message) in `error` without failing the tool call itself, so the calling agent can read and react to it. An unknown `role`, a missing calling agent, or a rejected `ctx.subagents.start`/`run.result`/`run.dispose` all resolve to `{ ok: false, error }` for the same reason.

## Config

| Key | Meaning |
|---|---|
| `provider` | The `ctx.subagents` provider name `devagent.spawn` starts children on, default `spawn`. |

## Model Experience

### Tool schemas

#### What the model sees

The generated [`devagent.get-model`](../../../docs/tool-catalog.md#deepseek-aidsh-tool-dev-mode-pipeline), [`devagent.get-context`](../../../docs/tool-catalog.md#deepseek-aidsh-tool-dev-mode-pipeline), and [`devagent.spawn`](../../../docs/tool-catalog.md#deepseek-aidsh-tool-dev-mode-pipeline) schemas.

#### Token effect

Fixed schema cost per parent request: three tool schemas.

#### KV Cache effect

Prefix-stable while this plugin instance's config is unchanged.

### devagent.spawn result

#### What the model sees

The rendered JSON `{ ok, role, provider, model, fromSessionDefault, stopReason, text, error? }`; the child's intermediate steps stay out of the parent.

#### Token effect

The prompt and result remain in parent history until compaction; child working context remains in the child.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **No background or continuable delegation** — `devagent.spawn` always waits in the foreground for one role subagent's result, unlike `@deepseek-ai/dsh-tool-subagent`'s configurable background modes. The pipeline's plan-review/implement/code-review stages are synchronous handoffs by design.
- **No per-child persona or tool filter** — `devagent.spawn` requests no `agentOptions` beyond `provider`/`model`; a role always runs the deployment's default child persona and full tool set.
