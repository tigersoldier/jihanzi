# Issue 跟踪器：GitHub

本仓库的 issue 和 PRD 以 GitHub issue 的形式存在。所有操作使用 `gh` CLI。

## 使用惯例

- **创建 issue**：`gh issue create --title "..." --body "..."`。多行正文使用 heredoc。
- **查看 issue**：`gh issue view <number> --comments`，用 `jq` 过滤评论并获取标签。
- **列出 issue**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，配合适当的 `--label` 和 `--state` 筛选。
- **评论 issue**：`gh issue comment <number> --body "..."`
- **添加 / 移除标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭**：`gh issue close <number> --comment "..."`

仓库信息从 `git remote -v` 推断——在 clone 的仓库内运行 `gh` 会自动识别。

## Pull Request 作为分流入口

**PR 作为请求入口：是。**

PR 与 issue 经过相同的标签和状态流转，使用对应的 `gh pr` 命令：

- **查看 PR**：`gh pr view <number> --comments`，用 `gh pr diff <number>` 查看差异。
- **列出待分流的第三方 PR**：`gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`，然后仅保留 `authorAssociation` 为 `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR` 或 `NONE` 的条目（排除 `OWNER`/`MEMBER`/`COLLABORATOR`）。
- **评论 / 标签 / 关闭**：`gh pr comment`、`gh pr edit --add-label`/`--remove-label`、`gh pr close`。

GitHub 的 issue 和 PR 共用同一编号空间，因此单独的 `#42` 可能指代两者——先用 `gh pr view 42` 解析，失败则回退到 `gh issue view 42`。

## 当某个技能说"发布到 issue 跟踪器"

创建一个 GitHub issue。

## 当某个技能说"获取相关工单"

运行 `gh issue view <number> --comments`。
