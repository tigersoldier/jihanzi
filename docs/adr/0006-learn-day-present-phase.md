# ADR 0006: 学新日增加展示阶段

**日期**：2026-07-07
**状态**：已采纳

---

## 背景

当前学新日流程为：`idle → reviewing（复习到期字 + 学新字）→ roundComplete → celebration`。
到期复习字和新字混在同一队列中，新字首次出现即要求家长评级——此时孩子尚未见过这个字，
评级变得仓促，家长往往凭感觉给分。

理想的学新日应该先让家长引导孩子"看字→写→记"，再进入评级环节。这需要将"展示新字"
从复习流程中分离出来，成为一个独立的、不评级的预习阶段。

## 决策

**在学新日流程中插入 `presenting` 阶段，作为 `idle` 和 `reviewing` 之间的独立阶段。**

### 核心设计

- **状态机**：`idle → presenting → reviewing → roundComplete → celebration`。
  纯复习日跳过 `presenting`，直接进入 `reviewing`。
- **presenting 阶段**：逐字展示今日新字，仅展示不评级。"上一个"/"下一个"按钮
  允许前进和回退，最后一个字显示"开始复习"。不改变任何领域状态（nextCharIndex、
  SM-2 均不变）。
- **reviewing 阶段**：队列为 `[...到期复习字, ...刚展示的新字]`，和现有评级逻辑一致。
- **巩固轮**：两类字的 c/d 合并巩固，不区分来源。

### 任务队列

`startSession()` 时同时拍下两份快照：

- `presentTasks`：展示队列（今日新字）
- `reviewTasks`：复习队列（到期复习字 + 新字）

`presenting` 消费 `presentTasks`，结束后进入 `reviewing` 消费 `reviewTasks`。

### 操作日志

新增 `present_chars` 日志类型，展示完成时写入一条（一批字一条），字段为
`{ type, timestamp, childId, dayKey, characters, wordBookId }`。
`applyEntry` 返回 `false`——不触发快照更新，纯审计用途。去重键 `(timestamp, type, childId)`。

### 轮次语义不变

"轮(Round)"始终指评级轮。`presenting` 不参与轮次计数。第 1 轮仍从 `reviewing` 开始。

## 后果

**优点**：

- 学新日体验更合理：先展示（教）、再复习（考），符合教学规律
- 纯复习日不受影响，状态机路径不变
- 展示不改变领域状态，领域模型不增加新概念
- `present_chars` 日志为将来分析"展示到评级的间隔"提供数据基础

**风险**：

- session 快照从一份变两份，localStorage 持久化和恢复逻辑需要扩展
- `presenting` 阶段家长可能中途退出（刷新/关闭），展示中断后重开需重新展示
  ——因为不改变 nextCharIndex，下次仍然从同一批字开始

## 备选方案

### 方案 B：展示完即推进 nextCharIndex + 预创建 SM-2 状态

展示完最后一个字时立即推进 nextCharIndex 并为每个新字创建初始 SM-2 状态
（interval=0，当天到期）。

- **为什么不选**：引入了一个"未评级但有 SM-2 状态"的中间态，增加了领域模型的
  复杂度。且展示完直接推进意味着"看过=学过"，与现有"评级=学过"的语义不一致。
  把展示保持为纯 UI 层概念更干净。

### 方案 C：将展示融入 reviewing 阶段，通过任务类型区分

不新增 `presenting` 阶段，在 `reviewing` 阶段通过任务 `mode` 字段区分
"展示模式"和"复习模式"。

- **为什么不选**：两种交互模式差异太大（无评级 vs 有评级、左右按钮 vs 评级网格），
  强行放在同一阶段会让 UI 分支逻辑复杂，且 taskIndex 推进需要特殊处理
  "展示最后一个字→开始复习"的过渡，不如独立阶段清晰。
