# 记汉字

基于 Web 的汉字学习 PWA，帮助学龄儿童通过 SM-2 间隔重复算法科学地学习和复习汉字。家长在手机或电脑上操作，孩子在纸上书写，app 负责安排复习节奏和追踪进度。

## 快速开始

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev
# → http://localhost:5173/jihanzi/

# 生产构建
npm run build
# → dist/

# 预览生产构建
npm run preview
```

首次启动后看到登录页，点击「使用 Google 登录」即可进入 app（未配置 Google API 时为演示模式，直接进入）。

## 项目结构

```
src/
├── core/                   # 框架无关的领域逻辑
│   ├── types.ts            # 全部类型定义、常量、默认设置
│   ├── sm2.ts              # SM-2 间隔重复算法（ease/间隔更新）
│   ├── scheduler.ts        # 每日任务调度（学新/复习交替、排序、配额）
│   ├── log.ts              # 追加日志操作（重放、状态重建、快照生成）
│   └── snapshot.ts         # 日志压缩（快照生成、阈值判断）
├── data/                   # 数据持久化层
│   ├── db.ts               # Dexie IndexedDB（日志表、快照表、元数据表）
│   ├── gapi.ts             # Google Identity Services OAuth + gapi 初始化
│   ├── drive.ts            # Google Drive API（文件夹/文件读写、追加日志）
│   └── sync.ts             # 同步编排器（推/拉/合并、5 分钟定时、在线离线监听）
├── state/                  # React Context 状态管理
│   ├── AuthContext.tsx      # 登录状态（Google OAuth / 演示模式）
│   ├── AppContext.tsx       # 应用数据（孩子/生字本 CRUD、评分提交、日志追加）
│   └── SyncContext.tsx      # 同步状态（在线/离线/同步中/失败）
├── hooks/                  # 自定义 Hooks
│   ├── useToday.ts         # 今日任务流（阶段切换、评分动画、轮次、统计）
│   ├── useChild.ts         # 孩子选择与统计查询
│   └── useWordBook.ts      # 生字本 CRUD 操作
├── components/
│   ├── layout/             # Layout / TopBar / BottomNav（三 Tab 导航）
│   ├── auth/LoginPage.tsx  # Google 登录欢迎页
│   ├── today/              # 今天 Tab（核心 UX）
│   │   ├── TodayPage.tsx   # 任务流编排（idle→reviewing→roundComplete→celebration）
│   │   ├── CharacterCard.tsx  # 楷体大字 + 拼音 + 组词 + 新字标记
│   │   ├── RatingButtons.tsx  # 四级评分按钮（响应式：手机 2×2，电脑横排）
│   │   ├── ProgressBar.tsx    # 进度条 + 计数
│   │   ├── RoundComplete.tsx  # 轮次完成确认卡片
│   │   └── Celebration.tsx    # 完成庆祝页（分项统计）
│   ├── child/              # 孩子 Tab
│   │   ├── ChildPage.tsx   # 统计面板（掌握度分布、进度条）
│   │   └── ChildSwitcher.tsx   # ◀ 名字 ▶ 切换器
│   ├── wordbook/           # 生字本 Tab
│   │   ├── WordBookPage.tsx    # 编辑器（添加/删除/切换生字本）
│   │   ├── WordBookSwitcher.tsx
│   │   └── CharacterList.tsx   # 可拖拽排序的字列表（@dnd-kit）
│   ├── settings/SettingsPage.tsx  # 设置页（配额/导入导出/同步状态/关于）
│   └── common/             # 通用组件
│       ├── EmptyState.tsx  # 空状态引导
│       └── SyncIndicator.tsx   # 同步状态指示器
└── utils/
    ├── date.ts             # 日期工具（日期键、学新/复习交替、格式化）
    └── chars.ts            # 80+ 常用汉字拼音与组词数据库
```

## 核心概念

### 记忆算法：SM-2 变体

- **评级映射**：a(完全掌握)→5分, b(部分正确)→3分, c(需提示)→2分, d(遗忘)→0分
- **Ease 更新**：EF' = EF + (0.1 − (5−q) × (0.08 + (5−q) × 0.02))，下限 1.3
- **间隔计算**：新间隔 = round(当前间隔 × 新 ease)
- **d 级重置**：ease 重置为 2.5，间隔重置为 1 天
- **当天重复轮次**：c/d 字进入下轮巩固，最多 3 轮。仅第 1 轮评分计入 SM-2

详见 `docs/design/memory_curve.md`。

### 每日节奏

学新日与纯复习日严格交替：

| 日类型 | 总字数 | 说明 |
|--------|--------|------|
| 学新日 | 35 字 | 复习优先（上限 30），剩余配额填新字（5 个） |
| 纯复习日 | 30 字 | 全部为到期复习字 |

配额可在设置中调整。

### 数据模型：追加日志

所有操作以不可变日志条目存储：

```typescript
{ timestamp: 1703001234567, type: "review", childId: "xm", character: "花", grade: "a" }
```

- 追加写入，不可变，带时间戳
- 多设备合并取并集，天然无冲突
- 读取时重放日志重建完整状态
- 日志超过 500 条自动生成快照压缩

### 存储架构

```
离线 → IndexedDB (Dexie.js) → 即时读写
联网 → Google Drive           → 自动同步
        └── 记汉字/
            ├── app_meta.json
            └── {孩子名}/
                ├── snapshot.json
                └── log.jsonl
