# Code Review: 已学字功能 — 2026-07-04

> 审查范围：`master` 分支上未提交的 working-tree 变更。
> 共 9 个文件（6 modified + 3 new），~800 行新增。

---

## 严重缺陷（数据损坏/行为错误）

### 1. 筛选模式下删除/排序操作用错索引

**文件**：`src/components/wordbook/WordBookPage.tsx:207`

**根因**：`CharacterList` 接收 `filteredChars`（筛选后的子集），但 `onRemove(char, index)` 和 `onReorder(chars)` 中的 index/array 是**子集中的位置**，`AppContext` 用这些索引操作**全量数组**。

**触发场景**：
- 生字本有 `['雨','雪','风','云']`，筛选"未学"显示 `['风','云']`
- 删除"云"→ 传 index=1 → `AppContext` 移除 `chars[1]='雪'` → **删错了**
- 日志 replay 时 guard 失败 → 静默丢弃 → 刷新后两个字都恢复
- 排序更严重：拖拽重排后全集被**子集覆盖** → 未被筛选的字**永久丢失**

**修复方向**：`WordBookPage` 在调用 `removeCharacter`/`reorderCharacters` 前，需将 filtered index 映射回全量数组的 index；或将筛选逻辑下沉到 `CharacterList` 使其通过字符值而非索引来操作。

### 2. selectedChildId 双源不同步

**文件**：`src/hooks/useToday.ts:107`, `src/state/AppContext.tsx:52`, `src/components/today/ProgressPage.tsx:150`

**根因**：`useToday` 内部有自己的 `selectedChildId` 状态，`AppContext` 也有一个。`ProgressPage` 仅在 dropdown 的 `onChange` 中同时设置两者——**没有其他同步机制**。

**触发场景**：
1. 在 ProgressPage 选了 child-1
2. 切到生字本 tab，换到 child-2（只更新了 AppContext）
3. 切回 ProgressPage → 下拉框显示 child-2，但 `useToday` 内部仍是 child-1
4. 点"开始学习"→ 生成的是 child-1 的任务，评分也记到 child-1

**修复方向**：`useToday` 应从 AppContext 读取 `selectedChildId` 而非自己维护一份；或加 `useEffect` 在 AppContext 值变化时同步到 useToday。

### 3. useToday 在查看历史月份时无谓执行

**文件**：`src/components/today/ProgressPage.tsx:58`

**根因**：`useToday()` 无条件调用，但其输出仅在 `isCurrentMonth` 时渲染。查看过去月份时，`generateTodayTasks`、localStorage 读写、多个 `useEffect` 全部白跑。

**修复方向**：将今日任务 UI 抽成子组件，仅在 `isCurrentMonth` 时挂载（从而惰性调用 `useToday`）。

---

## 高风险问题

### 4. 不安全的 `as Promise<ReviewEntry[]>` 类型断言

**文件**：`src/data/db.ts:77,84,95,128`

四处在 Dexie 的 `toArray()` 上加了 `as Promise<ReviewEntry[]>`。Dexie 表类型是 `AnyLogEntry`，如果 IndexedDB 中有损坏条目（如缺少 `grade` 字段），类型断言静默放行 → 下游 `counts[entry.grade]++` 访问 `undefined` → `NaN`。

**修复方向**：用运行时校验（`entry.type === 'review'` guard + 字段存在性检查）替代纯编译时断言。

### 5. `getFirstReviewDays` 全量扫描

**文件**：`src/data/db.ts:102`

用 `.each()` 遍历孩子全部 review 来确定每个字的首次复习日。每次切换月份或 sync 触发 `dataVersion` 变化都重新扫描。过去月份数据不可变，无需每次重扫。

**修复方向**：
- 对非当前月份跳过重新查询
- 未来可在 SM2State 中存储 `firstReviewDay`，把 O(N) 扫描变成 O(1) 属性查找
- 或利用 `[childId+character+dayKey]` 复合索引逐字查询最早条目

---

## 中等问题

### 6. 70 行 Session UI 复制

**文件**：`src/components/today/ProgressPage.tsx:166-234`

`ProgressPage` 内联了 `TodayPage` 的全部四阶段 JSX（idle/reviewing/roundComplete/celebration）。任何 session 流程改版需同步两处。

**修复方向**：删除已无引用的 `TodayPage.tsx`，或将 session UI 抽成共享组件。

### 7. `getProficiency` 放错层次

**文件**：`src/hooks/useStats.ts:13`

`getProficiency` 是纯函数（`SM2State → Proficiency`），无 hook 依赖，但放在 hooks 文件中。页面组件（WordBookPage）为导出一个纯函数而引入 hooks 模块。

**修复方向**：移到 `src/core/` 与 `SM2State` 类型共置。

### 8. "Proficiency" 概念未纳入领域词汇表

**文件**：`src/hooks/useStats.ts:11`

`Proficiency = 'mastered' | 'progressing' | 'weak' | 'unlearned'` 在 `useStats.ts`、`WordBookPage`、`CharacterList` 三处使用，是新的领域概念，但 `CONTEXT.md` 未定义。

**修复方向**：在 CONTEXT.md 的"学习过程"章节下增加「熟练度 (Proficiency)」条目。

### 9. `todayKey()` 重复定义

**文件**：`src/components/today/ProgressPage.tsx:14`

`ProgressPage` 本地定义了与 `utils/date.ts` 完全相同的 `todayKey()`，且该文件已在 import 该模块。

**修复方向**：直接 import `todayKey` from `../../utils/date`。

### 10. 评级标签/颜色三处重复

**文件**：`src/components/common/CharacterDetail.tsx:15-27`, `src/components/today/ProgressPage.tsx:344-351,394,414`

Grade→标签（完全掌握/部分正确/…）和 Grade→颜色（绿/蓝/黄/红）在 CharacterDetail 和 DayDetailView 中各自定义。`src/core/types.ts` 已有 `GRADE_TO_Q` 做类似映射——可在此统一。

---

## 低风险/清理

| # | 文件 | 行 | 问题 |
|---|------|----|------|
| 11 | `WordBookPage.tsx` | 210 | `progress ? proficiencyMap : undefined` — `progress` 总是 `{}` 以上（truthy），三元是死代码 |
| 12 | `WordBookPage.tsx` | 8 | `PROFICIENCY_DOT` 已导入但未使用（仅 CharacterList 使用） |
| 13 | `CharacterList.tsx` | 53 | `handleDragEnd` 的 `useCallback` 依赖 `characters` 每渲染都变（因 `filteredChars` 每次都新引用），导致 DnD 传感器反复重建 |
| 14 | `useStats.ts` | 60,133 | 两个 hooks 都监听全局 `dataVersion`——sync 了无关字符的 review 也会触发重查询 |
| 15 | `AppContext.tsx` | 430 | `bulkImport` 中 `as Snapshot` 类型断言——若 `Snapshot` 类型未来加新必填字段，编译期检查被绕过 |

---

## 后续行动建议

1. **立即修**：Finding 1（筛选索引 bug）和 Finding 2（selectedChildId 不同步）——会导致数据损坏和错误行为
2. **本迭代修**：Finding 3-5 —— 性能和健壮性
3. **下迭代修**：Finding 6-10 —— 架构清理和术语完善
4. **可延后**：Finding 11-15 —— 低风险清理项
