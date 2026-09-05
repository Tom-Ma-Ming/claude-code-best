---
name: devflow-worker
description: Use on a developer machine (a/b/c/d) when a requirement arrives from the coordinator, or when asked to continue a tracked requirement. Follows the review, turns an approved requirement into a dev requirement plus tasks, drives sub-agents through development and testing, and reports for acceptance and release.
---

# devflow worker（研发机 a/b/c/d）

你运行在研发机上。协调机 R 把需求移交给本机后，**这个需求从头到尾归你**。

状态由 `ccb devflow` 命令维护。每个阶段先看状态，再做事，做完就推进状态：

```bash
ccb devflow status <id>
```

## 阶段一：接手与评审跟踪

```bash
ccb devflow accept <id>         # received → accepted
ccb devflow track  <id>         # 查一次评审状态
```

- `review_pending`：评审还没结果。用 CronCreate 建一个定时任务（每 10 分钟）重复 `ccb devflow track <id>`，直到状态变化
- `review_rejected`：用 `reply` 工具通知关联人员被驳回。他们修改后回复「已重新提交」时运行 `ccb devflow resubmit <id>` 并继续跟踪
- `review_approved`：进入阶段二

## 阶段二：建立研发需求与任务

评审通过后，**你**负责拆解。读需求描述（`ccb devflow status <id>` 里的 `requirement.description`），写出任务清单到一个 JSON 文件：

```json
[
  { "title": "数据库迁移：新增 xxx 表", "description": "..." },
  { "title": "后端接口 /api/xxx", "description": "..." },
  { "title": "前端页面", "description": "..." },
  { "title": "单元测试与集成测试", "description": "..." }
]
```

然后一次性创建到管理系统：

```bash
ccb devflow plan <id> --tasks tasks.json
```

成功后状态是 `planned`，输出里有每个任务的 id。用 `reply` 工具把研发需求编号和任务清单发给相关人员。

## 阶段三：开发（多 subagent）

```bash
ccb devflow advance <id> developing
```

- 每个任务派一个 subagent（Agent 工具），提示词包含任务标题、描述、本仓库约定
- 任务开始时 `ccb devflow task <id> <taskId> doing`，完成后 `done`，失败 `failed`
- 互相依赖的任务按顺序，独立的并行
- 全部 done 后进入阶段四

## 阶段四：测试

```bash
ccb devflow advance <id> testing
```

运行项目的测试命令。失败则 `ccb devflow advance <id> developing --note "<失败原因>"` 并派 subagent 修复，修完再回到测试。

## 阶段五：验收与发布

测试通过：

```bash
ccb devflow advance <id> awaiting_acceptance
```

用 `reply` 工具通知相关人员审核成果（附变更摘要、测试结果）。

- 通过：`ccb devflow advance <id> acceptance_passed`，进入发布环节；发布完成 `ccb devflow advance <id> released`
- 不通过：`ccb devflow advance <id> developing --note "<意见>"`，回到阶段三

## 不要做的事

- 不要跳过状态：`advance` 只接受合法的下一步，报错时看提示里的可选状态
- 不要自己编造管理系统里的编号；只用命令输出的
- 需求还在 `review_pending` 时不要开始写代码
