# `@deepseek-ai/dsh-tui`

[English](README.md) | 中文

dsh 交互式终端组合包，通过 `dsh --profile tui`（别名 `dsh tui`）启动。[`cordis.patch.yml`](cordis.patch.yml) 直接叠加在 [`dsh-base`](../base/README.zh.md) 之上，与 [`dsh-headless`](../headless/README.zh.md) 采用相同的宿主层组合方式：提供编码 persona 和工具模式、禁用 HMR（热模块替换）、将 Code Mode 的 worker 挂载为核心执行能力，并插入 `tool-ask-user` 以及本包自己的两个插件——`tui-startup`（`@deepseek-ai/dsh-tui/startup`，从注入的 `cmdlineArgs` 解析）和 `tui-client`（`@deepseek-ai/dsh-tui`，配置为 `{resumeSessionId, provider, model}`，从注入的 `tuiStartup` 提供方解析）。它不挂载任何 Host、HTTP server、Web runtime 或浏览器插件。

启动提供方（[`src/startup.ts`](src/startup.ts)）解析可选的 `--resume <sessionId>`、`--provider <provider>` 与 `--model <model>` 参数，以及本应用自己的 `--help`，随后发布 `tuiStartup`；缺失的参数解析为 `undefined`，而不是某个默认值。client 注入该服务，并从惰性字段中读取其配置，因此在参数解析完成之前不会创建任何 Agent（智能体），`dsh --profile tui --help` 也不会启动任何 session。启动时，client 通过 `ctx.agents` 创建一个全新的持久化 Agent；如果 `--resume` 指定的 session 仍在注入的 `sessionPersistence` 列表中，则先检视并渲染该 session 的紧凑历史记录，再通过注册表自身的持久化 `prepare()` 恢复它；如果 `--resume` 指定的目标已不在持久化列表中，则回退为全新 session，并向 stderr 写入一条警告。`--provider` 与 `--model` 只为当前 session 覆盖共享的 [`ctx.agentDefaultModel`](../../core/agent-default-model/README.zh.md) 选择结果；未注册的 `--provider` 会写出一条列明已注册路由的诊断信息并以非零码退出，因为错误的路由没有合理的回退。循环准备就绪后，client 会打印 `session: <id>`。

