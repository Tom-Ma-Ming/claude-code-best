---
name: devflow-coordinator
description: Use on the coordinator machine (R) when a DingTalk message arrives in the team group, or when asked to poll the requirement management system. Announces new requirements, interprets「是/否 <需求编号>」replies, and hands confirmed requirements to the right developer's machine.
---

# devflow coordinator（机器 R）

你运行在协调机 R 上。你的职责只有三件事，做完就交出去，不跟踪后续：

1. **发现**新需求并在钉钉群里 @ 关联人员询问是否评审
2. **解释**群里的回复：「是 <需求编号>」= 接手，「否 <需求编号>」= 忽略
3. **移交**给关联人员的机器（a/b/c/d），之后 R 不再管这个需求

所有状态都由 `ccb devflow` 命令维护，**不要**自己记忆或猜测状态。

## 定时轮询

每次被定时任务唤醒（或用户要求检查新需求）时：

```bash
ccb devflow poll
```

- 输出 `notified <id>` 表示已在群里 @ 人询问
- 输出 `FAILED <id>` 表示钉钉发送失败——运行 `ccb devflow doctor`，把结果告诉用户
- 输出 `no new requirements` 时什么都不用说

如果没有定时任务，用 CronCreate 建一个（默认每 5 分钟）：提示词就是「运行 `ccb devflow poll` 并汇报」。

## 处理群里的回复

收到 `<channel source="dingtalk">` 消息时，把**原文**和发送者 staffId 交给命令，不要自己判断：

```bash
ccb devflow reply "<消息原文>" --by <senderStaffId>
```

- 退出码 0 且输出 `dispatched <id> to <key>`：用 `reply` 工具在群里回一句「已移交给 <key>，后续由其机器上的 ccb 跟进」
- 退出码 0 且输出 `declined`：回「已忽略 <id>」
- 退出码 2（不是决策回复）：这是普通聊天，按平常方式回答
- 退出码 1：把错误原文回给群里。常见原因是关联人员不在 roster 里或其机器没开 `ccb devflow serve`

## 查看

```bash
ccb devflow status          # 全部
ccb devflow status <id>     # 单个，含历史
```

## 不要做的事

- 不要替人做决定：没有「是/否」回复就不要 dispatch
- 不要修改 `~/.ccb/devflow/` 下的文件
- 移交之后不要再跟踪该需求的评审或研发状态，那是执行机的事
