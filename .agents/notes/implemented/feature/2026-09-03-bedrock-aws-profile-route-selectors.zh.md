# Agent Note: Bedrock 路由在配置里点名 AWS profile

Status: implemented

[English](2026-09-03-bedrock-aws-profile-route-selectors.md) | 中文

## Problem

`providers.amazon-bedrock` 的 profile 过去只有两条认证路径：点名 `apiKeyEnv`，其解析值被 pi-ai 当作 Bedrock 的 bearer token；或者什么都不点名，交给 pi-ai 的环境发现去读宿主进程环境与 `~/.aws`。AWS 访问权是一个 SSO profile 的运维者没有任何配置写法。他们剩下的办法是把 `AWS_PROFILE` 导出到 harness 进程里——那会作用于其中的每条路由和每个 AWS 客户端——或者手写一条 `llm-pi-ai/amazon-bedrock` 下带 `env: { AWS_PROFILE: … }` 的凭据记录，也就是 [`dsh-credentials-local`](../../../../packages/credentials/credentials-local/README.zh.md) 记录的格式、pi-ai 自身交互式登录写入的那一条，而这把一个并非机密的部署选择放进了凭据存储，`settings.yaml` 与 `cordis.yml` 都碰不到它。

## Decision

[`PiAiProviderProfile`](../../../../packages/llm/llm-pi-ai/src/config.ts) 接受两个 AWS 选择器：`awsProfile` 与 `awsRegion`。解析会把它们折叠成解析后 profile 上的一个 `providerEnv`，[适配器](../../../../packages/llm/llm-pi-ai/src/adapter.ts)把它作为请求的 pi-ai `env` 选项传下去，而 pi-ai 会把该值覆盖在宿主进程环境之上，既用于 auth 解析，也用于 Bedrock 客户端。于是 `awsProfile: sso-prod` 以 `AWS_PROFILE` 抵达 AWS SDK，由 SDK 自己的凭据链解析该 profile——包含 SSO 令牌缓存与刷新——路由无需任何已存储凭据即可把自己报告为已配置。

选择两个具名字段而非一个通用 `env` 字典。通用字典会把 pi-ai 的整个 provider 环境概念整体引入，而其中大多数名字并无消费者，还会招致 `AWS_SECRET_ACCESS_KEY` 进入一份只承载引用、从不承载机密的 settings 文档；这两个选择器并非机密，且有当下的消费者。

`awsRegion` 之所以存在，是因为单有 `awsProfile` 只能用在 `us-east-1`：pi-ai 的 Bedrock 客户端从请求环境与模型端点解析 region，而已安装 catalog 的模型全都携带 `https://bedrock-runtime.us-east-1.amazonaws.com`。路由级 `baseURL` 是同一事实的另一种写法，而 region 选项把它显式化，而不是留作一个隐晦技巧。允许单独给出 `awsRegion`：bearer token 与环境凭据链都能完成认证，二者都不携带 region。

两个选择器都会在解析时被拒绝——由 settings 命名空间的校验器执行，因此拒绝落在写入该 section 的地方——只要该路由没有任何模型说 `bedrock-converse-stream`，也就是唯一会读取它们的客户端所用的协议；`awsProfile` 与 `apiKeyEnv` 并列时同样被拒绝，因为解析出的密钥会成为 bearer token 并使请求脱离 SigV4，让 profile 无人读取。两者都不能在无人查阅的地方看起来像已生效。[`catalog.ts`](../../../../packages/llm/llm-pi-ai/src/catalog.ts) 里的 `BEDROCK_API` 被约束到 pi-ai 的 `KnownApi`，因此上游协议改名会让构建失败，而不是无声地撤掉这项检查。

