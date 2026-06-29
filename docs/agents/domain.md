# 领域文档

工程类技能在探索代码库时，应如何读取本仓库的领域文档。

## 探索前，先阅读以下内容

- **仓库根目录下的 `CONTEXT.md`**，或者
- 如果存在 **仓库根目录下的 `CONTEXT-MAP.md`** ——它指向每个上下文对应的 `CONTEXT.md`。阅读与当前主题相关的每一份。
- **`docs/adr/`** ——阅读与你即将涉及的领域相关的 ADR。在多上下文仓库中，还需检查 `src/<context>/docs/adr/` 中上下文级别的决策。

如果上述任何文件不存在，**静默继续**。不要标记其缺失；不要主动建议创建它们。`/domain-modeling` 技能（通过 `/grill-with-docs` 和 `/improve-codebase-architecture` 调用）会在术语或决策实际确定时按需创建。

## 文件结构

单上下文仓库（大多数仓库）：

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

多上下文仓库（根目录存在 `CONTEXT-MAP.md`）：

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← 系统级决策
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← 上下文级别的决策
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## 使用术语表的词汇

当你在输出中命名一个领域概念时（issue 标题、重构提案、假设、测试名称），请使用 `CONTEXT.md` 中定义的术语。不要偏离到术语表明确避免的同义词上。

如果你需要的概念尚未出现在术语表中，这是一个信号——要么你正在编造项目并不使用的语言（请重新考虑），要么确实存在空白（记录下来交给 `/domain-modeling`）。

## 标记 ADR 冲突

如果你的输出与现有 ADR 相矛盾，请明确指出来，而不是默默覆盖：

> _与 ADR-0007（事件溯源订单）相矛盾——但值得重新讨论，因为……_
