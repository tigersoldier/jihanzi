# 记汉字 — Google Drive 同步机制报告

> 基于代码 `src/data/sync.ts`, `src/data/drive.ts`, `src/data/db.ts`, `src/core/log.ts`, `src/core/snapshot.ts`, `src/state/SyncContext.tsx`, `src/state/AppContext.tsx` 分析生成。
> 最后更新：2026-07-03

---

## 1. 数据结构

### 1.1 内存中的数据结构 (TypeScript 类型)

所有类型定义在 `src/core/types.ts`。

**AppState** — 完整应用状态：

```typescript
interface AppState {
  children: Child[]       // 所有孩子
  wordBooks: WordBook[]   // 所有生字本
  settings: Settings      // 全局设置
}
```

**Child** — 学习者：

```typescript
interface Child {
  id: string                       // 唯一标识符，如 "child_1712345678000"
  name: string                     // 显示名称，如 "小明"
  wordBookId: string               // 关联的生字本 ID
  nextCharIndex: number            // 下一个待学新字在生字本中的索引
  progress: Record<string, SM2State>  // 每个汉字 → SM-2 记忆状态
}
```

**SM2State** — 单个汉字对单个孩子的间隔重复状态：

```typescript
interface SM2State {
  ease: number          // 难度系数，起始 2.5，下限 1.3
  interval: number      // 当前间隔天数
  repetitions: number   // 成功重复次数（d 评级重置为 0）
  nextReview: string    // 下次复习日期，ISO 格式 "YYYY-MM-DD"
  lastGrade: Grade      // 最近一次评级：'a' | 'b' | 'c' | 'd'
}
```

**已学字数与正确性统计：**

孩子的学习统计由 `getChildStats()` 函数（`src/core/scheduler.ts:159`）实时计算，**不单独存储**——数据源自 `Child.progress` 中已有的 SM-2 状态。

```typescript
// getChildStats 返回值
{
  total: number      // 已学字数 = Object.keys(child.progress).length
  a: number          // 最近评级为 'a' 的字数
  b: number          // 最近评级为 'b' 的字数
  c: number          // 最近评级为 'c' 的字数
  d: number          // 最近评级为 'd' 的字数
  aPercent: number   // Math.round((a / total) * 100)
  bPercent: number
  cPercent: number
  dPercent: number
}
```

**统计更新流程：**

```
用户评分（round 1）
  → submitReview() 创建 ReviewEntry
  → 乐观更新: replayLog({ timestamp: 0, state: prev }, [entry])   ← 先更新 UI
     └─ applyReview():
        1. updateSM2(current, grade, dayKey) → 新的 SM2State
           └─ lastGrade 被设置为本次评级
        2. child.progress[character] = 新 SM2State
        3. 若为新字（current === undefined）→ 推进 nextCharIndex
  → appendLog(entry)  写入 IndexedDB logs 表（后续异步持久化）
```

**关键细节：**

- **已学字数** 等于 `progress` 中的 key 数量，即至少被 round 1 评过一次的汉字数。这个值等同于 `total` 统计量。
- **正确性分类** 按 `SM2State.lastGrade`（最近一次评级）分组归类。例如，一个汉字第一次评 'a' 后又被评 'd'，则它计入 `d` 列而非 `a` 列。这反映的是**当前掌握状态**，而非历史平均。
- **持久化路径**：`progress` 是 `Child` 对象的一部分 → `AppState` → `Snapshot.state`。Snapshot 写入 IndexedDB（持久化存储）并同步到 Drive。日志重放时通过 `applyReview` 重建 `progress`。
- **round ≥ 2 的评分** 不影响 SM-2 长期记忆模型（`applyReview` 中 `if (entry.round !== 1) return`），因此也不改变 `lastGrade` 和统计结果。巩固轮只是当天的短期巩固练习。
- `getChildStats()` 在 `useChild` hook 中被调用，用于 UI 展示（如孩子切换器中显示掌握度分布）。

**WordBook** — 生字本：

```typescript
interface WordBook {
  id: string           // 唯一标识符，如 "wb_1712345678000"
  name: string         // 显示名称
  characters: string[] // 汉字有序列表
}
```

**Settings** — 全局设置：

```typescript
interface Settings {
  dailyReviewLimit: number  // 每日复习上限，默认 30
  dailyNewChars: number     // 每日新字数量，默认 5
  maxRounds: number         // 最大巩固轮次，默认 3
}
```

**LogEntry** — 操作日志条目（11 种类型）：

```typescript
type LogEntryType =
  | 'create_child' | 'update_child' | 'delete_child'
  | 'create_wordbook' | 'update_wordbook' | 'delete_wordbook'
  | 'add_char' | 'remove_char' | 'reorder_chars'
  | 'review'
  | 'update_settings'

interface LogEntry {
  timestamp: number   // Unix 毫秒时间戳
  type: LogEntryType
}
// 每种类型有各自的扩展字段，详见 types.ts
```

**ReviewEntry** — 最核心的日志条目：

```typescript
interface ReviewEntry extends LogEntry {
  type: 'review'
  childId: string
  character: string
  grade: Grade       // 'a' | 'b' | 'c' | 'd'
  round: number      // 1, 2, 或 3（只有第 1 轮影响 SM-2 长期记忆）
  dayKey: string     // "YYYY-MM-DD" 格式
}
```

**Snapshot** — 某个时刻的完整状态快照：

```typescript
interface Snapshot {
  timestamp: number   // Unix 毫秒时间戳
  state: AppState     // 该时刻的完整应用状态
}
```

### 1.2 浏览器内会话存储 (localStorage)

定义在 `src/hooks/useToday.ts`。用于持久化**当日复习进度**（即学习会话的中间状态），使页面刷新后可以恢复未完成的复习。

**SavedSession** — 某个孩子在某个日期的学习会话状态：

```typescript
interface SavedSession {
  childId: string                        // 孩子 ID
  dayKey: string                         // "YYYY-MM-DD" 格式
  phase: SessionPhase                    // 'idle' | 'reviewing' | 'roundComplete' | 'celebration'
  taskIndex: number                      // 当前任务在队列中的索引
  round: number                          // 当前轮次（1, 2, 3）
  sessionTasks: TaskItem[]               // 会话开始时拍下的任务队列快照
  sessionReviews: ReviewEntry[]          // 本次会话中已产生的复习记录
  sessionStats: { a: number; b: number; c: number; d: number }  // 本次会话的评级统计
}
```

**TaskItem** — 任务队列中的单个任务项（定义在 `src/core/types.ts`）：

```typescript
interface TaskItem {
  character: string      // 汉字
  pinyin: string         // 拼音（由元数据填充）
  words: string[]        // 组词（由元数据填充）
  isNew: boolean         // 是否为未学新字
  isReview: boolean      // 是否为到期复习字
  sm2State?: SM2State    // 当前 SM-2 状态（新字为 undefined）
}
```

**localStorage 键约定：**

| 键格式 | 值 | 用途 |
|--------|---|------|
| `jihanzi_session_<childId>_<dayKey>` | JSON 序列化的 `SavedSession` | 持久化当前进行中的学习会话。页面刷新后恢复进度（包括当前任务索引、轮次、已评级记录等） |
| `jihanzi_done_<childId>_<dayKey>` | `"1"` | 标记某孩子在某日已完成全部复习。"完成"后的会话数据被清除，且当天不再允许开始新一轮 |

