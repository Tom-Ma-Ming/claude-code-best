# 钉钉 Channel — 在钉钉里指挥 ccb

> 启用方式：`ccb dingtalk login` + `ccb --channels plugin:dingtalk@builtin`
> 接入形态：企业内部应用 + **Stream 模式**（无需公网 IP / 域名 / 内网穿透）

把 ccb 接到钉钉机器人上：在钉钉里发消息 → ccb 干活 → 结果回到钉钉。危险操作会在钉钉里问你 yes/no。

---

## 你需要准备的三个参数

| 参数 | 从哪拿 | 干什么用 |
|------|--------|----------|
| **AppKey** | 应用详情 → 凭证与基础信息 | Stream 长连接鉴权 + 换 access_token |
| **AppSecret** | 应用详情 → 凭证与基础信息 | 同上 |
| **RobotCode** | 应用详情 → 机器人配置 | 每次发消息标识发送方 |

> 多数企业内部应用的 RobotCode 就等于 AppKey。留空时 ccb 会自动用 AppKey 顶上。

---

## 第一步：创建钉钉应用

1. 打开 [open-dev.dingtalk.com](https://open-dev.dingtalk.com)，用**企业管理员账号**登录

2. 顶部菜单 **应用开发** → **企业内部应用** → 右上角 **创建应用**

3. 填写：
   - 应用名称：随意，例如 `ccb`
   - 应用描述：随意
   - 应用图标：随意

4. 创建后进入应用详情页，左侧菜单 **凭证与基础信息**
   → 记下 **AppKey** 和 **AppSecret**（AppSecret 需要点「显示」）

---

## 第二步：添加机器人能力

1. 左侧菜单 **应用能力** → **添加应用能力** → 找到 **机器人** → 添加

2. 进入 **机器人配置**，填写：
   - 机器人名称：例如 `ccb`
   - 机器人简介：随意
   - 消息接收模式：**⚠️ 必须选「Stream 模式」**，不要选「HTTP 模式」

3. 保存后，同一页面会显示 **RobotCode**，记下来

> **为什么必须是 Stream 模式**：HTTP 模式要求钉钉能主动 POST 到你的机器，意味着你需要公网 IP + 域名 + 备案，或者 frp/ngrok 穿透。Stream 模式反过来——你的机器主动拨出一条 WebSocket，钉钉顺着这条连接把消息推下来。笔记本、内网机器、Docker 容器都能直接跑。

---

## 第三步：开权限

左侧菜单 **权限管理**，搜索并勾选：

| 权限点 | 必需 | 说明 |
|--------|------|------|
| `qyapi_robot_sendmsg` | ✅ 必需 | 机器人发消息。不开的话 ccb 收得到但回不了 |
| `qyapi_media_upload` | 图片/文件收发需要 | 上传附件换 media_id |
| `qyapi_get_member` | 可选 | 读取发送者信息，用于日志里显示人名 |

勾完点 **申请权限**。企业内部应用通常即时生效，不需要审批。

---

## 第四步：发布应用

左侧菜单 **版本管理与发布** → **确定发布**。

> 不发布的话机器人在钉钉里搜不到，也收不到消息。这一步很容易漏。

---

## 第五步：在 ccb 里配置

```bash
ccb dingtalk login
```

按提示依次输入 AppKey、AppSecret、RobotCode（RobotCode 留空则等于 AppKey）。

ccb 会先调一次钉钉的 token 接口验证凭据，**验证通过才落盘**——输错了当场就知道，不会等到会话里才发现机器人是哑的。

凭据存在 `~/.ccb/channels/dingtalk/account.json`，权限 600。

随时可以查看状态：

```bash
ccb dingtalk status
```

### 用环境变量代替（适合容器/CI）

不想落盘就用环境变量，优先级高于配置文件：

```bash
export DINGTALK_APP_KEY=dingxxxxxxxx
export DINGTALK_APP_SECRET=xxxxxxxxxxxx
export DINGTALK_ROBOT_CODE=dingxxxxxxxx
```

---

## 第六步：启动会话

```bash
ccb --channels plugin:dingtalk@builtin
```

⚠️ **这个参数每次都要带**，它是命令行 flag，写不进 `settings.json`。嫌麻烦加个 alias：

```bash
# ~/.zshrc
alias ccbd='ccb --channels plugin:dingtalk@builtin'
```

---

## 第七步：配对授权

会话跑起来后，在钉钉里找到你的机器人，发第一条消息。

机器人会回一个 **6 位配对码**——因为企业内部机器人全组织可见，默认不允许陌生人驱动 agent。

在跑 ccb 的机器上另开一个终端确认：

```bash
ccb dingtalk access pair 123456
```

确认后你的后续消息才会真正进入 ccb 会话。

配对管理：

```bash
ccb dingtalk access list            # 看谁被授权了
ccb dingtalk access revoke <staffId> # 撤销
```

### 关掉配对（不推荐）

如果这是你个人的、组织里没别人的机器人，可以关掉访问控制：

```jsonc
// ~/.ccb/channels/dingtalk/access.json
{ "policy": "disabled", "allowFrom": [] }
```

---

## 绑定：让机器人只服务你（或一个群）

配好凭据后还要**绑定**，否则机器人不会响应任何人。

```bash
ccb dingtalk bind
```

它会开一条连接等你发消息，然后把发送者和会话记下来：

- **私聊模式** — 直接给机器人发消息 → 只有你、且只在这个会话里，能驱动 ccb
- **群聊模式** — 把机器人拉进群、@ 它 → 只有这个群能驱动，群里谁能驱动仍由配对管

模式**根据实际收到的消息推断**。想强制的话：

```bash
ccb dingtalk bind --private
ccb dingtalk bind --group
ccb dingtalk unbind
```

> 钉钉没有可扫码打开企业内部应用机器人会话的链接（官方给的办法是在搜索框搜机器人名字），所以这里没有二维码。发一条消息拿到的身份和扫码完全等价。

绑定状态看 `ccb dingtalk status`：

```
Mode:          private
Bound to:      张三 (cidXXXXXX==)
Relay:         prompts, replies, toolStatus, errors
```

**未绑定时机器人拒绝一切**，并在聊天里回一句提示——不用去翻 stderr 才知道为什么没反应。

### 私聊模式为什么两个维度都卡

绑定者在**某个不相干的群**里发言，不算绑定频道，不会驱动会话。只有「绑定的人 + 绑定的会话」同时满足才放行。

## 围观群：驱动方和观众分开

绑定的会话是**驱动方**——它能指挥 agent。此外可以再挂若干**围观群**：它们收到全部镜像，但**群里说什么都不会进 agent**。

```bash
ccb dingtalk mirror add cidXXXXXXXX==   # 加一个围观群
ccb dingtalk mirror list
ccb dingtalk mirror rm cidXXXXXXXX==
```

典型用法：你在私聊里指挥，团队群只看进度。往一个大群里拉机器人时这点很重要——**围观群按构造就是只读的**，不存在「群里有人不小心让它跑了个命令」。

> 拿群的 conversationId：把机器人拉进群 @ 一下，`--debug mcp` 的日志里会打出 `chat_id`。

## 聊天命令

有些问题不必打扰 agent，机器人自己就能答——而且 **agent 忙的时候也能用**：

| 命令 | 作用 |
|---|---|
| `/help` `/帮助` | 命令列表 |
| `/status` `/状态` | 绑定状态、围观群数量、转发开关 |
| `/relay` | 查看转发开关 |
| `/relay on\|off <项>` | 开关某一项，如 `/relay on toolCalls` |

带参数的命令才会吃掉后文，所以 **`/status 一下部署` 仍然是个问题**，不会被当成命令。

### ccb 自己的斜杠命令

频道消息此前被写死 `skipSlashCommands: true`——所有斜杠命令一律禁掉。现在改用 Remote Control 已有的 `bridgeOrigin` 通道，经 `isBridgeSafeCommand()` 过滤后放行：

**可用**：`/compact` `/clear` `/cost` `/summary` `/files`，以及所有 skill（`/skill:xxx`）

**仍然禁止**：会弹出 Ink 界面的命令（`/model` 之类）——终端前没人看着那个选择器。这类命令会返回一句说明而不是静默失败。

## 围观模式：把终端镜像到钉钉

在终端里干活，同时让钉钉那边看到全过程：

```bash
ccb dingtalk hooks install
```

写进 `~/.ccb/settings.json`，装完**重启 ccb 会话**生效。

镜像的内容，各自可开关：

| 类别 | 默认 | 内容 |
|------|------|------|
| `prompts` | 开 | 你在终端输入的指令 |
| `replies` | 开 | ccb 每轮的最终回复 |
| `progress` | 开 | **一次运行最多一条**「还在进行中」，且只在运行超过 20 秒时发 |
| `toolCalls` | **关** | 每个工具调用都播报。很吵，按需开 |
| `errors` | 开 | 轮次因 API 错误中止 |
| `session` | 开 | 会话开始 / 结束（带项目名）|

```bash
ccb dingtalk relay on toolCalls    # 真要看每个工具
ccb dingtalk relay off progress
ccb dingtalk hooks status
ccb dingtalk hooks uninstall
```

### 进度为什么按时长而不按工具数

早期版本对每个工具调用发心跳，哪怕加了节流仍然吵——因为**工具数量不是你关心的东西**。一次跑三十个工具的快速任务不该打扰任何人；真正值得说一声的是「这活儿干了很久还没完」。

所以现在是：一次运行**最多一条**，且只在运行时长超过阈值时发：

```
⏳ 任务还在进行中（45s，12 个工具），完成后会把结果发给你。
```

阈值可调，写进 profile 的 `config.json`：

```jsonc
{ "progressAfterMs": 20000 }   // 0 表示完全关掉
```

时钟锚在 `UserPromptSubmit`（这一轮开始），不是「距上次工具多久」。

> **工具成功完成时不发消息**。成功已经隐含在下一条状态行或最终回复里，再发一遍只会让消息量翻倍。只有失败才通知。

### 为什么工具状态要节流

`PreToolUse` 对**每个**工具调用都触发，而一轮里 agent 常常调用几十个工具——原样转发会把群刷爆。所以做了两层收敛：

1. **45 秒内最多一条** —— 期间的调用折叠进去，显示成 `⏳ 仍在工作（15 个工具）`
2. **不发工具名，更不发参数** —— 详见下方

### 进度消息不会泄露你在干什么

进度消息只报**时长和工具数量**，不带工具名，更不带参数。

这点是有意的：`tool_input` 就是 bash 命令原文、Edit 的改动内容、被写入的文件。把它推进群里等于把工作内容广播给所有围观的人。开了 `toolCalls` 之后同样只报工具名，不报参数。

每次 hook 都是独立进程，所以窗口状态存在 `relay-state.json` 里而不是内存。

还嫌吵就直接关掉：

```bash
ccb dingtalk relay off toolStatus
```

### 群聊模式不会回声

在钉钉里发的指令会注入会话并触发 `UserPromptSubmit`。如果照直转发，就会把你刚发的消息再发回群里——群里每条指令看两遍。

所以转发会跳过**来自本频道**的 prompt（识别注入时的 `<channel source="plugin:dingtalk:...">` 包裹），只转发你在**终端**里输入的内容。

安装器只动自己写的那几条，你已有的 hook 不受影响；重复安装不会产生重复条目；`settings.json` 是坏 JSON 时会**拒绝写入**而不是覆盖掉。

## 多个项目怎么办

**一个钉钉应用对应一个项目。** 每个项目在开放平台建自己的应用（自己的 AppKey），跑自己的 ccb 实例。机器人可以起不同名字（`ccb-项目A`、`ccb-项目B`），在钉钉里一眼能分清。

建应用不麻烦——本文第一步到第四步，一个应用五分钟。

### 不用每次重新登录：用 profile

多个应用意味着多套凭据。**不需要每次切项目重新登录**——每套凭据存成一个 profile：

```bash
ccb dingtalk login --profile projectA    # 输入 A 应用的 AppKey/AppSecret
ccb dingtalk login --profile projectB    # 输入 B 应用的
ccb dingtalk profiles                    # 看有哪些
```

每个 profile 有**独立的目录**，凭据、配对白名单、待配对码互不干扰：

```
~/.ccb/channels/dingtalk/                    默认 profile
~/.ccb/channels/dingtalk/profiles/projectA/  ← account.json + access.json
~/.ccb/channels/dingtalk/profiles/projectB/
```

启动会话时用环境变量选择：

```bash
cd ~/work/projectA
DINGTALK_PROFILE=projectA ccb --channels plugin:dingtalk@builtin
```

环境变量会传给 `ccb dingtalk serve` 子进程，MCP server 据此读对应凭据。

每个项目配一次就一劳永逸（用 direnv 的话写进 `.envrc`）：

```bash
# ~/work/projectA/.envrc
export DINGTALK_PROFILE=projectA
```

或者直接做成别名：

```bash
alias ccb-a='DINGTALK_PROFILE=projectA ccb --channels plugin:dingtalk@builtin'
alias ccb-b='DINGTALK_PROFILE=projectB ccb --channels plugin:dingtalk@builtin'
```

所有子命令都接受 `--profile <name>`：

```bash
ccb dingtalk status --profile projectA
ccb dingtalk access pair 123456 --profile projectA
ccb dingtalk access list --profile projectA
ccb dingtalk login clear --profile projectA
```

不带 `--profile` 也不设 `DINGTALK_PROFILE` 时用默认 profile（就是 `~/.ccb/channels/dingtalk/`），所以老配置继续可用，不用迁移。

> `DINGTALK_STATE_DIR` 仍然优先于 profile，容器/CI 里直接指定目录的用法不受影响。

### 为什么不能一个 AppKey 配多个实例

直觉上似乎可以：一个机器人拉进 N 个群，每个 ccb 实例只处理自己那个群。**这行不通。**

实测（2026-08-17，两条连接共用同一个 AppKey）：

```
[conn B] msgId=4+r2t7H9Rw==  group "..."  conv=yJbKHO+2timzXQ==

到达两条连接: 0    只到一条: 1
```

钉钉**允许**同一 clientId 开多条 Stream 连接，但每条入站消息只投递给**其中一条**——是负载均衡，不是广播。

后果：群 A 的消息可能被投给绑定了群 B 的实例。那个实例按 conversationId 一过滤就把消息**丢弃**了，而群 A 的实例压根没收到。消息永久丢失，且没有任何报错。

### boundConversations 的正确定位

它是**单实例护栏**，不是分片机制：

```jsonc
// ~/.ccb/channels/dingtalk/access.json
{
  "policy": "pairing",
  "allowFrom": ["staff-id"],
  "boundConversations": ["conv-id-a"]
}
```

也可用环境变量：`DINGTALK_CONVERSATION_IDS=conv-a,conv-b`

用途是让一个实例**忽略不该服务的会话**——比如机器人被拉进了十个群，但你只想让它响应其中一个。留空表示处理全部。

> 拿 conversationId 的办法：`ccb --channels plugin:dingtalk@builtin --debug mcp`，在群里发一条消息，日志里的 `chat_id` 就是。

---

## 日常使用

### 单聊

直接给机器人发消息即可。

### 群聊

把机器人加进群，然后 **@它** 才会触发。ccb 会自动剥掉 @提及文本，只把真正的指令喂给模型。

> **注意**：只有「你 ↔ 机器人」的一对一会话才是 `single`。把机器人拉进一个只有两个人的群，钉钉仍然按 `group` 上报（实测见过 `conversationTitle` 为 `"张三,李四"` 的双人群）。所以别用「群里只有我一个人」来判断是不是私聊。

### 模型怎么分辨不同会话

每条入站消息都会带上会话身份，模型据此区分：

```xml
<channel source="plugin:dingtalk:dingtalk"
         chat_id="..."
         sender_id="..."
         conversation_type="single|group"
         conversation_title="后端项目组">
```

MCP server 的 instructions 里明确要求：不同 `chat_id` 是**受众不同的独立会话**，回复必须用所答消息的 `chat_id`，且不得把一个会话的内容复述到另一个会话——群里的人和私聊的人互相看不见。

没有这两个属性时，模型眼里只是两个不透明 ID，回复串台是必然的。

### 远程审批

ccb 要执行危险操作时，钉钉里会收到：

```
Claude Code needs your approval.

Tool: Bash
Reason: Run the test suite
Input: bun test

Reply with: yes abcde
Or deny with: no abcde
```

回复 `yes abcde` 放行，`no abcde` 拒绝。

> 审批只在**发起请求的那个会话**里有效——别人在另一个群里回同样的码不会生效。5 位码 15 分钟过期。

### 图片和文件

**发给 ccb**：直接在钉钉里发图片、文件、语音、视频。ccb 下载到临时目录，把路径放在 channel 标签的 `attachment_path` 上：

```xml
<channel source="plugin:dingtalk:dingtalk" chat_id="..."
         attachment_path="/tmp/ccb-dingtalk-media/1755-report.pdf"
         attachment_type="file">
```

模型据此用 Read 打开——图片会直接看到画面，PDF 会被解析。支持的类型：

| 你发的 | attachment_type |
|---|---|
| 图片 | `image` |
| 文件（PDF/文档等）| `file` |
| 语音 | `voice`（同时带钉钉的转写文字）|
| 视频 | `video` |

> 语音会额外附上钉钉服务端的转写结果，所以哪怕不听音频，模型也能读懂你说了什么。

**ccb 发给你**：模型调 `reply` 时带 `files` 参数，传绝对路径。

---

## 排查

| 现象 | 原因 |
|------|------|
| 启动后钉钉发消息没反应 | 忘了带 `--channels plugin:dingtalk@builtin` |
| 机器人回「not bound yet」 | 还没执行 `ccb dingtalk bind` |
| 私聊有反应、群里没有 | 绑定的是私聊。用 `ccb dingtalk bind --group` 重新绑到群 |
| 终端干活但钉钉没镜像 | 没装 hook，或装完没重启会话（`ccb dingtalk hooks status`）|
| 钉钉刷屏 | `ccb dingtalk relay off toolStatus` |
| 一直只回配对码 | 还没执行 `ccb dingtalk access pair <code>` |
| 收得到但机器人不说话 | 缺 `qyapi_robot_sendmsg` 权限 |
| 机器人在钉钉里搜不到 | 应用没发布（第四步） |
| `[dingtalk] Stream error: ...` | AppKey/AppSecret 错，或消息接收模式没选 Stream |
| 群里 @它没反应 | 机器人没加进群，或应用没发布 |
| 发文件失败 | 缺 `qyapi_media_upload` 权限 |
| 模型说 reply 工具怎么传参都报错、反复重试、退不出会话 | `reply` 被当成延迟工具了。见下 |
| 终端发完消息后，群里 @ 机器人没反应 | 多半是上一条的下游效应：模型卡在重试里，`isQueryActive` 一直为真，队列不消费。修复后重启会话 |

看详细日志：

```bash
ccb --channels plugin:dingtalk@builtin --debug mcp
```

---

### 为什么 reply 必须标记 alwaysLoad

ccb 的 `isDeferredTool()` 是白名单制：不在 `CORE_TOOLS` 里的 MCP 工具**一律延迟加载**，只暴露名字、不暴露参数 schema。

对一般工具这没问题——模型可以先 `SearchExtraTools` 再用。但 `reply` 是**回复入站消息的唯一途径**：消息进来了，模型却调不动回复工具，于是反复重试、会话卡住退不出。

所以渠道工具必须显式声明：

```ts
{
  name: 'reply',
  _meta: { 'anthropic/alwaysLoad': true },
  ...
}
```

`src/services/mcp/client.ts` 读这个字段。有回归测试锁住，新增渠道工具时别忘了。

## 工作原理

```
钉钉服务器
    │  ① ccb 主动拨出 WebSocket（无需公网 IP）
    ▼
runStreamClient (stream.ts)  ──② 收到 CALLBACK 帧，立刻 ACK
    │                            （慢 ACK 会被钉钉重投 → 重复执行）
    ▼
processMessage (monitor.ts)  ──③ 配对检查 → @提及剥离 → 权限回复识别 → 附件下载
    │
    ▼
MCP notification             ──④ 变成 <channel source="plugin:dingtalk:dingtalk" ...>
    │                            注入 ccb 会话
    ▼
模型调 reply 工具             ──⑤ 优先用 sessionWebhook（~1.5h 有效，免 token）
                                 过期后自动回落到 token API
```

| 文件 | 职责 |
|------|------|
| `packages/dingtalk/src/stream.ts` | Stream 长连接、帧路由、断线重连 |
| `packages/dingtalk/src/monitor.ts` | 入站消息处理、配对、权限回复识别 |
| `packages/dingtalk/src/send.ts` | 出站文本/Markdown/文件，超长自动分段 |
| `packages/dingtalk/src/server.ts` | MCP stdio server、`reply` 工具、权限中继 |
| `packages/dingtalk/src/api.ts` | access_token 缓存、钉钉 Open API 调用 |
| `packages/dingtalk/src/pairing.ts` | 访问控制 |
| `src/plugins/bundled/dingtalk.ts` | 注册为内置插件 |

---

## 相关文档

- [Channels 总览](./channels.md) — 所有渠道的通用说明
- [钉钉开放平台文档](https://open.dingtalk.com/document/orgapp/stream) — Stream 模式官方说明