配置界面必须知道*哪些*路由接受这两个字段，而它自己算不出来：settings schema 对该 section 内的每条路由共用同一份档案形状，因此无论那里是否有东西会读取，`awsProfile` 都声明在每条路由的路径上。答案由拥有该路由的适配器按路由给出，经由可配置提供方目录：[`LlmConfigurableProvider`](../../../../packages/llm/llm/src/types.ts) 接受 `nativeAuthFields`，即相对于 `settingsPath` 的档案字段名，表示该路由接受哪些字段用于提供方原生认证；pi-ai 为由 Bedrock 客户端服务的路由填入 AWS 选择器，为其余每条路由填空。该字段随 `ConfigurableProviderView`（[`llm.providers`](../../../../packages/host/apiproxy/src/api/llm.ts)）抵达浏览器，[Models 页面](../../../../packages/client/ui-settings-models/README.zh.md)在收起的自定义折叠区里为每个已声明字段渲染一个输入框，文案按字段名索引。

这份字段名列表刻意与具体提供方无关：`dsh-llm` 是每个适配器家族都会注册进来的 seam，因此它承载的是"该路由据以认证的字段"，而不是 AWS 词汇。客户端持有措辞，而不是决定权——它在渲染前把每个已声明的字段名解析到 section schema 上，因此适配器点名而 schema 并不携带的字段不渲染任何东西，而不是写入一个 `settings.mutate` 会拒绝的键；本页面没有文案的已声明字段名则以字段名自身渲染，而不是把该路由唯一的认证方式藏起来。

## Alternatives considered

**只保留凭据记录这一种写法。** 否决：profile 名是部署选择而非凭据，而那条记录只能手写或由交互式登录写入——组合文件与 settings 层都够不到。

**读取 AWS 共享配置文件，从所点名的 profile 推出默认 region。** 否决：为了运维者一行就能声明的事实，在本适配器内重新实现 SDK 的 ini 与 SSO 解析。

**通用的按路由 `env` 字典。** 出于上述理由否决；确实需要另一个 provider 环境值的部署，会得到一个同等对待的具名字段。

**只要 section schema 声明了字段就渲染。** 否决：那等于每一条 pi-ai 路由，于是 OpenAI 卡片上也会出现一个 AWS profile 输入框，而它唯一的反馈是「应用」之后适配器的拒绝。该页面自己的规则是：卡片只提供其路由能拥有的字段。

**在客户端按提供方 id 判断。** 否决：这会把「哪些路由是 Bedrock」的一份副本放进一个无人能通知其变更的包里，而且若另一个适配器家族以别的路由键服务 Bedrock，则什么都不会渲染。

## Consequences

用 SSO profile 认证的 Bedrock 路由，就是 `cordis.yml` 或 `llm-pi-ai` settings section 里两行的一条 profile，也可以是 Models 页面卡片上的两个字段，不存储凭据，也不需要进程级的 `AWS_PROFILE` 导出。其余每个提供方的卡片都不受影响，因为未声明任何字段的路由一个都不渲染。日后新增提供方原生凭据字段的适配器家族，只要声明它就能抵达该页面，落到客户端的只有措辞。对既不点名 `awsProfile` 也不点名 `awsRegion` 的路由没有任何改变——未设置的选择器不会往请求环境里加键，Bedrock 客户端读到的仍是原本那份环境。

## Testing

[`tests/aws-selectors.spec.ts`](../../../../packages/llm/llm-pi-ai/tests/aws-selectors.spec.ts) 以"环境发现什么都找不到、凭据存储为空"的姿态驱动已安装的 Bedrock 提供方，因此能抵达 AWS SDK 边界本身就说明 pi-ai 的 auth 解析接受了这条无密钥路由；它通过 pi-ai 自己的 `setBedrockProviderModule` 覆盖点观察该边界——Bedrock API 背后那个变量说明符的动态 import 使这里成为唯一可拦截处。三类拒绝（选择器落在非 Bedrock 路由、`awsProfile` 与 `apiKeyEnv` 并列、值为空）通过 `resolveProfiles` 及运行它的命名空间校验器断言。

[`provider-form.client.spec.tsx`](../../../../packages/client/ui-settings-models/tests/provider-form.client.spec.tsx) 覆盖页面一侧：已声明字段以路径操作写入与清空、其占位符显示下层组合层的值、未声明任何字段的路由一个都不渲染、没有文案的已声明字段以字段名自身渲染、section schema 并不携带的字段不渲染任何东西。最后一条由既有的字段清单用例守住——它枚举每张卡片提供的全部控件，因此某个字段漏到别的提供方卡片上就会在那里失败。