**关键行为：**
- 会话数据在每次状态变化时自动写入（`useEffect` 监听 phase/taskIndex/round 等变化）。
- `startSession()` 时会清除旧会话数据（`clearSession`），确保不会恢复过期的进度。
- `handleDone()` 时清除会话数据并设置 `jihanzi_done_` 标记，阻止当天再次开始。
- 会话恢复时按 `selectedChildId` → 遍历所有孩子 → 无匹配则重置为 idle 的顺序查找。
- **localStorage 中的数据不会同步到 Google Drive**——它仅用于本设备上的会话恢复，属于临时/本地状态。

### 1.3 浏览器内持久化存储 (IndexedDB)

使用 Dexie.js 封装的 IndexedDB，数据库名 `jihanzi`，定义在 `src/data/db.ts`。

**三张表：**

| 表名 | 主键 | 索引字段 | 存储内容 |
|------|------|---------|---------|
| `logs` | `++id` (自增) | `timestamp, type, childId, wordBookId, character, dayKey` | 所有 `AnyLogEntry` 对象 |
| `snapshot` | `++id` (自增) | `timestamp` | 始终保持 **单行**，最新的 `Snapshot` |
| `meta` | `key` (字符串) | — | 键值对，如 `lastSyncTime` |

**关键 API：**

```typescript
// 日志操作
appendLog(entry)         // 追加单条日志
appendLogs(entries)      // 批量追加（同步拉取时使用）
getAllLogs()             // 获取所有日志，按 timestamp 排序
getLogsAfter(timestamp)  // 获取 timestamp 之后的所有日志
deleteLogsBefore(timestamp) // 删除 timestamp 及之前的日志（压缩时使用）

// 快照操作
getLatestSnapshot()      // 获取最新的快照（始终只有一个）
saveSnapshot(snapshot)   // 保存快照（先清空旧快照再写入新快照）

// 元数据操作
getMeta(key)             // 读取元数据值
setMeta(key, value)      // 写入元数据值
getLastSyncTime()        // 读取上次成功同步的时间戳（从 meta 表）
setLastSyncTime(ts)      // 设置上次成功同步的时间戳
```

### 1.4 Google Drive 上的数据结构

定义在 `src/data/drive.ts`。

**文件布局：**

```
记汉字/                        ← 根文件夹（固定名称）
├── app_meta.json             ← 应用元数据（同步版本号、时间戳）
├── {孩子名}/                  ← 以孩子名字命名的子文件夹
│   ├── snapshot.json         ← 完整应用状态快照 (JSON)
│   └── log.jsonl             ← 操作日志 (NDJSON，每行一个 JSON 对象)
```

**重要架构特性：**

- 每个孩子文件夹中的 `snapshot.json` 和 `log.jsonl` 包含的是**完整的应用状态和全部日志**，而非仅该孩子的数据。
- 即 `小明/snapshot.json` 和 `小红/snapshot.json` 的内容是**完全相同**的（均为最新的完整 AppState）。
- 同理，所有孩子文件夹中的 `log.jsonl` 也是相同的（均为所有用户操作的日志）。
- 这种冗余设计简化了拉取逻辑：从任意一个孩子文件夹即可获取全部数据，多文件夹互为备份。

**MIME 类型：**

```typescript
const JSON_MIME = 'application/json; charset=utf-8'
const NDJSON_MIME = 'application/x-ndjson; charset=utf-8'
```

`charset=utf-8` 后缀是为了防止 Google Drive 在无编码元数据的情况下错误解码中文字符。

---

## 2. 同步逻辑

### 2.1 从 Google Drive 同步到本地 (Pull)

入口函数：`initialPull()` (`src/data/sync.ts:88`)

```
initialPull()
│
├─ pullAllData()                         // 读取 Drive 上所有数据
│  ├─ 查找/创建根文件夹 "记汉字"
│  ├─ 读取 app_meta.json
│  ├─ 列出所有子文件夹
│  └─ 对每个子文件夹：
│     ├─ 读取 snapshot.json → 解析为 Snapshot
│     └─ 读取 log.jsonl → 按行解析为 LogEntry[]
│
├─ 合并快照：
│  ├─ remoteSnapshot = 所有子文件夹中 timestamp 最大的 snapshot
│  ├─ localSnapshot = getLatestSnapshot()
│  └─ bestSnapshot = max(localSnapshot.timestamp, remoteSnapshot.timestamp)
│     └─ 如果 bestSnapshot ≠ localSnapshot → saveSnapshot(bestSnapshot)
│
├─ 合并日志（Union Merge）：
│  ├─ localKeys = Set(localLogs.map(makeKey))
│  ├─ newEntries = remoteLogEntries.filter(e => !localKeys.has(makeKey(e)))
│  └─ newEntries.sort(by timestamp) → appendLogs(newEntries)
│
└─ 返回 true（有远程数据被合并）/ false（Drive 为空或无 token）
```

**日志去重键 (Dedup Key)：**

```typescript
const makeKey = (e: AnyLogEntry): string => {
  if (e.type === 'review') {
    return `${e.timestamp}:${e.type}:${e.childId}:${e.character}`
  }
  const entityId = (e as any).childId || (e as any).wordBookId || ''
  return `${e.timestamp}:${e.type}:${entityId}`
}
```

review 条目使用 `timestamp:type:childId:character` 四元组作为唯一标识——同一孩子同一毫秒评两个字时不应去重。
其它条目沿用 `timestamp:type:entityId` 三元组。日志条目不可变（append-only），相同 key 即表示同一条记录，无需再次添加。

### 2.2 从本地同步到 Google Drive (Push)

入口函数：`pushChanges()` (`src/data/sync.ts:177`)

```
pushChanges()
│
├─ 检查 token 有效性（无效则标记 offline 并返回）
│
├─ 获取增量数据：
│  ├─ lastSync = getLastSyncTime()
│  ├─ logs = lastSync > 0
│  │         ? getLogsAfter(lastSync)    // 仅增量日志
│  │         : getAllLogs()              // 首次推送全部日志
│  └─ snapshot = getLatestSnapshot()
│
├─ findOrCreateRootFolder()
│
├─ pushMeta(rootId, { lastSyncTime, version })
│
├─ 对 snapshot 中的每个 child：
│  ├─ findOrCreateFolder(rootId, child.name)
│  ├─ pushSnapshot(childFolderId, snapshotData)  // 完整快照，覆盖写入
│  └─ pushLogs(childFolderId, logEntries)        // 增量日志，追加写入
│
└─ setLastSyncTime(Date.now())
```

**pushLogs 的追加策略 (`src/data/drive.ts:317`)：**

```typescript
// 如果 Drive 上已有 log 文件：
//   1. 读取现有内容（只读一次）
//   2. 追加新增条目（只写一次）
//   3. 避免 O(n²) 的多次读-改-写循环
const current = await readFile(existingFileId)
// 确保现有内容以换行结尾，防止拼接到行中
const normalized = current && !current.endsWith('\n') ? current + '\n' : current
const updated = normalized + logEntries.join('\n') + '\n'
return writeFile(childFolderId, LOG_FILE_NAME, updated, NDJSON_MIME, existingFileId)
```

**重要细节：**
- `pushSnapshot` 是**覆盖写入**（使用 PATCH + media upload），始终写入最新的完整快照。
- `pushLogs` 是**追加写入**（读出现有内容 + 追加新条目），Drive 上的 log.jsonl 会随着每次推送不断增长。
- 推送的是 `getLogsAfter(lastSyncTime)` 的结果，即自上次成功同步以来的新增日志条目。
- 日志条目被推送到了**每个**孩子文件夹（不是只推到相关孩子的文件夹）。

