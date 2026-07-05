# ADR 0005: 支持 Google Drive 共享快捷方式

**日期**：2026-07-05
**状态**：已采纳
**决策者**：项目架构设计

---

## 背景

记汉字使用 Google Drive 原生共享机制实现多家长协作：用户 A 将
`记汉字/` 顶层文件夹共享给用户 B，双方各自用自己的 Google 账号
读写同一份数据。

但 Google Drive 的共享行为并非总是直接授予文件夹访问权。当用户 A
将文件夹共享给用户 B 时，用户 B 的 Drive 中该文件夹表现为**快捷方式
(shortcut)**（`mimeType = application/vnd.google-apps.shortcut`），
而非真实的文件夹。用户 B 只能通过快捷方式的 `shortcutDetails.targetId`
找到目标文件夹。

当前 `findOrCreateRootFolder()` 的查询只匹配 `mimeType = folder`，
不会匹配 shortcut。这导致用户 B 的 app 认为 `记汉字/` 文件夹不
存在，错误地创建了一个新的空文件夹——共享协作完全无法工作。

## 决策

**在 `findOrCreateRootFolder()` 中同时搜索 folder 和 shortcut 两种类型，
命中 shortcut 时解析 `shortcutDetails.targetId` 作为目标文件夹 ID。**

具体改动（`src/data/drive.ts`）：

```
// 改前：
q: `name = '${ROOT_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
fields: 'files(id, name)'

// 改后：
q: `name = '${ROOT_FOLDER_NAME}' and (mimeType = 'application/vnd.google-apps.folder' or mimeType = 'application/vnd.google-apps.shortcut') and trashed = false`
fields: 'files(id, name, mimeType, shortcutDetails)'
```

命中 shortcut 时，通过 `file.shortcutDetails.targetId` 解析出目标文件夹 ID，
并打 `console.log` 记录 shortcutId 和 targetId 用于诊断。

### 只改动根文件夹

仅 `findOrCreateRootFolder()` 需要改动，以下函数保持不变：

- `findOrCreateFolder()` — 子文件夹在共享场景下始终为真实文件夹
- `findFile()` / `listFiles()` — 文件和文件级 shortcut 不在当前场景内

### 权限依赖

解析出目标文件夹 ID 后，所有后续操作（`listFiles`、`readFile`、`writeFile`）
均使用该目标 ID。用户 B 的 token 配合 `https://www.googleapis.com/auth/drive`
scope，在用户 A 授予编辑权限的前提下，可以正常读写目标文件夹下的内容。

### 日志输出

通过 `console.log` 记录实际命中路径，方便用户在控制台确认：

| 场景 | 日志 |
|------|------|
| 直接命中文件夹 | `[drive] root folder found directly: { id, name }` |
| 通过快捷方式解析 | `[drive] root folder resolved via shortcut: { shortcutId, shortcutName, targetId }` |
| shortcut 缺失 targetId | `[drive] shortcut missing targetId, falling back to folder creation` |

## 后果

**优点**：

- 最小改动：只改一个函数，不影响其他路径
- 向后兼容：直接命中文件夹的路径（用户 A 自己的账号）行为完全不变
- 可观测：console.log 输出让用户和开发者能看到实际的解析路径
- 降级安全：shortcut 缺失 targetId 时 warn + 降级到创建新文件夹

**风险**：

- **跨所有者 parents 查询未验证**：用户 B 用 shortcut 解析出的目标 ID
  （属于用户 A 的文件夹）去执行 `'${rootId}' in parents` 查询时，Google
  Drive API 是否能正确返回结果，尚未实测。如果该查询不工作，需要备选方案。
  先假设能 work，通过日志监控实际行为。
- 如果 `files.list` 同时返回了同名 folder 和 shortcut（用户 B 手动创建了
  同名文件夹再被共享），`files[0]` 取第一个结果的行为取决于 API 返回
  顺序，可能不稳定。实际场景概率极低。

## 备选方案

### 方案 B：搜索时去掉 mimeType 过滤

```
q: `name = '${ROOT_FOLDER_NAME}' and trashed = false`
```

- **为什么不选**：查询条件不够精确，理论上可能匹配到同名的非预期类型的
  文件。与采纳方案功能等价但语义更模糊。

### 方案 C：递归处理所有层级的 shortcut

在 `findOrCreateFolder()` 和 `findFile()` / `listFiles()` 中均加上
shortcut 解析。

- **为什么不选**：根据实际场景，只有根文件夹是快捷方式，子文件夹和文件
  均为真实文件。没必要引入不必要的复杂度。
