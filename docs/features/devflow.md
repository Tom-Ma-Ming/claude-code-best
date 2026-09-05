# devflow — 需求到发布的跨机器流水线

`ccb devflow` 让一台协调机（R）和若干研发机（a/b/c/d）上的 ccb 接力完成一个需求：

```
管理系统 ──poll──▶ R ──钉钉@关联人──▶ 「是 REQ-1」 ──dispatch──▶ a
                                                          │
             评审跟踪 ◀──────────────────────────────────┘
             评审通过 → 建研发需求 + 任务 → subagent 开发 → 测试 → 验收 → 发布
```

R 只负责发现、询问、移交；移交之后不再跟踪。研发机从 `received` 一路负责到 `released`。

## 组成

| 部分 | 位置 | 说明 |
|---|---|---|
| 包 | `packages/devflow/` | 状态机、存储、端口接口、适配器、CLI |
| 入口 | `src/entrypoints/cli.tsx` 中 `args[0] === 'devflow'` | 与 `dingtalk` 相同的快速路径，不加载主 CLI |
| skill | `packages/devflow/skills/devflow-{coordinator,worker}/SKILL.md` | 指导 ccb agent 何时调用哪个命令 |
| 状态 | `~/.ccb/devflow/` | `config.json`、`items/<id>.json`、`events.jsonl` |

### 端口与适配器

业务逻辑（`coordinator.ts` / `worker.ts`）只依赖三个接口：

| 端口 | 现有实现 | 说明 |
|---|---|---|
| `ManagementSystem` | `HttpManagementSystem`、`FileManagementSystem` | 拉新需求、查评审、建研发需求与任务 |
| `Notifier` | `DingtalkNotifier`、`ConsoleNotifier` | 群里 @ 人 |
| `Transport` / `InboxServer` | `HttpTransport`+`HttpInboxServer`、`FileTransport`+`FileInboxServer` | R → 研发机的信封投递 |

对接真实管理系统只改 `adapters/managementHttp.ts` 里的映射函数。

### 状态机

```
协调机   discovered → notified → confirmed → dispatched
                          └──────────┴──────→ declined

研发机   received → accepted → review_pending → review_approved → planned → developing ⇄ testing
                                    ⇅                                                   ↓
                              review_rejected                              awaiting_acceptance ⇄ developing
                                                                                        ↓
                                                                        acceptance_passed → released
```

非法跳转直接报错并列出可选状态。

## 配置

```bash
ccb devflow init --role coordinator   # R
ccb devflow init --role worker        # a/b/c/d
ccb devflow skills install
ccb devflow doctor
```

`~/.ccb/devflow/config.json`（协调机示例）：

```json
{
  "role": "coordinator",
  "machine": "r",
  "managementSystem": {
    "type": "http",
    "baseUrl": "https://pm.example.com/api",
    "token": "...",
    "endpoints": {
      "listNew": "/requirements?status=new&since={since}",
      "reviewStatus": "/requirements/{id}/review",
      "createDevRequirement": "/dev-requirements",
      "createTask": "/dev-requirements/{id}/tasks"
    }
  },
  "dingtalk": { "profile": "team", "conversationId": "cidXXXX" },
  "roster": {
    "a": { "name": "张三", "managementUserId": "u1001", "dingtalkUserId": "staff-a", "endpoint": "http://10.0.0.11:7788", "token": "shared-secret-a" }
  },
  "pollIntervalMs": 300000
}
```

研发机：

```json
{
  "role": "worker",
  "machine": "a",
  "managementSystem": { "type": "http", "baseUrl": "https://pm.example.com/api", "token": "..." },
  "dingtalk": { "profile": "team" },
  "inbox": {
    "host": "0.0.0.0",
    "port": 7788,
    "token": "shared-secret-a",
    "onReceive": { "notify": true, "command": "ccb -p \"/devflow-worker {id}\"" }
  }
}
```

### 管理系统 HTTP 契约（假设，待按实际系统调整）

| 调用 | 期望响应 |
|---|---|
| `GET listNew` | `{ items: [{ id, title, description?, url?, owners: [..], createdAt }] }` 或裸数组 |
| `GET reviewStatus` | `{ status: "pending" \| "approved" \| "rejected" }`（也接受 通过/驳回/passed/failed） |
| `POST createDevRequirement` | `{ id }` |
| `POST createTask` | `{ id, title? }` |

## 运行

协调机：

```bash
ccb devflow poll --watch          # 独立进程轮询；或在 ccb 会话里用 CronCreate 定时 `ccb devflow poll`
ccb devflow reply "是 REQ-1" --by staff-a   # 群里回复到达时由 skill 调用
```

研发机：

```bash
ccb devflow serve                 # 收件箱，常驻
ccb devflow inbox
ccb devflow track REQ-1
ccb devflow plan REQ-1 --tasks tasks.json
ccb devflow advance REQ-1 developing
```

### 单机演练

不需要任何服务器：

```bash
export DEVFLOW_STATE_DIR=/tmp/devflow-r
ccb devflow init --role coordinator
# 把 roster.a.endpoint 改成 /tmp/devflow-inbox-a（目录 = 文件传输）
# managementSystem 用默认的 file 类型，往 <dir>/requirements.json 里放一条需求
DEVFLOW_NOTIFY=console ccb devflow poll
ccb devflow reply "是 REQ-1" --by staff-a

export DEVFLOW_STATE_DIR=/tmp/devflow-a DEVFLOW_INBOX_DIR=/tmp/devflow-inbox-a
ccb devflow init --role worker
ccb devflow serve
```

## 待确认

- 主动发送的 markdown 里 `@staffId` 是否渲染成 @ 提醒（`DingtalkNotifier`）；不行则改为 `sampleText` + `atUserIds`
- 管理系统真实 API 形状
- `onReceive.command` 用无头 `ccb -p` 启动执行机会话的实际参数