---

## 3. 同步方向决策

本系统**没有传统的方向决策逻辑**（即不需要判断"应该从 Drive 下载还是上传到 Drive"）。

原因在于 **append-only log + union merge** 架构天然避免了方向冲突：

| 操作 | 方向 | 策略 |
|------|------|------|
| 快照 | 双向 | 取 timestamp 最大的快照（本地 vs 远程） |
| 日志 | 双向 | 取本地和远程日志的**并集**（dedup by key） |

每次同步（无论是主动触发还是定时）都会执行 **先 push 再 pull** 的完整周期：

```typescript
// SyncContext.syncNow()
await pushChanges()    // 先把本地变更推到 Drive
await initialPull()    // 再从 Drive 拉取远程变更
```

这意味着：
- 本地新产生的日志 → 通过 push 上传到 Drive
- 远程其他设备产生的日志 → 通过 pull 下载到本地
- 日志条目不可变 → 合并不需要解决"同一字段两个值"的冲突
- 对于同一实体的多次修改（如同一汉字的两次复习），按 timestamp 排序后**后者覆盖前者**（LWW）

---

## 4. 同步触发时机

| 触发条件 | 代码位置 | 行为 |
|---------|---------|------|
| **用户登录** | `SyncContext.tsx:45` | `initialPull()` → 合并远程数据 → `reloadState()` → `startBackgroundSync()` |
| **恢复联网** | `SyncContext.tsx:57` | `checkOnlineStatus()` → `pushChanges()` |
| **定时后台同步** | `sync.ts:249` | 每 **5 分钟** 执行 `pushChanges()` → `initialPull()` |
| **手动刷新** | `SyncContext.tsx:67` | `syncNow()` → `pushChanges()` → `initialPull()` |
| **批量导入** | `AppContext.tsx:425` | `notifyDataChanged()` → 2 秒防抖 → `pushChanges()` |

**关于即时同步：**

代码中定义了 `notifyDataChanged()` 函数（`sync.ts:65`），设计意图是每次本地数据变更后经 2 秒防抖触发 push。但当前实现中，**常规的复习评分 (submitReview) 和生字本编辑操作并不会调用 `notifyDataChanged()`**。这意味着：
- 常规操作产生的日志条目仅写入 IndexedDB，不会立即推送到 Drive。
- 这些变更会在下一次定时后台同步（5 分钟内）或手动刷新时被推送。
- 只有 `bulkImport`（批量导入场景）明确调用了 `notifyDataChanged()`。

此外，`pushLogEntry()` 函数（`sync.ts:230`）也提供了"记录日志 + 立即推送"的语义，但当前未被 AppContext 的任何操作调用。

> **已知观察：** 即时同步机制（`notifyDataChanged` 和 `pushLogEntry`）已实现但未与常规 CRUD 操作集成。如需启用，需在各 mutation 操作中调用。

---

## 5. 冲突判断

### 5.1 日志冲突

**不存在传统意义的冲突。** 因为：

1. 日志条目是**不可变的**（immutable）——一旦创建就不会被修改。
2. 不同设备产生的日志条目有不同的 `timestamp`（基于 `Date.now()`），因此有不同的 dedup key。
3. 合并策略是**集合并集**（union）——不存在"A 改了 B 也改了同一字段"的场景。

**去重机制：** review 条目使用 `timestamp:type:childId:character` 四元组，其它条目使用 `timestamp:type:entityId` 三元组。key 相同则视为重复，远程日志会被跳过。

### 5.2 快照冲突

快照采用**时间戳优先**策略：

```typescript
const bestSnapshot =
  !localSnapshot || (remoteSnapshot && remoteSnapshot.timestamp > localSnapshot.timestamp)
    ? remoteSnapshot
    : localSnapshot
```

- 比较本地和远程快照的 `timestamp`，**新的覆盖旧的**。
- 如果快照被替换，旧快照之前的日志条目仍然保留在本地（因为快照只代表某个时间点的状态，日志条目作为完整历史被保留用于重放）。

### 5.3 边际场景

- **同一毫秒内的两次操作：** `generateTimestamp()` 使用 `Date.now()`（毫秒精度）。review 条目因包含 `character`，同一孩子同一毫秒评不同字不会冲突。非 review 条目对同一实体的同类型操作若落在同一毫秒，会产生相同的 dedup key 导致其中一条被去重丢弃——实际发生概率极低。
- **同一汉字被两个设备分别复习：** 两条 ReviewEntry 有不同的 timestamp，都会被添加到日志中。重放时按 timestamp 排序依次应用 SM-2 更新，**后评的那个覆盖先评的**（Last Writer Wins）。结果可能不符合间隔重复算法的预期（因为 SM-2 的 interval 需要基于前一次的 interval 计算）。

---

## 6. 快照更新算法

### 6.1 日志重放 (Log Replay)

核心函数：`replayLog(snapshot, logs)` (`src/core/log.ts:42`)

```
replayLog(snapshot, logs):
  1. 如果 snapshot 存在 → 以 snapshot.state 的深拷贝为起点
     如果 snapshot 为 null → 以空状态为起点
  2. 将 logs 按 timestamp 升序排列
  3. 逐条应用日志条目到状态：
     - create_child → 添加 Child 对象到 state.children
     - review (round=1) → 更新 child.progress[character] 的 SM-2 状态
     - review (round≥2) → 忽略（巩固轮不影响长期记忆）
     - 其他操作 → 对应的增删改
  4. 返回最终 AppState
```

### 6.2 日志压缩 (Log Compaction)

核心函数：`compactLogs(snapshot, logs)` (`src/core/snapshot.ts:32`)

```
compactLogs(snapshot, logs):
  1. 调用 replayLog(snapshot, logs) → 得到完整当前状态
  2. 调用 createSnapshot(state) → 生成新快照（timestamp = Date.now()）
  3. 返回 { snapshot: newSnapshot, logs: [] }
     // 所有日志已被快照覆盖，返回空日志列表
```

触发条件：当 `logCount >= LOG_SNAPSHOT_THRESHOLD`（默认 **500**）时触发。

触发位置：`AppContext.tsx:135` — 通过 `useEffect` 监听 `logCount` 变化：

```
useEffect(() => {
  if (logCount < 500) return      // 未达阈值，跳过
  if (compacting.current) return   // 正在压缩中，跳过
  // 等待 1 秒静默期（防抖），然后执行压缩：
  //   0. getLatestSnapshot() — 获取旧快照
  //   1. getAllLogs()
  //   2. compactLogs(oldSnapshot, logs) → { newSnapshot, logs: [] }
  //   3. saveSnapshot(newSnapshot)
  //   4. deleteLogsBefore(newSnapshot.timestamp)
  //   5. setLogCount(remaining.length) // compactLogs 返回空 logs，故为 0
}, [logCount])
```

### 6.3 如何确定从哪条日志开始更新

状态重建使用 **快照 + 所有日志** 模型：

```
当前状态 = replayLog(latestSnapshot, allLogs)
```

- 快照的 `timestamp` 表示了其覆盖的时间范围：**所有 timestamp ≤ snapshot.timestamp 的日志条目已经被计入快照的状态中**。
- 重放时，**所有日志**（包括 timestamp 早于快照的，如果它们还存在）都会被重放。
- 正常流程下，压缩操作 (`deleteLogsBefore`) 会删除早于快照时间戳的日志，所以不会出现重复应用的问题。

