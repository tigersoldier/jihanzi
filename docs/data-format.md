# 记汉字 — 数据格式文档

> 版本 0.1.0 | 2026-06-29

## 概述

记汉字采用**追加日志 (Append-Only Log)** 作为唯一数据源，通过**快照 (Snapshot)** 进行日志压缩。数据存储在用户个人的 Google Drive 上，组织为以下目录结构：

```
记汉字/
├── app_meta.json          # 应用元数据
├── {小朋友名字}/
│   ├── snapshot.json      # 快照（完整状态）
│   └── log.jsonl          # 追加日志（快照之后的增量操作）
```

- **snapshot.json** — 某一时刻的完整应用状态。可用于导入/导出。
- **log.jsonl** — 快照时间点之后追加的日志条目，每行一条 JSON。与快照合并后可重建最新状态。

## 核心概念

### 状态重建

```
当前状态 = replayLog(快照状态, 快照之后的所有日志条目)
```

日志条目不可变、仅追加。多设备合并时取日志并集，天然无冲突。日志超过 500 条时自动生成新快照并清除旧条目。

### 快照与导出的关系

导出文件就是一个完整的 **Snapshot**（包含 `timestamp` 和 `state`），等价于将快照和所有后续日志重放后的结果。导入时将其作为新的快照写入本地 IndexedDB。

---

## Snapshot 格式

Snapshot 是顶层导出/导入的 JSON 格式。

### 顶层结构

| 字段 | 类型 | 说明 |
|------|------|------|
| `timestamp` | `number` | Unix 毫秒时间戳，标记快照生成时刻 |
| `state` | `AppState` | 该时刻的完整应用状态 |

### AppState

| 字段 | 类型 | 说明 |
|------|------|------|
| `children` | `Child[]` | 所有小朋友 |
| `wordBooks` | `WordBook[]` | 所有生字本 |
| `settings` | `Settings` | 应用设置 |

---

## 实体定义

### Child（小朋友）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 唯一标识 |
| `name` | `string` | 小朋友的名字 |
| `wordBookId` | `string` | 关联的生字本 ID |
| `nextCharIndex` | `number` | 下一个要学习的汉字在生字本中的索引 |
| `progress` | `Record<string, SM2State>` | 已学习汉字的 SM-2 记忆状态，key 为汉字 |

**学习状态判定：**
- **已学习** — 汉字在 `progress` 中有对应的 SM2State 条目
- **未学习** — 汉字在生字本中但不在 `progress` 中

### WordBook（生字本）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 唯一标识 |
| `name` | `string` | 生字本名称 |
| `characters` | `string[]` | 有序汉字列表 |

### SM2State（SM-2 记忆状态）

| 字段 | 类型 | 说明 |
|------|------|------|
| `ease` | `number` | 简易度因子，初始 2.5，最低 1.3 |
| `interval` | `number` | 当前复习间隔（天） |
| `repetitions` | `number` | 成功复习次数 |
| `nextReview` | `string` | 下次复习日期，格式 `YYYY-MM-DD` |

### Settings（设置）

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `dailyReviewLimit` | `number` | 30 | 每日最多复习字数 |
| `dailyNewChars` | `number` | 5 | 每日最多新学字数 |
| `maxRounds` | `number` | 3 | 每字最多巩固轮数 |

---

## Log 条目格式（log.jsonl）

每行一条 JSON，所有条目共享基础字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `timestamp` | `number` | Unix 毫秒时间戳 |
| `type` | `string` | 操作类型（见下表） |

### 操作类型一览

| type | 说明 | 特有字段 |
|------|------|----------|
| `create_child` | 创建小朋友 | `childId`, `name`, `wordBookId` |
| `update_child` | 修改小朋友 | `childId`, `name?`, `wordBookId?` |
| `delete_child` | 删除小朋友 | `childId` |
| `create_wordbook` | 创建生字本 | `wordBookId`, `name`, `characters` |
| `update_wordbook` | 修改生字本名称 | `wordBookId`, `name?` |
| `delete_wordbook` | 删除生字本 | `wordBookId` |
| `add_char` | 添加汉字 | `wordBookId`, `character`, `index` |
| `remove_char` | 移除汉字 | `wordBookId`, `character`, `index` |
| `reorder_chars` | 重排汉字 | `wordBookId`, `characters` |
| `review` | 评分 | `childId`, `character`, `grade`, `round`, `dayKey` |
| `update_settings` | 修改设置 | `settings` |

### 评分等级（grade）

| 等级 | SM-2 质量分 | 含义 |
|------|-------------|------|
| `a` | 5 | 完全记住 |
| `b` | 3 | 犹豫后正确 |
| `c` | 2 | 提示后正确 |
| `d` | 0 | 完全遗忘 |

---

## 完整示例

```json
{
  "timestamp": 1719667200000,
  "state": {
    "children": [
      {
        "id": "child_1",
        "name": "小明",
        "wordBookId": "wb_1",
        "nextCharIndex": 3,
        "progress": {
          "花": {
            "ease": 2.6,
            "interval": 3,
            "repetitions": 2,
            "nextReview": "2026-07-02"
          }
        }
      }
    ],
    "wordBooks": [
      {
        "id": "wb_1",
        "name": "人教版一年级上册",
        "characters": ["花", "一", "二", "三", "四"]
      }
    ],
    "settings": {
      "dailyReviewLimit": 30,
      "dailyNewChars": 5,
      "maxRounds": 3
    }
  }
}
```

此示例中：小明已学习「花」，尚未学习「一」「二」「三」「四」。
