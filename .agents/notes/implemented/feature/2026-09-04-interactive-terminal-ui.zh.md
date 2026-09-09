# Agent Note: 交互式终端 UI（`dsh --profile tui`）

Status: implemented

[English](2026-09-04-interactive-terminal-ui.md) | 中文

## Problem

DeepSeek Harness 已交付的交互式界面只有 Web（浏览器）与一次性 CLI（`dsh --profile headless`）。缺少交互式终端体验：操作者无法打开一个持久的 REPL、连续输入消息、观看助手流式回复并执行工具、打断一轮对话、就地回答权限或 ask-user 提示，以及在纯终端里无需浏览器就能恢复上一会话。早前的终端前端作为一个未交付、产品级规模的包已被删除（[移除 TUI 包](../simplification/2026-08-04-remove-tui-package.zh.md)），而该记录的重新引入条件——「需要被指名的产品或部署、显式的包边界、具体的交互提供方，以及面向该前端的组装生命周期与 transcript 验收」——恰是真正的终端界面为赢得自身地位所要做的工作。

## Decision

以 `dsh` profile 交付一个交互式终端 UI。`dsh --profile tui`（别名 `dsh tui`）在未改动的 `dsh-base` 之上启动新的 `@deepseek-ai/dsh-tui` bundle，并在 stdout 上打开一个基于行式的 readline REPL。

四项事实界定这个已交付的界面：

1. **`@deepseek-ai/dsh-tui` 是位于 `packages/bundle/tui` 的小型进程内 bundle，不是被删除的那个产品级前端。** 其 `cordis.patch.yml` 骑在共享的 `dsh-base` 之上（宿主平面组合，headless 模式），只额外加入两行自身条目：`tui-startup`（通过应用自有的命令行解析 `--resume`/`--provider`/`--model`/`--help` 并发布 `tuiStartup` 服务）与 `tui-client`（终端客户端）。它不提供任何面向模型的工具——所有工具行都原样来自 base，因此模型行为与其他界面一致。客户端只是既有服务缝（`ctx.agents`、`session/event`、`ctx.commands`、`ctx.userQuestions`、`approval/*`、`ctx.llm`）之上的普通 Consumer，不改动任何核心服务。
2. **客户端直接驱动进程内的 `ctx.agents`**：它创建（或恢复）一个 Agent，并用 `agent.followup` + `agent.whenIdle()` 驱动轮次，在每轮稳定后刷写持久化会话日志。渲染出的 transcript 是发往 stdout 的扁平纯文本流——助手 chunk 以原始增量流式输出，使回复呈现为一个自动折行的段落，而工具调用、结果与错误渲染为紧凑的整行——不做屏幕管理、Ink、spinner、diff 或多面板布局。轮次边界是一个空行而非计数器，并且仅当 stdin 不是 TTY 时才回显已输入的那一行（终端本身已在提示符处回显）。
3. **终端在客户端 `apply()` 中、循环开始前同步注册两个交互缝**：一个 `ctx.userQuestions` 提供方（渲染每个 `AskUserQuestionItem`、列出选项、在同一 readline 上读取选择）与一个 `approval/request` 应答器（工具名 + 原因，提供允许/拒绝，遵循 `approval/policy`；`never` 无提示地失败关闭）。在任何 followup 之前注册，保证存活的工具调用永远不会命中 `NO_PROVIDER`。
4. **中断语义是 Claude-Code 风格**：第一次 Ctrl-C 取消进行中的轮次（经 loop 调用 `agent.stop()`/取消），第二次 Ctrl-C（或 `/quit`）退出。这与老式浏览器/headless 界面对此的取舍不同，也是操作者要求的既定行为。
5. **模型路由可在启动时与会话进行中选择，且无需自己的 session 事件。** `--provider`/`--model` 为该 session 覆盖组合的 `ctx.agentDefaultModel` 选择结果；`/model` 报告当前路由，并通过改写 `installModelSelection` 在每个 step 读取的 Agent 作用域 `ModelSelectionRef` 来切换它，因此存活的 Agent、session id 与历史记录得以保留而非被替换。只有 provider 会针对 `ctx.llm.listProviders()` 校验——provider 目录在文档上仅供参考、从不决定请求路由，因此拒绝未收录但有效的 model id 会误拒合法路由。未注册的 `--provider` 在启动时明确报错，因为错误的路由没有回退；而缺失的 `--resume` 目标可以合理降级为全新 session。切换不会调用 `saveSelection()`，因此 session 作用域的覆盖绝不会改写部署默认值。