### 6.4 插入早于快照时间戳的新日志的处理

这种情况可能发生在**跨设备同步**场景中：

**场景：** 设备 A 在 t=2000 完成压缩（新快照 timestamp=2000，旧日志被删除），之后接收到设备 B 在 t=1500 产生的一条日志（比如设备 B 在做 pull 时这条日志进入了 A 的本地）。

**当前行为：**

1. 日志条目通过 union merge 被添加到本地 IndexedDB。
2. `replayLog(snapshot@2000, [log@1500, ...])` 会重放 **包括** 这条 t=1500 的日志。
3. 但快照 @2000 的状态**已经包含了** t=1500 日志的效果（因为压缩时是把 t=1500 日志也一起重放生成快照的）。

> **已知问题：** 这会导致 t=1500 日志的效果被**双重应用**。例如，如果 t=1500 是一条 review 日志，该汉字的 SM-2 状态会被计算两次，产生错误的 interval 和 ease 值。

**根因：** 当前 `replayLog` 不做 timestamp 过滤——它重放传递给它的**所有**日志，无论这些日志的 timestamp 是否早于快照的 timestamp。

**实际影响：** 这种场景的发生条件比较苛刻（需要两个设备分别压缩且日志时间线交错），且大部分操作（create_child, create_wordbook, update_settings）具有幂等性或可覆盖性，review 操作受影响最大（SM-2 状态被错误地更新两次）。在同一设备上的正常使用场景中不会出现此问题。

---

## 7. 单人同步场景验证

### 场景 7a：初次登录后从 Google Drive 同步

**前置条件：** 用户之前在设备 A 上使用过该应用，数据已同步到 Drive。

**初始状态：**

```
Drive:
  记汉字/
  ├── app_meta.json { lastSyncTime: 1000, version: "0.1.0" }
  └── 小明/
      ├── snapshot.json
      │   { timestamp: 1000, state: { children: [{ id: "child_1", name: "小明",
      │       wordBookId: "wb_1", nextCharIndex: 3, progress: {} }],
      │     wordBooks: [{ id: "wb_1", name: "人教版", characters: ["花","山","水","日","月"] }],
      │     settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 } } }
      └── log.jsonl
          {"timestamp":1050,"type":"review","childId":"child_1","character":"花","grade":"a","round":1,"dayKey":"2026-06-01"}
          {"timestamp":1060,"type":"review","childId":"child_1","character":"山","grade":"b","round":1,"dayKey":"2026-06-02"}
          {"timestamp":1070,"type":"review","childId":"child_1","character":"水","grade":"a","round":1,"dayKey":"2026-06-03"}

Local (IndexedDB): 空（新设备，无数据）
```

**同步过程：**

1. 用户在新设备 B 登录 → `SyncContext` 调用 `initialPull()`
2. `pullAllData()` 读取 Drive 上所有数据：
   - `remoteSnapshot` = snapshot @1000
   - `remoteLogEntries` = [review@1050, review@1060, review@1070]
3. `localSnapshot` = null, `localLogs` = []
4. `bestSnapshot` = remoteSnapshot（本地无快照）→ `saveSnapshot(snapshot@1000)`
5. `localKeys` = ∅ → `newEntries` = [review@1050, review@1060, review@1070]
6. `appendLogs(newEntries)` 按 timestamp 排序后存入
7. `initialPull()` 返回 `true` → `reloadState()` 触发状态重建

**最终状态：**

```
Local (IndexedDB):
  snapshot: { timestamp: 1000, state: { children: [{ id: "child_1", ... }], ... } }
  logs: [review@1050, review@1060, review@1070]

replayLog(snapshot@1000, [review@1050, review@1060, review@1070]) 结果：
  children[0].progress = {
    "花": { ease: 2.6, interval: 3, repetitions: 1, nextReview: "2026-06-04", lastGrade: "a" },
    "山": { ease: 2.36, interval: 2, repetitions: 1, nextReview: "2026-06-04", lastGrade: "b" },
    "水": { ease: 2.6, interval: 3, repetitions: 1, nextReview: "2026-06-06", lastGrade: "a" },
  }
  children[0].nextCharIndex = 3  // "花"、"山"、"水" 已学
```

设备 B 上的状态与设备 A 完全一致。✓

---

### 场景 7b：复习进度变化后同步到 Google Drive

**前置条件：** 用户已完成上一次同步，本地和 Drive 数据一致。

**初始状态：**

```
Local:
  snapshot: { timestamp: 1000, state: { children: [{ id: "child_1", name: "小明",
    nextCharIndex: 3, progress: { "花": {...}, "山": {...}, "水": {...} } }], ... } }
  logs: [review@1050, review@1060, review@1070]
  meta: { lastSyncTime: 1080 }

Drive:
  小明/
    snapshot.json: { timestamp: 1000, ... }
    log.jsonl: [review@1050, review@1060, review@1070]
```

**用户操作：** 复习汉字 "日"（新字），评级 'a'。

**本地变更：**
- `submitReview()` 调用 → `appendLog(entry)` 写入 IndexedDB
- `entry` = `{ timestamp: 1500, type: "review", childId: "child_1", character: "日", grade: "a", round: 1, dayKey: "2026-06-04" }`
- 乐观更新：state 中 child_1.progress["日"] 被添加，nextCharIndex → 4

**同步过程：** 5 分钟后，后台同步执行 `pushChanges()`：

1. `lastSyncTime` = 1080
2. `logs` = `getLogsAfter(1080)` = [review@1500]  // 仅增量
3. `snapshot` = `getLatestSnapshot()` = 快照 @1000（未触发压缩）
4. `findOrCreateFolder(rootId, "小明")` → 找到已有文件夹
5. `pushSnapshot(小明, snapshot@1000)` → 覆盖写入（内容未变）
6. `pushLogs(小明, [review@1500])`:
   - 读取现有 log.jsonl → [review@1050, review@1060, review@1070]
   - 追加 [review@1500]
   - 写入完整内容
7. `setLastSyncTime(Date.now())` ≈ 1501

**最终状态：**

```
Drive:
  小明/
    snapshot.json: { timestamp: 1000, ... }  (未变)
    log.jsonl:
      review@1050
      review@1060
      review@1070
      review@1500   ← 新增

Local meta: { lastSyncTime: ~1501 }  (更新)
```

Drive 和本地数据一致。✓

---

### 场景 7c：断网后复习了多日，再连网同步到 Google Drive

**前置条件：** 用户在断网状态下使用了多日，期间完成了多次复习。

**初始状态：**

```
Local:
  snapshot: { timestamp: 1000, state: { children: [{ id: "child_1", name: "小明",
    nextCharIndex: 3, progress: { "花": {...}, "山": {...} } }], ... } }
  logs: [review@1050, review@1060]
  meta: { lastSyncTime: 1001 }

Drive:
  小明/
    snapshot.json: { timestamp: 1000, ... }
    log.jsonl: [review@1050, review@1060]
```

**用户操作（断网期间，3 天）：**

