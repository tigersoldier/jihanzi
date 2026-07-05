# 实现计划：增量物化 + 历史快照链

## 背景

见 `docs/adr/0003-incremental-materialization.md`。核心变更：从"启动时从快照+全量日志重放"改为"快照始终是最新状态的完整副本，启动时直接读取"。

---

## 阶段 1：Core 层（类型 + SM-2 + applyEntry 公共化）

### 1.1 扩展 `SM2State`，添加 `firstReviewDay`

**文件**：`src/core/types.ts`（`SM2State` interface，行 9-15）

- 加 `firstReviewDay: string` 字段
- 同步更新 `DEFAULT_SETTINGS` 上方 `SM2_INITIAL_INTERVAL` 附近，不需要改动

### 1.2 更新 `createInitialSM2State`，写入 `firstReviewDay`

**文件**：`src/core/sm2.ts`（行 15-25）

- `createInitialSM2State()` 目前不接受参数
- 改为 `createInitialSM2State(dayKey: string): SM2State`
- 新字段 `firstReviewDay: dayKey`
- 更新 `updateSM2` 调用 `createInitialSM2State` 的地方（行 52），传入 `reviewDate`
- 注意：`createInitialSM2State` 还被 `applyReview` 间接调用——确保 `applyEntry` 把 `dayKey` 传过去

### 1.3 `applyEntry` 系列函数提升为公共、返回 `boolean`

**文件**：`src/core/log.ts`

- 将 `applyEntry` 从 `function` 改为 `export function`，返回类型 `boolean`
- 子函数（`applyCreateChild`、`applyReview` 等）保持 private，只暴露 `applyEntry`
- 返回 `false` 的场景：
  - `review` round ≠ 1（巩固轮，SM-2 不更新）
  - `update_child`/`update_wordbook` 值未变化
  - `delete_child`/`delete_wordbook` entity 不存在
  - `remove_char` index 不匹配
  - `reorder_chars` 顺序未变
- `applyReview`（行 183-204）：round 1 且 `!current` 时设置 `firstReviewDay = entry.dayKey`
- `replayLog` 签名改为返回 `AppState`（去掉 boolean），keep 为纯函数，排序逻辑不变

### 1.4 删除旧 compaction 函数

**文件**：`src/core/snapshot.ts`

- 删除 `shouldGenerateSnapshot`
- 删除 `compactLogs`
- 删除 `rebuildState`
- 保留 `createSnapshot`（仍需要用来拷贝 state）
- 如果整个文件只剩 `createSnapshot`，将其移入 `log.ts`

**文件**：`src/core/log.ts`

- 删除 `LOG_SNAPSHOT_THRESHOLD`（行 240）
- 删除 `logsAfter`（行 233-235）—— 无调用者

### 1.5 UTILS：添加 `getIntervalKey` 函数

**新建文件或不新建**：`src/utils/date.ts` 或 `src/core/interval.ts`

- `getIntervalKey(timestamp: number): string` → `"2026-07-01"`
- 规则：daily UTC 0:00，锚点为 1/11/21
- `getIntervalKeysBetween(from: number, to: number): string[]`
- 供 IndexedDB、Drive 层和合并逻辑使用

---

## 阶段 2：IndexedDB 层

### 2.1 Schema v3 升级

**文件**：`src/data/db.ts`（`JihanziDB` class，行 14-36）

- `version(3).stores({...})` 加 `[childId+character]` 索引：
  ```
  this.version(3).stores({
    logs: '++id, timestamp, type, childId, wordBookId, character, dayKey, [childId+dayKey], [childId+character]',
    snapshot: '++id, timestamp, type',
    meta: 'key',
  })
  ```

### 2.2 Snapshot 操作重写

**文件**：`src/data/db.ts`

- 删 `deleteLogsBefore`
- 改 `saveSnapshot` → 不再 `clear()`，改为 `add()` 追加
- 新函数 `getLatestSnapshot(): Promise<Snapshot | null>` — 改为按 `timestamp DESC, type='current'` 查？
  实际上当前+历史都在同一表，应加 `WHERE type = 'current'` 过滤
- 新函数 `getHistoricalSnapshots(): Promise<Snapshot[]>` — `WHERE type = 'historical' ORDER BY timestamp DESC`
- 新函数 `findBaseSnapshot(beforeTimestamp: number): Promise<Snapshot | null>` — `WHERE timestamp <= beforeTimestamp ORDER BY timestamp DESC LIMIT 1`（当前+历史都查）
- 新函数 `pruneOldSnapshots(keepCount: number): Promise<void>` — 保留最近 N 份历史快照
- 新函数 `getSnapshotCount(): Promise<number>`

