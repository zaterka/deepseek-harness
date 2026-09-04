# @deepseek-ai/dsh-client-ui-settings-dev-mode-pipeline

English | [中文](README.zh.md)

Development Mode settings page. Registers a `settings.section` (id `dev-mode-pipeline`, nav label "Development Mode") with two internal tabs:

- **Models** — one provider/model picker per spawnable pipeline role (`planReview`, `implement`, `codeReview`), sourced from the host-scoped model catalog (`llm.models`). Choosing "Session default" for either dropdown clears the stored override, so the role reverts to reading the session model at spawn time. The planner and coding-orchestrator stages are the session's own agent and are not configurable here.
- **Prompts** — one row per pipeline component (`planner`, `planReview`, `implement`, `codeReview`) showing that component's read-only baseline prompt text next to an editable "Extra context" field. A changed textarea saves on blur.

Both tabs derive from one `DevModePipelineSettingsStore`, which binds the pipeline's `dev-mode-pipeline` settings namespace through the shared settings scope (`ctx.settingsScope`, `@deepseek-ai/dsh-client-ui-settings`) — the same seam `@deepseek-ai/dsh-client-ui-settings-models` uses for its own namespace — and independently loads the host-scoped model catalog. Every write goes through `SettingsScope.set`, so a concurrent write from another tab or an external `settings.yaml` edit is refused and the store reloads. Once loaded, the page refreshes on pushed `settings/document-updated` and `llm/adapters-updated` owner events, plus local `connection/reset`, exactly as `ui-settings-models` does for its own page.

The pipeline's namespace shape, role/component keys, and baseline prompt copy are mirrored in `src/pipeline-copy.ts` rather than imported from `@deepseek-ai/dsh-dev-mode-pipeline` — the same convention `ui-settings-models`'s `onboarding-copy.ts` follows for its own namespace literal, since a client plugin package depends only on other `@deepseek-ai/dsh-client-*` packages and a few universal wire packages. Update both sides together when the pipeline's keys change.

## Model Experience

None, as the plugin renders browser settings UI; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- The Prompts tab shows only the four fixed pipeline components; a preset that renamed or added roles to `@deepseek-ai/dsh-dev-mode-pipeline` would need this package's copy updated to match.
- A remote (non-loopback) browser cannot write the pipeline's settings namespace at all — the settings scope stays in its `memory` mode and every write is a local no-op, matching every other settings-backed page.