| 时间 | 操作 | 日志条目 |
|------|------|---------|
| t=1500 (Day 1) | 复习 "水"，评级 'a' | `review@1500 { character: "水", grade: "a", dayKey: "2026-06-03" }` |
| t=1600 (Day 2) | 复习 "日"，评级 'b' | `review@1600 { character: "日", grade: "b", dayKey: "2026-06-04" }` |
| t=1700 (Day 3) | 复习 "月"，评级 'a' | `review@1700 { character: "月", grade: "a", dayKey: "2026-06-05" }` |

**连网后的同步过程：**

1. 恢复联网 → `checkOnlineStatus()` → `pushChanges()` 触发
2. `lastSyncTime` = 1001
3. `logs` = `getLogsAfter(1001)` = [review@1500, review@1600, review@1700]
4. 推送到 Drive：
   - snapshot@1000 覆盖写入（未变）
   - 三条新日志追加到 log.jsonl
5. `setLastSyncTime(~1701)`
6. 随后 `initialPull()` 执行：
   - `remoteSnapshot` = snapshot@1000（与本地相同）→ 不替换
   - `remoteLogEntries` = [review@1050, review@1060, review@1500, review@1600, review@1700]
   - `localKeys` 已有 review@1050, review@1060 → 被去重
   - `localKeys` 也有 review@1500-1700（在 push 前已在本地）→ 全部去重
   - `newEntries` = [] → 无需添加

**最终状态：**

```
Local (IndexedDB):
  logs: [review@1050, review@1060, review@1500, review@1600, review@1700]
  meta: { lastSyncTime: ~1701 }

Drive:
  小明/
    log.jsonl:
      review@1050, review@1060, review@1500, review@1600, review@1700

replayLog 结果：
  children[0].progress = {
    "花": { ease: ~2.6, interval: ..., lastGrade: "a" },
    "山": { ease: ~2.36, interval: ..., lastGrade: "b" },
    "水": { ease: ~2.6, interval: ..., lastGrade: "a" },
    "日": { ease: ~2.36, interval: ..., lastGrade: "b" },
    "月": { ease: ~2.6, interval: ..., lastGrade: "a" },
  }
  children[0].nextCharIndex = 5  // 所有 5 个字都已学
```

所有断网期间的复习数据已正确同步到 Drive。✓

---

## 8. 双账号同步场景验证

### 场景 8a：一账号上传后另一账号登录从 Drive 同步

**前置条件：** 账号 A（爸爸）使用设备 1 已建立学习数据并同步到 Drive，账号 B（妈妈）在设备 2 首次登录。

**初始状态：**

```
Drive (账号 A 推送后):
  小明/
    snapshot.json: { timestamp: T1=1000, state: {
      children: [{ id: "child_1", name: "小明",
        wordBookId: "wb_1", nextCharIndex: 2,
        progress: { "花": {...SM2...}, "山": {...SM2...} } }],
      wordBooks: [{ id: "wb_1", name: "人教版", characters: ["花","山","水","日","月"] }],
      settings: {...} }}
    log.jsonl:
      {"timestamp":T1,"type":"create_child","childId":"child_1","name":"小明","wordBookId":"wb_1"}
      {"timestamp":T2=1050,"type":"review","childId":"child_1","character":"花","grade":"a","round":1,"dayKey":"2026-06-01"}
      {"timestamp":T3=1060,"type":"review","childId":"child_1","character":"山","grade":"b","round":1,"dayKey":"2026-06-02"}

账号 B 本地: 空（首次登录，无任何数据）
```

**同步过程：**

1. 账号 B 登录 → `initialPull()` 执行
2. 从 Drive 拉取：
   - `remoteSnapshot` = snapshot@1000
   - `remoteLogEntries` = [create_child@1000, review@1050, review@1060]
3. `localSnapshot` = null → `bestSnapshot` = remoteSnapshot → `saveSnapshot(snapshot@1000)`
4. `localKeys` = ∅ → 全部 3 条日志作为新条目 → `appendLogs(按timestamp排序)`
5. `reloadState()` → `replayLog(snapshot@1000, allLogs)` 重建状态

**最终状态：**

```
账号 B 本地:
  snapshot: { timestamp: 1000, state: {...} }
  logs: [create_child@1000, review@1050, review@1060]

重放结果:
  孩子 "小明" 存在，已复习 "花" 和 "山"
  生字本 "人教版" 存在，包含 5 个汉字
  设置保持默认值
```

账号 B 在设备 2 上获得与账号 A 完全一致的学习进度。✓

---

### 场景 8b：两账号同状态，A 完成复习同步，B 检测更新同步

**前置条件：** 两个账号已通过同步达到相同状态。

**初始状态：**

```
账号 A 和 B 本地状态一致：
  snapshot@1000, logs 包含 [review@1050(花), review@1060(山)]
  children[0].nextCharIndex = 2
  children[0].progress = { "花": {...}, "山": {...} }
```

**步骤 1：** 账号 A 完成新复习 "水"（评级 'a'）。

账号 A 本地：
- `appendLog(review@1500 { character: "水", grade: "a" })`
- 乐观更新 → progress["水"] 被添加，nextCharIndex → 3

**步骤 2：** 账号 A 的后台同步（或账号 A 手动触发 syncNow）：

A 的 `pushChanges()`:
- `lastSyncTime(A)` = 1100
- `getLogsAfter(1100)` = [review@1500]
- 推送到 Drive：
  - snapshot@1000（覆盖，内容不变）
  - log.jsonl 追加 review@1500

```
Drive log.jsonl:
  review@1050(花), review@1060(山), review@1500(水)  ← 新增
```

**步骤 3：** 账号 B 的后台同步触发（5 分钟内）：

B 的 `pushChanges()`:
- `lastSyncTime(B)` = 1100
- `getLogsAfter(1100)` = []（B 本地没有新日志）→ 无需推送

B 的 `initialPull()`:
- `remoteLogEntries` = [review@1050, review@1060, review@1500]
- `localKeys` 有 review@1050(花) 和 review@1060(山) → 去重
- `newEntries` = [review@1500(水)] → `appendLogs`
- `reloadState()` 触发

**最终状态：**

```
账号 B 本地:
  logs: [review@1050, review@1060, review@1500]
  children[0].progress = { "花": {...}, "山": {...}, "水": {...SM2@1500...} }
  children[0].nextCharIndex = 3
```

账号 B 自动获得了账号 A 的复习进度更新。✓

---

### 场景 8c：两账号断网后各自复习，联网后合并同步

**前置条件：** 两个账号在同一状态（同场景 8b 的初始状态），然后都断网，各自在断网期间完成复习。

**初始状态：**

```
Drive:
  小明/log.jsonl: [review@1050(花,a), review@1060(山,b)]
  小明/snapshot.json: { timestamp: 1000, state: { child "小明" with progress {花, 山} } }

账号 A 本地 = 账号 B 本地 = 以上内容
```

**断网操作：**

```
账号 A (断网，Day 1):
  t=2000: 复习 "水"，评级 'a'
  t=2001: 复习 "日"，评级 'b'
  → 本地 logs 新增: [review@2000(水,a), review@2001(日,b)]

账号 B (断网，Day 2，即次日):
  t=3000: 复习 "山"，评级 'd'（遗忘）
  t=3001: 复习 "月"，评级 'a'
  → 本地 logs 新增: [review@3000(山,d), review@3001(月,a)]
```

**步骤 1：** 账号 A 先联网 → `pushChanges()`：

A 的 push：
- `lastSyncTime(A)` = 1100
- `getLogsAfter(1100)` = [review@2000(水,a), review@2001(日,b)]
- 推送到 Drive：
  - snapshot@1000 覆盖
  - log.jsonl 追加 review@2000, review@2001

