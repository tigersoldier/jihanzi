# ADR 0004: Pull-Diff-Push 同步协议

**日期**：2026-07-05
**状态**：已采纳
**决策者**：项目架构设计

---

## 背景

ADR 0003 规定了增量物化 + UTC 锚点历史快照链 + 日志区间分片的本地数据架构，
但同步层的协议实现存在以下问题：

1. **推送触发依赖 `lastSyncTime`**：用本地记录的"上次推送时间"判断是否有新日
   志，Drive 已有数据但本地 `lastSyncTime` 过期时，旧格式文件 (`snapshot.json` /
   `log.jsonl`) 永远不会迁移为新格式 (`snapshot_current.json` / `log_{key}.jsonl`)。

2. **`pushChanges` 使用本地时钟**：`Date.now()` 和 `generateTimestamp()` 依赖
   本地系统时间。多设备时钟偏斜时，时间戳过滤 (`getLogsAfter`) 可能跳过有效日志。

3. **同步方向不明确**：`pushChanges → initialPull` 先推后拉，如果远程有更新、
   本地也有更新，先推本地可能导致不必要的远程合并复杂度。

## 决策

**采用 pull → diff → push 同步协议，push 由 diff 结果驱动。**

### 核心流程

```
syncOnce():
  1. pull: listFiles(modifiedTime > lastKnownRemoteTime) → 读变更文件
  2. diff: 三元组 (timestamp, type, entityId) 内容去重，找出 remoteOnly / localOnly
  3. merge: remoteOnly → appendLogs 到本地 IndexedDB
  4. push: localOnly → 按 UTC 区间路由到 log_{key}.jsonl + snapshot_current.json
  5. update: lastKnownRemoteTime = max(Drive 返回的所有 modifiedTime)
```

### Diff 策略：混合去重

逐条对比全部日志不可行，纯时间戳过滤有风险。采用混合策略：

1. **时间戳范围查询**：`getLogsAfter(bestSnapshotTimestamp - buffer)` 缩小候选集
   （buffer = 1 小时，防御合理的时钟偏斜）
2. **内容去重**：在候选集上用 `(timestamp, type, entityId)` 三元组 Set 精确过滤
3. **快照时间戳作为水位线**：`bestSnapshotTimestamp = max(T_local, T_remote)`，
   早于该时间戳的变更已物化到快照中，不需要在日志层面比较

### `lastKnownRemoteTime`

- **定义**：Google Drive 上已知文件的最新 `modifiedTime`
- **来源**：Drive API `files.list` 返回的 `modifiedTime` 字段（Google 服务端时间）
- **绝不使用本地时钟**：`Date.now()` 和 `generateTimestamp()` 仅用于日志条目
  timestamp（记录操作发生时间），不参与同步协议的控制逻辑
- **更新规则**：
  - pull 完成后：`max(所有读到文件的 modifiedTime)`
  - push 完成后：`listFiles()` 取最新 `modifiedTime`

### 触发路径

两条路径统一走 `syncOnce()`，无分支：

| 路径 | 触发条件 | 行为 |
|------|---------|------|
| 即时推送 | 用户操作后 `notifyDataChanged` → 2s 防抖 | `syncOnce()` |
| 定时兜底 | 5 分钟定时器 | `syncOnce()` |
| 上线恢复 | `online` 事件 | `syncOnce()` |
| 手动同步 | 设置页"同步"按钮 | `syncOnce()` |

### 格式迁移

`syncOnce` 推完 diff 后，额外检查 `snapshot_current.json` 是否存在。
不存在则单独推送当前快照——确保从旧格式迁移。

### Push 策略：区间路由

日志按 `getIntervalKey(entry.timestamp)` 路由到对应区间文件：

```
{childName}/
├── log_{intervalKey}.jsonl    ← 每个 UTC 锚点区间一个文件
├── snapshot_current.json      ← 当前快照（每次覆盖）
└── snapshot_{intervalKey}.json ← 历史快照（锚点切换时生成，不可变）
```

- 推送到已有文件的日志采用 read-modify-write（下载 → 拼接 → 上传）
- 历史快照为不可变文件，检查文件不存在时才创建
- Drive 文件只增不删——从旧格式迁移的 `snapshot.json` / `log.jsonl` 不删除

## 后果

**优点**：

- 推送由 diff 驱动而非本地计时器，杜绝"有数据但不推"的情况
- `lastKnownRemoteTime` 完全基于 Drive 服务端时间，消除时钟偏斜在同步协议
  层面的影响
- pull → diff → push 顺序确保先吸收远程变更再推送本地差异，语义正确
- 增量 pull（`modifiedTime > lastKnownRemoteTime`）避免全量拉取
- 内容去重精确可靠，不会因时间戳边界条件丢数据
- 格式迁移内建于协议中（`snapshot_current.json` 兜底检查）

**缺点**：

- 即时推送路径需要一次 `listFiles` 网络往返（即使无远程变更），比纯本地
  push 多一次 API 调用
- 内容去重需要加载候选集日志到内存，虽然通过时间戳范围缩小了候选集
- `lastKnownRemoteTime` 依赖各设备存储一致性——清除浏览器数据会重置为 0，
  下次 pull 变为全量（设计上可接受，因为本地 IndexedDB 也已重置）

## 对 ADR 0003 的影响

ADR 0003 规定了文件布局（区间分片）和增量物化架构，本决策补充了同步协议层。
ADR 0003 中的"远程合并"描述（拉取后从基点重放再生成历史快照）保留为长时
离线后的特殊路径，日常同步使用本决策的增量 diff 协议。

## 补充：启动时区间文件完整性检查

`syncOnce` 的内容去重能检测数据缺失，但无法检测文件结构缺失（数据已通过
旧格式 `log.jsonl` 存在于 Drive，但新区间文件 `log_{key}.jsonl` 不存在）。
为此新增 `ensureIntervalFilesOnDrive()`，仅在 app 启动时 `initialPull`
完成后调用一次：

1. IndexedDB 查最早/最晚日志 timestamp → 确定本地区间范围
2. `pullAllData` 列远程文件 → 确定远程已有区间
3. 将区间分为三类：早于远程最早的、在远程范围内的、晚于远程最晚的
4. 每类用 `getLogsAfter(start, limit=501)` 分批扫描，识别缺失区间
5. 缺失区间的日志全量推送（`pushLogs` 原子操作，天然幂等）
6. 下一次启动时，已推送的区间被 `findFile` 检测为存在，自动跳过