空闲时，循环在 [`node:readline`](https://nodejs.org/api/readline.html) REPL（读取-求值-打印循环）上显示 `❯ ` 提示符。输入一行文本即成为一次用户轮次：它通过 `followup(userMessage)` 提交给当前存活的 Agent，随后循环等待 `whenIdle()` 完成后再重新显示提示符。轮次进行期间，assistant 文本以原始 `assistant/chunk` 增量流式输出到 stdout，因此由多个增量组成的回复会呈现为终端自动折行的连续段落，而不是每个 token 占一行；若某个 step 没有流式内容，则回退为打印其完整的 `assistant/message` 文本。工具调用与结果打印为紧凑的单行卡片（`→ name(…)`、`← ok`/`← <code>: error`），并会先结束尚未闭合的流式段落。轮次边界渲染为交流之间的一个空行，不含轮次计数器。在交互式终端中不会重复回显已输入的那一行，因为 readline 已在提示符处显示过；而非 TTY（管道或脚本化）的 stdin 不会回显，因此那里的记录会为每条用户消息加上 `> ` 前缀。以 `/` 开头的一行不会开启轮次，而是通过共享的 [`ctx.commands`](../../interaction/commands/README.zh.md) 注册表分发：`/help`、`/status`、`/clear`、`/quit`、`/exit` 均在此运行，任何已组合插件注册的命令（`/plan`、`/compact` 等）亦然；`/model` 会报告当前的 `provider/model` 路由；给定 `[provider/]model` 时，它通过改写 [`installModelSelection`](../../core/agent/src/model-selection.ts) 在每个 step 读取的 Agent 作用域选择结果，为下一轮次切换路由——因此存活的 Agent、其 session id 与历史记录得以保留而非被替换，并且循环自身的 `request/header` 事件会把变更后的路由记入持久日志。只有 provider 会针对已注册路由做校验，因为 provider 目录仅供参考、从不决定请求路由，所以未收录但有效的 model id 仍必须被接受；`/resume` 会回答该命令在会话进行中不可用，并指向 `--resume` 启动参数，因为在不重启 client 的情况下替换存活的 Agent handle 超出了范围。权限请求与 `ask_user_question` 提示同样渲染在这同一个终端上，经由本 client 注册的 [`ctx.userQuestions`](../../interaction/user-questions/README.zh.md) 提供方与一个 `approval/request` waterfall 监听器实现，两者都从循环共享的 readline 接口读取回答，而不会在该终端上再打开第二条流。轮次进行中按下 Ctrl-C 会取消该 agent 并返回提示符；空闲时再按 Ctrl-C 会在第一次按下时给出 `press Ctrl-C again to exit` 警告后退出。每次轮次或命令结算后都会 flush 持久化 session 日志（`sessions.flush(agent.session)`），退出请求提交前还会再 flush 一次，因此进度能在之后的强制终止中留存下来。每一次退出请求——空闲状态下两次 Ctrl-C、stdin 上的 EOF、`/quit`、`/exit`，或者在插件边界捕获到的意外驱动失败——都会关闭 readline 接口、释放 `stdin`，通过启动器提供的 `ctx.appExit` 宿主钩子（[`dsh-cmdline`](../../boot/cmdline/README.zh.md)）结算，然后终止进程。这次终止是必需的而非多余：`appExit` 只负责销毁插件树并为事件循环能自行排空的界面设置 `process.exitCode`，而本长驻界面仍保有启动器的信号处理器与 profile patch 文件监视器，否则退出请求只会让进程停在一个已失效的提示符上继续运行。意外失败还会向 stderr 写入 `dsh: <message>`。在 `dsh` 启动器之外启动该 profile、且没有该钩子时，会在激活阶段明确报错。

## 模型体验

无影响，因为 client 把输入的每一行作为普通用户消息提交，并把随之产生的 session 事件渲染到终端上；提示词与工具由已组合的 base 及任何插入行提供。

#### KV Cache 影响

无；client 不向请求前缀添加任何内容。

## 已知限制与暂缓事项

- **`/resume` 仅在启动时可用**：正在运行的 session 无法切换到另一个持久化 session；该命令会以错误回答并指向 `--resume` 参数，因为替换存活的 Agent handle 需要拆卸并重新注册本 client 安装的每一个终端持有的提供方与命令。
- **`/model` 不会改变存储的默认值**：切换仅作用于存活的 session，且从不调用 `agentDefaultModel.saveSelection()`，因此 session 作用域的覆盖不会静默改写部署为后续 Agent 设定的默认值；如需改默认值请通过 settings 设置。
- **`/model` 不校验 model id**：只检查 provider 路由。model id 中的拼写错误由 provider 在请求时报出，而非由命令报出，因为目录仅供参考，拒绝未收录但有效的 id 会误拒合法路由。
- **没有 `reasoningEffort` 参数或命令**：启动选择结果中继承的 reasoning effort 会在 `/model` 切换时保留，但参数与命令都无法设置它；需要特定 effort 的部署应在组合的默认值上设置。
- **单个流式 step 超过 1,024 个 chunk 会丢失尾部内容**：当某个 assistant step 已渲染 1,024 个 chunk 后，renderer 会停止发出 `assistant/chunk` 文本（见 [`TranscriptRenderer`](src/client/renderer.ts)），并且由于此前已渲染过至少一个 chunk，该 step 收尾的 `assistant/message` 文本也不会被打印；这样的超长 step 只会显示其前 1,024 个 chunk。
- **`ctx.appExit` 由启动器持有**：在 `dsh` 启动器之外启动 tui profile 会在激活时明确报错，直到宿主提供该退出请求。