```
Drive log.jsonl:
  review@1050(花,a), review@1060(山,b), review@2000(水,a), review@2001(日,b)
```

A 的 pull（initialPull）：
- 远程别无新数据 → 无变化

**步骤 2：** 账号 B 随后联网 → `pushChanges()` → `initialPull()`：

B 的 push：
- `lastSyncTime(B)` = 1100
- `getLogsAfter(1100)` = [review@3000(山,d), review@3001(月,a)]（注意：B 在断网期间产生了本地日志）
- 推送到 Drive：
  - snapshot@1000 覆盖
  - log.jsonl 追加 review@3000, review@3001

B 的 pull（initialPull）：
- `remoteLogEntries` = [review@1050, review@1060, review@2000, review@2001, review@3000, review@3001]
- `localKeys` 有 review@1050, review@1060, review@3000, review@3001
- `newEntries` = [review@2000(水,a), review@2001(日,b)] ← 来自 A 的新增日志
- `appendLogs([review@2000, review@2001])`（按 timestamp 排序）

B 最终本地 logs：
```
[review@1050(花,a), review@1060(山,b),
 review@2000(水,a), review@2001(日,b),    ← 来自 A
 review@3000(山,d), review@3001(月,a)]    ← B 自己的
```

**步骤 3：** A 的下一次 pull（后台同步或手动）：

A 的 initialPull：
- `remoteLogEntries` = [全部 6 条]
- `localKeys` 有 4 条（A 的原始 4 条）
- `newEntries` = [review@3000(山,d), review@3001(月,a)] ← 来自 B
- A 本地 logs 增加这 2 条

**最终状态（两账号一致）：**

```
replayLog(snapshot@1000, [所有 6 条日志]):

children[0].progress = {
  "花": 由 review@1050(花,a) 设置 → SM-2 state from A's Day 1→2 review
  "山": review@1060(山,b) → review@3000(山,d) 覆盖
       → ease: 2.5 (重置), interval: 1 (重置), repetitions: 0, lastGrade: "d"
       (B 的遗忘评级覆盖了 A 的第一次评级)
  "水": 由 review@2000(水,a) 设置 → SM-2 state from A
  "日": 由 review@2001(日,b) 设置 → SM-2 state from A
  "月": 由 review@3001(月,a) 设置 → SM-2 state from B
}

children[0].nextCharIndex = 5
```

**合并结果分析：**

| 汉字 | 最终由谁决定 | 冲突？ | 说明 |
|------|-----------|--------|------|
| 花 | A | 无 | 仅 A 评了 |
| 山 | B (较晚) | 有 | B 的遗忘评级（t=3000）晚于 A 的 b 评级（t=1060），后者覆盖前者 |
| 水 | A | 无 | 仅 A 评了 |
| 日 | A | 无 | 仅 A 评了 |
| 月 | B | 无 | 仅 B 评了 |

> **注意：** "山" 字的合并采用了 Last Writer Wins 策略——B 在第二天给出的 'd'（遗忘）评级覆盖了 A 在之前给出的 'b' 评级。这是因为 SM-2 状态更新是**覆盖式**的（`child.progress[character] = updated`），而非增量式的。最终 SM-2 状态反映了最后一次复习的结果。在实际使用场景中，如果 A 和 B 是两位家长分别辅导同一个孩子，这个结果在语义上是合理的（后来的复习反映孩子的当前状态）。

---

### 场景 8d：一账号复习完毕同步后，另一账号如何获知当日已完成

**核心问题：** 账号 A 完成当日全部复习并同步到 Drive 后，账号 B 从 Drive 拉取数据，如何知道今天的复习已经完成、不需要再做？

**答案：** "当日已完成"的判断不是通过一个显式的标记传播的，而是**隐含在同步的状态数据中**——B 拉取数据后重新生成任务队列，若队列为空即表示当日已完成。

#### 机制分析

"当日已完成"涉及两个层面：

| 层面 | 存储位置 | 同步到 Drive？ | 账号 B 如何获知？ |
|------|---------|--------------|------------------|
| `jihanzi_done_<childId>_<dayKey>` 标记 | localStorage | **否** | 无法直接获知 |
| 任务队列是否为空 | 由 `generateTodayTasks()` 实时计算 | 隐含在 snapshot + logs 中 | 拉取同步后重新生成任务队列，若为空则完成 |

#### 逐步追踪

**初始状态（账号 A 复习前，两账号一致）：**

```
今天是 2026-06-10（学新日）
孩子 "小明"，生字本 ["花","山","水","日","月","星","云","雨","雪","风"]
nextCharIndex = 0, progress = {}
```

**步骤 1：** 账号 A 完成当日复习（5 个新字 + 无到期复习字）。

A 的操作：
- 复习 5 个新字："花"(a), "山"(b), "水"(a), "日"(b), "月"(a)
- `handleDone()` → localStorage 写入 `jihanzi_done_child_1_2026-06-10 = "1"`

A 本地状态变更：
```
nextCharIndex = 5
progress = {
  "花": { nextReview: "2026-06-13", lastGrade: "a", ... },  // SM-2: interval=3 for grade 'a' on new char
  "山": { nextReview: "2026-06-12", lastGrade: "b", ... },  // SM-2: interval=2 for grade 'b' on new char
  "水": { nextReview: "2026-06-13", lastGrade: "a", ... },
  "日": { nextReview: "2026-06-12", lastGrade: "b", ... },
  "月": { nextReview: "2026-06-13", lastGrade: "a", ... },
}
```

**步骤 2：** 账号 A 同步到 Drive。

pushChanges 推送：
- snapshot（含更新后的 nextCharIndex=5 和 progress）
- 5 条 ReviewEntry 日志

**步骤 3：** 账号 B 执行 initialPull。

```
B 的 initialPull():
  1. 从 Drive 拉取 snapshot + 5 条新日志
  2. 合并到本地 IndexedDB
  3. reloadState() → replayLog(snapshot, logs) 重建状态
     → nextCharIndex = 5, progress 含 5 个新 SM-2 状态
```

**步骤 4：** 账号 B 的 `useToday` 判断是否可开始学习。

```typescript
// useToday 中的判断链：

// ① 检查 localStorage 的 done 标记
doneToday = isDayDone("child_1", "2026-06-10")  // → false
// localStorage 标记是本地独立的，不会随 Drive 同步

// ② 生成今日任务队列
tasks = generateTodayTasks(state, "child_1", "2026-06-10")
```

`generateTodayTasks` 的执行过程（`src/core/scheduler.ts:21`）：

```
1. 收集到期复习字：getDueReviews(child, "2026-06-10")
   - "花".nextReview = "2026-06-13" > "2026-06-10" → 未到期
   - "山".nextReview = "2026-06-12" > "2026-06-10" → 未到期
   - "水".nextReview = "2026-06-13" > "2026-06-10" → 未到期
   - "日".nextReview = "2026-06-12" > "2026-06-10" → 未到期
   - "月".nextReview = "2026-06-13" > "2026-06-10" → 未到期
   → dueReviews = []（所有字刚被 A 复习过，都未到期）

2. 生成复习任务：
   reviewTasks = [].slice(0, 30) = []

3. 学新日，填充新字：
   remainingQuota = min(5, 30 + 5 - 0) = 5
   getNewCharacters(child, allChars, 5):
     - i=5: "星" 不在 progress 中 → 加入
     - i=6: "云" → 加入
     - i=7: "雨" → 加入
     - i=8: "雪" → 加入
     - i=9: "风" → 加入
   → newTasks = ["星", "云", "雨", "雪", "风"]

→ 返回 5 个新字任务
```

