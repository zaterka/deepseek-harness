# @deepseek-ai/dsh-dev-mode-pipeline

English | [中文](README.zh.md)

Per-role model selection and per-component prompt context for the Development Mode pipeline: the settings-backed store the `dev-mode` preset's planner (main agent), plan-review, implementation, and code-review components read from. `DevModePipelineConfig` provides `ctx.devModePipeline`.

The pipeline has four components: `planner` (the session's main agent, stage 1 and the coding-orchestrator half of stage 3), and three spawnable roles — `planReview`, `implement`, `codeReview` — that `@deepseek-ai/dsh-tool-dev-mode-pipeline`'s `devagent_spawn` tool starts as subagents. Each role has an independent model selection; each of the four components has independent extra prompt context.

- `ctx.devModePipeline.modelFor(role, defaultModel)` resolves one role's provider/model: the stored selection when both fields are set, otherwise `defaultModel.currentSelection()` (or an empty selection when no default-model service is mounted). The returned `fromSessionDefault` flag reports which source answered.
- `ctx.devModePipeline.contextFor(component)` returns the stored extra context for one component, or `''` when none is set.
- `ctx.devModePipeline.saveModel(role, selection)` and `ctx.devModePipeline.saveContext(component, context)` persist through the settings namespace `dev-mode-pipeline`. An empty provider or model clears a role override; a mounted settings provider is required for persistence to have any effect, matching `@deepseek-ai/dsh-agent-default-model`'s pattern.

The settings section itself, including the Models and Prompts tabs and the model catalog join, lives in `@deepseek-ai/dsh-client-ui-settings-dev-mode-pipeline`. This package owns only the data and its resolution rules.

`DEV_MODE_BASELINE_PROMPTS` is descriptive text shown next to each component's extra-context field in the settings UI; it is not sent to any model and is not reconstructed into a role subagent's actual prompt, which the calling agent authors itself.

## Model Experience

None, as this service only stores and resolves configuration; the calling agent (`@deepseek-ai/dsh-tool-dev-mode-pipeline`) decides what reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- The service owns one process-wide settings document; there is no per-session override of a role's model or a component's context.
- Without a settings provider, `saveModel()`/`saveContext()` are no-ops and every role stays on the session default.