### 2.3 日志操作

**文件**：`src/data/db.ts`

- 删 `getAllLogs` — 启动时不再需要
- 改 `getLogsAfter` — 保留，加了 time range 过滤
- 删 `getReviewsForDay` — 无生产调用者
- 改 `getReviewsForChildChar` — 利用 `[childId+character]` 新索引做 where 过滤：
  ```ts
  db.logs.where({ type: 'review', childId, character }).toArray()
  ```
- 删 `getFirstReviewDays` → 改为快照中读取
- 加 `getLogsInRange(childId, fromDay, toDay)` — `[childId+dayKey]` between，已有 `getReviewsForChildInRange`
- 新函数 `getLogCount` — 已有，保留
- 新函数 `pruneOldestLogs(count: number): Promise<number>` — `orderBy('timestamp').limit(count).toArray()` → 删除
- 保留 `getReviewsForChild`、`getReviewsForChildInRange`、`getLogsAfter`
- 保留 `appendLog`、`appendLogs`

### 2.4 UTF-8 损坏检测

**文件**：`src/data/db.ts`

- 保留 `isUTF8Corrupted` 函数
- 新函数 `repairCorruptedLogs()` — 在迁移阶段调用：
  1. `db.logs.orderBy('timestamp').each(entry => ...)` 逐条读
  2. 若 `hasCharacter(entry) && isUTF8Corrupted(entry.character)` → `db.logs.delete(entry.id)` → 继续
  3. 若遇到第一条干净的 → 停止游标

---

## 阶段 3：AppContext 改造

**文件**：`src/state/AppContext.tsx`

### 3.1 启动路径（`loadState`）

- `loadState()` → `getLatestSnapshot()` → 若存在，直接 `setState(snapshot.state)`
- 不需要 `getAllLogs` + `replayLog`
- loading 状态仍保留

### 3.2 Watched Transaction 包装

把每个 mutation 的内部改成统一模式。创建一个 helper `applyAndPersist(entry)`：

```ts
async function applyAndPersist(entry: AnyLogEntry): Promise<void> {
  const snapshot = await getLatestSnapshot()
  if (!snapshot) return
  const newState = deepClone(snapshot.state)
  const changed = applyEntry(newState, entry)
  
  await db.transaction('rw', [db.logs, db.snapshot], async () => {
    await appendLog(entry)
    if (changed) {
      const newSnapshot = { timestamp: Date.now(), state: newState, type: 'current' }
      await updateCurrentSnapshot(newSnapshot) // 替换旧的 type=current
    }
  })
  
  if (changed) {
    setState(newState)
  }
}
```

但 `submitReview` 目前用 `replayLog` 的方式更新 React state（需要 SM-2 calculation）。通过 applyEntry 已经做了 SM-2 计算，所以直接取 newState 即可。

### 3.3 区间切换逻辑

在 `applyAndPersist` 中，写入前检查：
```ts
const now = Date.now()
const snapshotInterval = getIntervalKey(snapshot.timestamp)
const currentInterval = getIntervalKey(now)
if (snapshotInterval !== currentInterval) {
  // 归档：把旧的 current 变成 historical
  await archiveCurrentSnapshot(snapshot, snapshotInterval)
}
```

`archiveCurrentSnapshot`：
- 将现有 current snapshot 的 `type` 改为 `'historical'`（或插入一份 type='historical' 的副本）
- 创建新的 type='current' snapshot
- `pruneOldSnapshots(5)`

### 3.4 日志裁剪

在 `applyAndPersist` 写完日志后：
```ts
const count = await getLogCount()
if (count > 500_000) {
  await pruneOldestLogs(1000)
}
```

### 3.5 删除 logCount state + compact 逻辑

- 删除 `logCount` state 和相关的 `useEffect`（行 89 + 146-190）
- 删除 `compact()` 函数及相关 refs
- `appendEntry` helper 简化（不再计数）

### 3.6 `bulkImport` 改造

- 接受 `(snapshot, logs)` → 遍历 logs，逐条 `applyEntry` 到 snapshot.state
- 写入新 type='current' snapshot
- `appendLogs(logs)` 批量写日志
- `setState(finalState)`

### 3.7 `getLogEntries` 改造

- 改为分片读取 → 使用 `db.logs.orderBy('timestamp').each()` 或分页
- 返回类型仍为 `Promise<AnyLogEntry[]>` 但现在用流式拼接

---

## 阶段 4：Drive/Sync 层

### 4.1 文件名常量化

**文件**：`src/data/drive.ts`