```

- **即时同步**：每次评分/编辑后立即推送
- **定时兜底**：每 5 分钟后台同步
- **离线优先**：无网络时本地正常使用，联网后自动同步

## 本地测试

### 演示模式（无需 Google 配置）

默认不做任何配置，`npm run dev` 启动后点击登录页的「使用 Google 登录」即可进入演示模式。演示模式下：

- 数据仅存储在浏览器 IndexedDB 中
- 清除浏览器数据会丢失所有记录
- 所有功能正常可用（创建孩子、生字本、每日复习评分）

### 测试日常使用流程

1. 登录后进入「生字本」Tab → 创建生字本 → 添加汉字（如：一二三四五）
2. 进入「孩子」Tab → 创建孩子 → 选择生字本
3. 进入「今天」Tab → 点击「开始学习」→ 对每个字评级
4. 一轮完成后观察 c/d 字的巩固轮次
5. 完成所有轮次后观察庆祝统计页

### 测试离线功能

```bash
npm run build && npm run preview
# 在浏览器中打开，然后：
# 1. 打开 DevTools → Application → Service Workers → 确认 SW 已激活
# 2. DevTools → Network → 勾选 Offline
# 3. 刷新页面 → 应用正常加载（从缓存）
# 4. 进行评分操作 → 数据存入 IndexedDB
# 5. 取消 Offline → 数据自动同步到 Drive（若已配置）
```

### 测试 PWA 安装

```bash
npm run build && npm run preview
# 在 Chrome 中打开 → 地址栏右侧出现安装图标 → 点击安装
# 或：菜单 → 安装"记汉字"
```

桌面端和移动端均可安装。

## 配置 Google Drive 同步

### 1. 创建 Google Cloud 项目

1. 打开 [Google Cloud Console](https://console.cloud.google.com/)
2. 创建新项目（名称随意，如 `jihanzi`）
3. 进入「API 和服务」→「已启用的 API 和服务」→「启用 API 和服务」
4. 搜索并启用 **Google Drive API**

### 2. 配置 OAuth 同意屏幕

1. 进入「API 和服务」→「OAuth 同意屏幕」
2. User Type 选择 **External**
3. 填写应用名称、用户支持邮箱、开发者联系邮箱
4. 添加范围：`.../auth/drive.file`
5. 添加测试用户（你自己的 Google 账号）
6. 发布应用（或保持测试状态）

### 3. 创建 OAuth 客户端 ID

1. 进入「API 和服务」→「凭据」→「创建凭据」→「OAuth 客户端 ID」
2. 应用类型选择 **Web 应用**
3. 添加已获授权的 JavaScript 来源：
   - `http://localhost:5173`（本地开发）
   - `https://<your-username>.github.io`（GitHub Pages 部署后）
4. 点击创建，记录 **客户端 ID**

### 4. 创建 API Key

1. 进入「API 和服务」→「凭据」→「创建凭据」→「API 密钥」
2. 创建后点击「编辑 API 密钥」→ 在「API 限制」中选择「Google Drive API」
3. 记录 **API Key**

### 5. 配置环境变量

```bash
# 创建 .env 文件（不要提交到 Git）
cat > .env << 'EOF'
VITE_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
VITE_GOOGLE_API_KEY=your-api-key
EOF

# 重启开发服务器
npm run dev
```

### 6. 验证同步

1. 登录时出现 Google OAuth 弹窗
2. 授权后进入 app，进行评分操作
3. 打开 [Google Drive](https://drive.google.com/)，确认「记汉字」文件夹已自动创建
4. 检查文件夹中的 `app_meta.json` 和子文件夹中的 `snapshot.json`、`log.jsonl`

## 多设备共享

1. 在 Google Drive 中将「记汉字」文件夹共享给配偶
2. 配偶用自己的 Google 账号登录 app
3. 双方读写同一份数据，操作日志通过时间戳取并集合并，天然无冲突

## 部署到 GitHub Pages

### 前置条件

- GitHub 仓库已创建
- 仓库 Settings → Pages → Source 设置为 **GitHub Actions**（推荐）

### 部署步骤

```bash
# 1. 确保 vite.config.ts 中 base 配置正确
#    base: '/jihanzi/',   ← 替换为你的仓库名

# 2. 构建
npm run build

# 3. 部署到 GitHub Pages
npm run deploy
# 或手动：npx gh-pages -d dist
```

### GitHub Actions 自动部署（可选）

创建 `.github/workflows/deploy.yml`：

```yaml
name: Deploy to GitHub Pages
on:
  push:
    branches: [master]
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pages: write
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run build
      - uses: actions/configure-pages@v4
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist
      - uses: actions/deploy-pages@v4
```

### 部署后的 Google OAuth 配置

在 Google Cloud Console 的 OAuth 客户端中添加 GitHub Pages 域名：

- `https://<your-username>.github.io`

部署后也需在 `.env` 中更新，或直接在 Vite 环境变量中配置生产值。

## 技术栈

| 层 | 技术 | 用途 |
|----|------|------|
| 框架 | React 18 + TypeScript | UI |
| 构建 | Vite 6 | 打包、HMR |
| 样式 | Tailwind CSS 3 | 响应式设计 |
| 状态管理 | React Context + useReducer | 全局状态 |
| 本地存储 | Dexie.js 4 (IndexedDB) | 离线数据 |
| 云端存储 | Google Drive API v3 | 数据同步 |
| OAuth | Google Identity Services | 前端认证 |
| 拖拽 | @dnd-kit | 生字本排序 |
| PWA | vite-plugin-pwa (Workbox) | Service Worker、离线缓存 |
| 部署 | gh-pages | GitHub Pages |
| 字体 | KaiTi / STKaiti（系统楷体） | 汉字展示 |

## 设计文档

- `docs/design/requirements.txt` — 功能需求与技术架构
- `docs/design/ux.md` — UX 设计与信息架构
- `docs/design/memory_curve.md` — SM-2 记忆曲线算法设计

## 许可

MIT
