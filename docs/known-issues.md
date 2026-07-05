# 已知问题 (Known Issues)

> 以下问题已通过代码审查发现，但因涉及更深层的架构改动而被推迟修复。每个问题都记录了背景、风险和建议的修复方向。

---

## 1. initialPull 与本地变更的竞争条件

**发现日期**：2026-07-05

**严重度**：高

**文件**：`src/state/AppContext.tsx` 第 115 行附近

### 问题

应用启动时，`loadState` 直接读取快照作为 React state。同时 `SyncContext` 调用
`initialPull()` 从 Drive 下载远程数据。如果用户在 `initialPull` 完成之前进行了
变更（如提交复习），本地快照会被更新。但 `initialPull` 完成后会用远程快照覆盖
本地快照，然后调用 `reloadState` ——导致用户的本地变更在 UI 中消失。

### 为什么这是回归

旧架构（全量重放）不受此影响：`loadState` 读取快照 + 全量日志重放，即使快照被
覆盖，日志重放会恢复所有变更。增量物化后，快照是唯一数据源，日志仅用于同步，
丢失的快照变更无法自动恢复。

### 建议修复

- 方案 A：`initialPull` 合并远程日志时不直接覆盖快照——改为从基点快照重放到
  当前时间戳，然后比较并合并。
- 方案 B：`loadState` 在读取快照后，额外重放快照时间戳之后的本地日志条目，
  确保没有被快照遗漏的变更得到恢复。
- 方案 C：在 `initialPull` 运行时锁定本地变更队列，等同步完成后再应用。
  但这会降低 UX。

### 触发条件

- 应用首次启动或恢复（有 pending 的 Drive sync）
- 用户在启动后几秒内就开始操作（`initialPull` 尚未完成）
- 网络较慢时更容易触发

---

## 2. initialPull 时间戳去重的时钟偏斜风险

**发现日期**：2026-07-05

**严重度**：中

**文件**：`src/data/sync.ts` 第 153 行

### 问题

新代码用时间戳过滤替代了旧的 Set 去重：
```ts
// 旧：逐条目 (timestamp, type, entityId) 去重
const localKeys = new Set(localLogs.map(makeKey))
const newEntries = remoteLogEntries.filter(e => !localKeys.has(makeKey(e)))

// 新：基于快照时间戳过滤
const cutoff = bestSnapshot ? bestSnapshot.timestamp : 0
const newEntries = remoteLogEntries.filter(e => e.timestamp > cutoff)
```

如果多台设备的时钟不同步（设备 A 的时钟比设备 B 快几个小时），设备 B 产生的
日志时间戳可能全部早于设备 A 的快照时间戳。这些日志会被 `cutoff` 过滤掉。

### 为什么风险有限

- 现代设备通过 NTP 同步时钟，偏差通常只有几秒
- `initialPull` 只在启动时运行一次，后续增量同步使用 `getLogsAfter(lastSync)`
- 丢失的条目在源设备上仍然存在，下次同步可能恢复

### 建议修复

- 方案 A：恢复基于内容的去重（时间戳 + type + entityId），但用范围查询限制
  对比的本地日志范围（如只对比 snapshot timestamp 之前的 1000 条）
- 方案 B：在时间戳过滤的基础上，额外检查是否有"早于 cut-off 但在本地快照中
  未物化的条目"——需要维护一个"已物化条目"的索引

---

## 3. getLogEntries 仍然全量加载日志

**发现日期**：2026-07-05

**严重度**：中

**文件**：`src/state/AppContext.tsx` 第 337-342 行

### 问题

`getLogEntries` 函数（用于设置页面的导出功能）将所有日志条目收集到
`AnyLogEntry[]` 数组中，然后再序列化为 JSON blob。对于有大量日志的用户
（>100k 条），这会导致巨大的内存峰值。

修复提交更新了注释以准确描述行为，但没有改变实现。

### 建议修复

- 方案 A：使用 Dexie 游标分片读取，逐步写入 Blob（如 ReadableStream 或
  分页 `offset/limit`）
- 方案 B：导出时使用分片——每 10k 条日志写一个文件
- 方案 C：改为导出 snapshot + 最近 N 天的日志（而非全量日志），因为完整的
  Drive 备份已经存在

---

## 4. 测试文件命名不当

**发现日期**：2026-07-05

**严重度**：低

**文件**：`src/core/snapshot.test.ts`

### 问题

`screenshot.test.ts` 测试的是 `applyEntry`、`replayLog`、`createSnapshot`——
这些函数全部定义在 `log.ts` 中，而非 `snapshot.ts`（该文件已在重构中删除）。
测试文件名现在是误导性的。

### 建议修复

- 将 `snapshot.test.ts` 的内容合并到 `log.test.ts`，然后删除 `snapshot.test.ts`
- 或者将文件重命名为 `log-apply.test.ts`

---

## 5. pushChanges 跳过仅快照的推送

**发现日期**：2026-07-05

**严重度**：低

**文件**：`src/data/sync.ts` 第 208-209 行附近

### 问题

`pushChanges` 的守卫条件从 `if (snapshot)` 改为
`if (snapshot && logs.length > 0)`。这意味着如果 `pushChanges` 在没有任何
待推送日志条目的情况下被调用，快照也不会被推送。在实际使用中这是安全的，
因为每次变更都会产生一条日志条目，但守卫比之前更严格。

### 建议修复

- 选项 1：将守卫拆分——快照总是推送，日志仅在存在时推送
- 选项 2：保持不变但添加注释说明快照推送被日志存在性门控的原因

---

## 变更历史

| 日期 | 变更 |
|------|------|
| 2026-07-05 | 创建文档，记录 5 个已知问题 |
