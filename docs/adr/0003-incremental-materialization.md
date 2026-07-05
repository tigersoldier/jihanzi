# ADR 0003: 增量物化 + 历史快照链

**日期**：2026-07-04
**状态**：已采纳
**决策者**：项目架构设计

---

## 背景

ADR 0001 确立了 append-only log 作为数据源的架构：每次启动时从快照起重放全部
日志以重建应用状态。随着日志随使用增长（一个孩子每天产生 ~30 条复习日志），
两个固有问题逐渐凸显：

1. **启动内存不可控**：`getAllLogs()` 将全部日志加载到内存，`replayLog` 内
   再次复制数组排序。日志无上限增长，内存峰值线性上升。

2. **同步时全量日志比对**：`initialPull` 需将全部本地日志加载到内存构建
   去重集合，跨设备合并时内存峰值翻倍。

本项目是面向个人的小型工具，预期日志总量在数万条级别，但架构上不应有任何
无上限的全量读取路径。

## 决策

**采用增量物化 + UTC 锚点历史快照链，取代全量重放架构。**

核心原则：

- 快照是应用状态的唯一数据源——每次写操作通过 IndexedDB 事务同
  步更新快照和追加日志。启动时直接读取快照，不重放日志。
- 日志降级为同步载体和审计线索，不再参与本地状态重建。
- UTC 日期锚点（每月 1 日、11 日、21 日 00:00 UTC）作为历史快照
  和日志分片的边界线。

### 快照体系

| 快照类型 | 存储位置 | 生命周期 |
|---------|---------|---------|
| `snapshot_current` | 本地 IndexedDB + Drive | 每次写操作更新 |
| `snapshot_{intervalKey}` (历史) | 本地 IndexedDB + Drive | UTC 锚点切换时创建，保留最近 5 份 |

- 启动：`getLatestSnapshot()` → 直接 `setState(snapshot.state)`，不重放
- 写入：`Dexie.transaction` 包裹 `appendLog + saveSnapshot`，原子操作
- 区间切换：当前 `snapshot_current` 归档为 `snapshot_{intervalKey}`，
  创建新 `snapshot_current`。跨区间重启时只生成最近一个历史快照。
- `applyEntry` 返回 `boolean` 表示 state 是否变更——巩固轮（round 2+）的
  review 不改变 SM-2 状态，跳过快照更新但仍写日志用于同步

### 日志分片

日志按 timestamp 所属的 UTC 日期区间路由到对应文件：

```
{孩子名}/
├── snapshot_current.json
├── snapshot_2026-07-01.json
├── snapshot_2026-06-21.json
├── log_2026-07-01.jsonl
├── log_2026-06-21.jsonl
└── ...
```

- 本地日志上限 500,000 条，超出后裁剪最旧 1,000 条（带缓冲带）
- 日志裁剪独立于快照周期
- Drive 文件只增不删（日志和快照均为不可变追加）

### 远程合并

当拉取到远程日志后，找出最旧日志时间戳对应的历史快照作为基点，
从该基点重放后续日志，重新生成受影响的全部历史快照，上传 Drive。

```
1. earliestTimestamp = min(pulledLogs)
2. baseSnapshot = 本地 snapshot WHERE timestamp ≤ earliestTimestamp，取最新的
3. 从 baseSnapshot 起，逐区间文件加载日志 → apply → 生成历史快照 → 释放
4. 全部历史快照（从 baseSnapshot 之后的区间）重新上传 Drive
5. snapshot_current 在上传
```

若远程日志早于全部历史快照（离线 >50 天），做硬截断——丢弃早于最老
历史快照日志。

### 其他决策

- `SM2State` 新增 `firstReviewDay` 字段，`getFirstReviewDays` 函数删除。
  首次复习日期在 apply review 时物化到快照。
- 新增 `[childId+character]` 索引（v3 schema），替换 `getReviewsForChildChar`
  的全量加载。
- 废弃 `getReviewsForDay`（无生产调用者）。
- 删除旧 compaction 机制：`compact()`、`compactLogs`、`LOG_SNAPSHOT_THRESHOLD`。
- v2→v3 迁移：一次性构造式迁移——`getLatestSnapshot()` + 全量日志读取
  → `replayLog` → 生成新 schema 快照 + 历史快照。全量日志读取时先逐条
  检测 UTF-8 损坏，遇到第一条干净日志后转为批量读取。
- Push 冲突策略：下载现有内容 → 拼接 → 上传（不检查 modifiedTime）。
  顺序写入天然安全，并发窗口极小且丢失的数据在源设备上保留。
- 导出/导入保留：导出改为分片读取日志，导入通过 `applyEntry` 路径确保
  往返同构。

## 后果

**优点**：

- 内存可控：启动只读快照（几十 KB），日志只在有界范围内读取（单个区间
  文件内容、按时间/数量范围查询）。
- 写入高效：每次写操作只 Apply 一条日志到内存中的 state，无需全量重放。
- 启动极快：快照直接即 React state，无重放延迟。
- 同步简单：日志按区间文件分片，逐个文件处理，不产生全量日志的内存峰值。
- 可回溯：历史快照链支持从任意区间起点重放日志，保留 append-only log
  的可审计性。

**缺点**：

- 快照与日志双写：引入了 IndexedDB Transaction 的复杂度，以及快照/日志
  间的一致性风险（通过 Dexie Transaction 缓解）。
- 历史快照维护：区间切换时自动生成，远程合并时可能触发全部历史快照的
  重新生成和上传。这类触发场景极为罕见（漫长离线后回归）。
- 不可变日志文件的幂等问题：Drive 上按区间分片的日志文件中，重复条目
  通过 timestamp 过滤在 apply 阶段处理，而非文件层面去重。

## 对 ADR 0001 的影响

ADR 0001 的核心思想（append-only log 保证无冲突同步）保持不变。
本决策改变的是本地状态的消费方式——从"读时计算"转为"写时物化"。
日志仍然是同步和审计的基石，只是不再是启动路径上的唯一数据源。
