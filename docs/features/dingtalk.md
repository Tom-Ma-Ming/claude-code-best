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

## 日常使用

### 单聊

直接给机器人发消息即可。

### 群聊

把机器人加进群，然后 **@它** 才会触发。ccb 会自动剥掉 @提及文本，只把真正的指令喂给模型。

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

- **发给 ccb**：直接在钉钉里发图片/文件，ccb 会下载到临时目录并把路径告诉模型
- **ccb 发给你**：模型调 `reply` 工具时带 `files` 参数即可

---

## 排查

| 现象 | 原因 |
|------|------|
| 启动后钉钉发消息没反应 | 忘了带 `--channels plugin:dingtalk@builtin` |
| 一直只回配对码 | 还没执行 `ccb dingtalk access pair <code>` |
| 收得到但机器人不说话 | 缺 `qyapi_robot_sendmsg` 权限 |
| 机器人在钉钉里搜不到 | 应用没发布（第四步） |
| `[dingtalk] Stream error: ...` | AppKey/AppSecret 错，或消息接收模式没选 Stream |
| 群里 @它没反应 | 机器人没加进群，或应用没发布 |
| 发文件失败 | 缺 `qyapi_media_upload` 权限 |

看详细日志：

```bash
ccb --channels plugin:dingtalk@builtin --debug mcp
```

---

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