**步骤 5：** 最终判断。

```typescript
effectiveTasks = ["星", "云", "雨", "雪", "风"]  // 5 个任务
isReady = selectedChildId !== ''  // true ("child_1")
       && effectiveTasks.length > 0  // true (5)
       && !doneToday                 // true (localStorage 标记为 false)
       → true  // 账号 B 可以开始学习！
```

**结论：** 在此场景中，账号 B 看到了新的 5 个任务字（"星""云""雨""雪""风"），**并未**获知当日已完成。这是因为生字本还有剩余汉字，而"当日已学 5 个新字"这个事实（即 A 已用完今日配额）没有被显式记录到可同步的数据中。

#### 何时账号 B 会看到"已完成"？

账号 B 的 `isReady === false` 仅在 `effectiveTasks.length === 0` 时成立，这需要以下条件**同时**满足：

1. **到期复习字全部已处理**：所有 `nextReview <= today` 的字都已被任一账号评过 → `getDueReviews()` 返回空。
2. **新字配额已耗尽且不可再取**：
   - 学新日：`nextCharIndex >= wordBook.characters.length`（生字本已学到末尾），或当日已被标记完成的复习字已占满配额 → `getNewCharacters()` 返回空。
   - 纯复习日：不添加新字 → 仅需条件 1 满足即可。

**关键限制：** 系统**不追踪"当日已用配额"**——只追踪 `nextCharIndex`（已学到哪个字）和各字的 `nextReview`（下次复习日）。因此：

| 场景 | 账号 A 完成当日配额后 | 账号 B 同步后看到的 |
|------|---------------------|-------------------|
| 纯复习日，全部到期字已复习 | 任务队列为空 | 任务队列为空 ✓（完成） |
| 学新日，生字本已学到末尾 | 任务队列为空 | 任务队列为空 ✓（完成） |
| 学新日，生字本还有剩余字 | 任务队列为空（本地标记完成） | 显示下一批新字 ✗（超额） |

> **设计影响：** 在多账号协作场景中，如果生字本尚未学完，"当日已完成"的状态无法跨设备传播。第二个账号将会看到生字本中剩余的新字并继续学习。这可能导致当日新字总量超过 `dailyNewChars` 配额。如果需要在多设备间严格限制每日配额，需要额外增加一个可同步的"今日已学字数"计数器（例如作为一条每日汇总日志或 meta 字段同步到 Drive）。

---

### 场景 8e：一账号复习到一半，切换到另一账号能否接力

**核心问题：** 账号 A 开始复习但未完成（例如 5 个新字评了 2 个），此时账号 B 登录同步，能否从剩余 3 个字继续复习？

**短答案：** 能否接力取决于两个账号之间**是否发生了同步**。由于 `submitReview` 不触发即时推送（如附录 B 所述），通常需要后台同步（最多 5 分钟）将 A 的进度推送到 Drive 后，B 才能看到更新后的状态。

#### 分情况分析

**前提：** 今天是学新日 (`dailyNewChars=5`)，生字本 `["花","山","水","日","月","星","云","雨","雪","风"]` (10 个字)。

---

#### 情况 1：A 的进度已同步到 Drive（B 可接力）

**条件：** A 开始复习后，后台同步（5 分钟定时）恰好触发，将 A 的复习日志推送到 Drive。

**步骤 1：** A 开始复习，前 2 个字评分完毕。

```
A 的 IndexedDB 新增:
  review@T1 { character: "花", grade: "a", round: 1, dayKey: "2026-06-10" }
  review@T2 { character: "山", grade: "b", round: 1, dayKey: "2026-06-10" }

A 的状态 (乐观更新 + 日志重放):
  nextCharIndex = 2
  progress = {
    "花": { nextReview: "2026-06-13", lastGrade: "a", ease: 2.6, interval: 3, ... },
    "山": { nextReview: "2026-06-12", lastGrade: "b", ease: 2.36, interval: 2, ... },
  }

A 的会话状态 (localStorage):
  sessionTasks: ["花","山","水","日","月"], taskIndex=2, round=1, phase='reviewing'
```

**步骤 2：** 后台同步触发 → `pushChanges()` 将 review@T1 和 review@T2 推送到 Drive。

```
Drive log.jsonl 新增:
  review@T1 (花,a), review@T2 (山,b)
```

**步骤 3：** B 登录 → `initialPull()` → `reloadState()`。

```
B 重建后的状态:
  nextCharIndex = 2
  progress = { "花": {...}, "山": {...} }

B 的 generateTodayTasks():
  到期复习: getDueReviews("2026-06-10")
    "花".nextReview = "2026-06-13" → 未到期
    "山".nextReview = "2026-06-12" → 未到期
    → dueReviews = []

  新字 (学新日):
    getNewCharacters(child, chars, 5)
      从 index=2 开始:
        chars[2]="水" 不在 progress → ✓
        chars[3]="日" 不在 progress → ✓
        chars[4]="月" 不在 progress → ✓
        chars[5]="星" 不在 progress → ✓
        chars[6]="云" 不在 progress → ✓
      → newTasks = ["水","日","月","星","云"]
    → 返回 5 个新字任务
```

**步骤 4：** B 可以正常开始复习 5 个新字。

**结论：** B 可以接力，但并非从 A 停下的位置（第 3 个任务）继续，而是看到**全新的 5 个任务**（A 评过的 2 个字已被排除，顺延取后续的字）。当日总量达到 2(A) + 5(B) = 7 个新字，**超过 dailyNewChars=5 的配额**。

```
接力结果:
  A 评了: 花, 山
  B 评了: 水, 日, 月, 星, 云
  当日总计: 7 个新字（配额 5）← 超额
```

> **配额分析：** `nextCharIndex` 从 0→2（A 贡献）→2→7（B 贡献），生字本共 10 字。B 的 `getNewCharacters` 从 index=2 取 5 个字，不感知 A 已经"用掉了 2 个配额"的事实。配额跟踪是本地的、非持久化的——这是一个设计局限。

---

#### 情况 2：A 的进度尚未同步（B 重复劳动）

**条件：** A 开始复习后不满 5 分钟，后台同步尚未触发。A 的复习日志仅存在于 A 的 IndexedDB，Drive 上仍是旧状态。

**步骤 1：** A 评分了 花(a) 和 山(b)，数据在 IndexedDB 但未推送到 Drive。

```
Drive 上的数据: 仍是旧状态
  nextCharIndex = 0, progress = {}
  (A 的 review@T1, review@T2 还在 A 本地 IndexedDB)
```

**步骤 2：** B 登录 → `initialPull()` → Drive 上没有新数据 → B 看到旧状态。

```
B 重建后的状态:
  nextCharIndex = 0, progress = {}

B 的 generateTodayTasks():
  → ["花","山","水","日","月"]  （与 A 初始完全相同的 5 个字）
```

**步骤 3：** B 开始复习，可能与 A 产生的评分完全或部分重叠。

```
B 评分了: 花(b), 山(a), 水(a), 日(b), 月(a)  (B 不知道 A 已经评了花和山)
```

**步骤 4：** A 和 B 的日志最终通过后台同步合并到 Drive。