profile 模板在 `packages/boot/app-boot` 中以 `tui: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-tui']` 交付，`apps/cli` 加入镜像 `web` 的 `tui` 子命令别名（`dsh tui` 等价于 `--profile tui`）。

### 确定性脚本模式

`tui-client` 检测非 TTY 的 stdin/stdout（`isTTY === false`），并以脚本模式运行：逐行从 stdin 读取用户消息并渲染到 stdout——同一进程内代码路径，只是省去交互 readline 的细节。这是无密钥测试所依赖的确定性表面：一个真实的 Loader 组合以脚本化 mock LLM 与真实 JSONL 持久化后端启动客户端，驱动一轮、flush、dispose，再以 `--resume` 启动第二个独立树，并断言渲染出的历史与复用的持久化 id。

## Testing

- **包测试**覆盖 `startup` 标志解析、渲染器（对合成 `SessionEvent` 数组的纯函数）、斜杠命令解析器、user-questions 提供方与 approval 应答器、loop，`/model` 参数解析与共享路由校验器，以及 `index` 的创建/恢复/回退/`--provider`/`--model`/退出行为。
- **真实组合**（`tests/real-composition.spec.ts`）通过 Loader 以真实会话/agent/核心栈、真实命令注册表及临时目录上的真实 `dsh-session-persistence-jsonl` 后端启动 fixture 的 `cordis.yml`；唯一 mock 是脚本化 LLM adapter。它跨两个独立树驱动持久化 → flush → dispose → 恢复 → 第二轮次 → `/model` 切换 → 第三轮次的流程，并断言用户可见的历史记录、恰好三个 `turn/start` 事件，以及一个携带切换后 model 且 `reason` 为 `change` 的 `request/header` 事件。这满足产品可见插件的 REAL-composition 要求。

## Alternatives considered

**复用被删除的早期终端前端。** 未采纳：该包是一个产品级前端，唯一消费方是项目生成器，其终端复杂度（PTY、面板、计时、XML 解析）没有已交付的部署。恢复工作从真实的宿主与交互需求出发——基于既有缝的轻量进程内客户端——而不是复活那个前端。

**全屏 Ink/`pi-tui` TUI。** 未采纳：屏幕管理、面板与光标寻址增加了此处并无需求的复杂度；基于行式的扁平渲染更简单、能挺过管道输出，并且能确定性快照测试。

**HTTP/RPC 远程客户端。** 未采纳：进程内客户端能直接注册提供方与应答器并骑乘事件流，且无需浏览器或服务器即可快照测试。

**让终端界面只是 Web 的降级（保持 headless 循环并忽略 stdin）。** 未采纳：本 profile 的要点是一个具备终端权限与 ask-user 答案的交互式 REPL，这是 headless 循环无法提供的。

**把会话进行中的模型切换记录为独立的 session 事件。** 未采纳：`EpochHeader.config` 已携带 provider 与 model，并且每当组装出的路由与折叠后的基线不同时，loop 就会追加 `reason` 为 `change` 的 `request/header`，因此 `foldRequestHeader` 能重建日志中任意时点生效的路由。专设 `model/select` 事件会重复该权威来源，并新增一个无读取方的 `SessionEventMap` 成员，所以「模型可见 ⟺ 已记录」规则改由既有的 header 事件流来满足。

**为切换模型而替换 Agent。** 未采纳：`ModelSelectionRef.current` 在文档上即为下一个进入提示词组装的 step 所读取的选择结果，而提示词组装会将其快照到 `assembled`，因此同一 step 内提示词与请求不可能不一致。故改写该 ref 才是既定的切换方式；拆除 Agent 会丢失 session id、存活的历史记录，以及每一个终端持有的提供方与命令注册。

## Consequences

- `dsh --profile tui` 与 `dsh tui` 现在是 Web 与 headless 之外的已交付入口；[移除 TUI 包](../simplification/2026-08-04-remove-tui-package.zh.md)所述「没有终端 UI 包」的状态就已交付界面而言已被取代，而该记录的核心——不要在没有部署的情况下过度造前端——继续约束为何这个客户端刻意做得很薄。
- 模型行为是共享的：由于客户端不增加工具行，TUI 会话提供与 base 界面相同的面向模型名册；模型、持久化与用户可见行为由真实组合测试覆盖，而非手搭的 mock 套件。
- 确定性的脚本模式是交互式终端输入的新快照测试表面，此前不存在（既有快照 harness 驱动的是 headless/ACP transcript，而非 readline 输入）。