- 删 `SNAPSHOT_FILE_NAME`、`LOG_FILE_NAME` 常量
- 替换为函数式：
  - `snapshotCurrentFileName()` → `"snapshot_current.json"`
  - `snapshotFileName(intervalKey: string)` → `"snapshot_2026-07-01.json"`
  - `logFileName(intervalKey: string)` → `"log_2026-07-01.jsonl"`

### 4.2 `pullAllData` 重写

- 从 `listFiles` 获取所有文件名
- 筛选 `snapshot_current.json` → 下载解析
- 筛选 `log_*.jsonl` → 按 `modifiedTime > lastSyncTime` 筛选
- 每个符合条件的 log 文件：下载 → 逐行 parse → 过滤 `timestamp > snapshot.timestamp` → 收集
- 返回 `{ snapshot, logEntries, historicalSnapshots }` 而非旧的 `childData` map

### 4.3 `pushChanges` 重写

- 从 `getLogsAfter(lastSync)` 获取待推送日志
- 按 `getIntervalKey(log.timestamp)` 分组
- 对每个区间：
  - `findFile` 找到对应 `log_{intervalKey}.jsonl`
  - 下载现有内容 → 拼接 → 上传
- 当前快照 `snapshot_current.json` 每次 push 都上传
- 历史快照：在生成时上传一次；远程合并时如果被重生成也上传

### 4.4 Push 多快照支持

- `pushSnapshot` 改为接受文件名参数而非硬编码 `SNAPSHOT_FILE_NAME`
- `pushLogs` 改为接受区间 key → 路由到对应文件

### 4.5 `pullAllData` 的重放逻辑

拉取远程日志后：
```
earliestTimestamp = min(logEntries)
baseSnapshot = findBaseSnapshot(earliestTimestamp)  // IndexedDB 本地
if (!baseSnapshot) → 丢弃（硬截断）
newState = replayLog(baseSnapshot, allLogsAfter(baseSnapshot.timestamp))
// 逐区间重放，每跨一个 UTC 锚点生成 historical snapshot
// 重新上传全部受影响的 snapshot_*.json
```

---

## 阶段 5：消费层适配

### 5.1 `useStats.ts` — `useCharacterStats`

**文件**：`src/hooks/useStats.ts`

- `getReviewsForChildChar` 改用 `[childId+character]` 新索引 → 无需改调用代码

### 5.2 `useStats.ts` — `useHistory`

**文件**：`src/hooks/useStats.ts`（行 116-210）

- 删除 `getFirstReviewDays` 调用
- 改为从 `child.progress[char].firstReviewDay` 读取

### 5.3 `SettingsPage.tsx`

**文件**：`src/components/settings/SettingsPage.tsx`

- `handleExport` 改为分片读取 + 打包为包含 snapshot + logs 的 blob
- `handleImport` 适配新的导出格式

### 5.4 `SyncContext.tsx`

**文件**：`src/state/SyncContext.tsx`

- `initialPull` 返回结果改变了，`reloadState` 调用方式可能需调整
- 实际上增量物化后 `reloadState` 只需重新读快照

### 5.5 导入导出同构

- 导出格式：`{ snapshot, logs: [...] }`
- 导入逻辑通过 `applyEntry` 路径保证一致性
- 导出时用分片读取日志

---

## 验证

### 单元/集成测试

- `src/core/log.test.ts` — 验证 `applyEntry` 返回值正确（round 1 vs round 2+）
- `src/core/sm2.test.ts` — 未必需要（`firstReviewDay` 字段不涉及算法）
- `src/data/db.test.ts` — 验证新 snapshot 操作、`[childId+character]` 索引
- `src/data/sync.test.ts` — 验证分片日志路由、push 逻辑
- `src/state/AppContext.test.tsx` — 验证增量写入、区间切换、启动加载
- `src/hooks/useStats.test.ts` — 验证 `firstReviewDay` 替代 `getFirstReviewDays`

### 端到端验证

1. **启动**：清空 IndexedDB，新用户首次启动 → 快照为空 → 正常显示空白状态
2. **写入**：复习一个字 → 检查 IndexedDB snapshot 表和 logs 表都有新数据
3. **巩固轮**：round 2 复习 → 日志有记录但快照不变
4. **区间切换**：手动调 system time 跨 11 日 → 检查历史快照生成
5. **日志裁剪**：插入 500k+ 条日志 → 检查最旧 1000 条被裁剪
6. **导出导入**：导出 → 导入到空设备 → 状态完全一致
7. **Drive 同步**：全新安装 app → initialPull 拉取快照 + 区间日志 → 状态正确