```
双方 merge 后的日志:
  A 的: review@T1(花,a), review@T2(山,b)
  B 的: review@T3(花,b), review@T4(山,a), review@T5(水,a), review@T6(日,b), review@T7(月,a)

replayLog 重放 (按 timestamp 排序):
  - review@T1(花,a) → progress["花"] = SM2 from A (grade a)
  - review@T2(山,b) → progress["山"] = SM2 from B (grade b)
  - review@T3(花,b) → progress["花"] = SM2 from B (grade b) ← 覆盖了 A 的 a
  - review@T4(山,a) → progress["山"] = SM2 from B (grade a) ← 覆盖了 A 的 b
  - review@T5(水,a) → progress["水"] = SM2 from B
  - review@T6(日,b) → progress["日"] = SM2 from B
  - review@T7(月,a) → progress["月"] = SM2 from B

最终:
  nextCharIndex = 5
  花 → lastGrade: "b" (B 的结果，A 的 "a" 被覆盖)
  山 → lastGrade: "a" (B 的结果，A 的 "b" 被覆盖)
  当日新字总量: 5 个（只有 B 的 5 个字生效；A 的重复评分被 LWW 覆盖）
```

**结论：** B 重复了 A 已经完成的复习。最终状态中，"花"和"山"的评级以 timestamp 较晚的 B 为准（LWW 覆盖）。A 的评级虽然被写入日志，但 SM-2 状态被 B 的后续评分覆盖。**当日新字总量看起来是 5 个，但实际两个账号都投入了时间。**

---

#### 情况 3：A 未完成，B 也未完成，两者交替（最复杂）

A 和 B 交替多轮复习同一批字（如两个家长轮流辅导），每次评分后推送到 Drive。

```
T1: A 评 花(a) → push
T2: B pull → B 评 花(b) → push
T3: A pull → A 评 山(a) → push
T4: B pull → B 评 山(b) → push
...
```

对于同一汉字，每次 pull 后状态同步，SM-2 的 `updateSM2` 从前一次的状态开始计算。例如：

```
花:
  T1: A 评 a → SM2: ease=2.6, interval=3, nextReview=06-13
  T2: B pull → B 评 b
      updateSM2(current={ease:2.6, interval:3, ...}, grade='b')
      → newEase = 2.6 + (0.1 - 2*(0.08+2*0.02)) = 2.6 + (-0.14) = 2.46
      → newInterval = round(3 * 2.46) = 7
      → SM2: ease=2.46, interval=7, nextReview=06-17
```

这种场景下 SM-2 计算是**正确的**——因为每次 review 都是从最新同步的状态开始，而非凭空创建。LWW 不再是问题，因为两次评分的时间顺序被正确保留。

> **关键区别：** 情况 3 与情况 2 的本质区别在于**同步是否在评分之间发生**。如果每次评分之间都有 sync，SM-2 计算是累积式的；如果多次评分在没有 sync 的情况下发生，则只有 timestamp 最新的那次生效。

---

#### 总结

| 条件 | B 看到的任务 | 接力可行？ | 配额 | SM-2 正确性 |
|------|------------|-----------|------|-----------|
| A 进度已同步到 Drive | 剩余字 + 后续字（共 5 个新任务） | ✓（但非从原位置继续） | 超额 | ✓ |
| A 进度未同步 | A 原始的全部 5 个字 | ✗（重复劳动） | 取决于合并结果 | LWW 覆盖 |
| 交替同步（每步都 sync） | 逐次更新后的剩余任务 | ✓（逐次接力） | 超额 | ✓（累积式 SM-2） |

**根本原因：** 以下几项因素共同导致了接力不完美——

1. **`submitReview` 不触发即时同步**（附录 B.1）：A 的评分不会立即推送到 Drive，需要等后台同步（最多 5 分钟）。
2. **localStorage 会话状态不同步**：B 看不到 A 的 `taskIndex` 和 `sessionTasks` 快照，无法从 A 中断的位置精确继续，只能重新生成任务队列。
3. **无"当日已用配额"计数器**：`nextCharIndex` 只记录学到的位置，不记录"今日已学字数"。A 用掉的配额对 B 不可见。
4. **SM-2 的 LWW 特性**：同一汉字的多次评分如果没有被中间同步分隔，只有 timestamp 最晚的生效。

> **改进方向：** 如果 `submitReview` 调用 `notifyDataChanged()`（启用即时同步），A 的每次评分都会在 2 秒内推送到 Drive。B 刷新后即可看到最新状态，实现接近实时的接力。

---

## 附录 A：架构决策记录

### ADR-1：为什么选择 Append-Only Log 而非传统 CRUD？

- 日志条目不可变 → 无"修改同一字段"的冲突
- 多设备合并 = 取日志并集 → 天然支持离线 + 多设备
- 审计追踪：所有历史操作可追溯
- 代价：日志会不断增长，需要压缩（snapshot compaction）

### ADR-2：为什么所有孩子文件夹存储相同的全量数据？

- 简化拉取逻辑：从任意文件夹即可恢复全部数据
- 互为备份：即使某个文件夹损坏，数据不丢失
- 代码简洁：无需维护"哪个日志属于哪个孩子"的映射
- 代价：多孩子时 Drive 存储有冗余（每个孩子文件夹内容相同）

### ADR-3：为什么 Push 只推送增量日志而非全量？

- 全量推送会导致 Drive API 流量和 IndexedDB 读取随日志历史线性增长 (O(n))
- 增量推送（`getLogsAfter(lastSyncTime)`）只发送自上次同步以来的新条目
- 通过 `lastSyncTime` 追踪每次成功同步的时间点
- 首次同步时（lastSyncTime=0）仍为全量推送，使用 `getAllLogs()`

---

## 附录 B：已知观察与潜在改进

1. **即时同步未完全集成：** `notifyDataChanged()` 和 `pushLogEntry()` 已实现，但常规 CRUD 操作（submitReview, createChild 等）未调用它们。当前依赖 5 分钟定时后台同步作为主要同步通道。

2. **早于快照的日志双重应用风险：** 如 6.4 节所述，跨设备同步时如果一条日志的 timestamp 早于当前快照的 timestamp，`replayLog` 会将其再次应用到状态上。解决方案：在 `replayLog` 中过滤掉 timestamp ≤ snapshot.timestamp 的日志条目（但需确保这样做不会丢失合法的新日志）。

3. **SM-2 状态的 LWW 合并：** 同一汉字被两次复习时，SM-2 状态是覆盖式更新的，而非基于两次评级的复合计算。对于间隔重复算法而言，理想的合并应依次应用两次复习（SM-2 是顺序依赖的），但当前架构将两次复习视为独立事件，后者覆盖前者。

4. **快照写入每个孩子文件夹的冗余：** pushChanges 将同一份 snapshot 写入每个孩子文件夹。优化方案：将 snapshot 提升到根文件夹层级，或只写入一次。

5. **日志文件的单调增长：** Drive 上的 log.jsonl 只增不减（没有 Drive 端的压缩机制）。本地压缩后，旧的日志条目仍保留在 Drive 上。虽然这不会导致数据错误（拉取时会去重），但长期使用后 Drive 上的 log 文件会变得很大。

6. **已删除孩子的孤儿文件夹：** 删除孩子后，对应的 Drive 子文件夹不会被删除。未来同步时该文件夹的数据仍会被读取，但因数据过时不会产生实际影响。
