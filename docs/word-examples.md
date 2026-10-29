# 组词词例数据来源

## SUBTLEX-CH

本项目的离线词例索引由以下公开数据筛选生成：

- Cai, Qing, and Marc Brysbaert. 2010. “SUBTLEX-CH: Chinese Word and Character Frequencies Based on Film Subtitles.” *PLOS ONE* 5(6): e10729. <https://doi.org/10.1371/journal.pone.0010729>
- 数据附件：Supporting Information File S1（包含 `SUBTLEX-CH-WF` 词频表）。<https://doi.org/10.1371/journal.pone.0010729.s002>
- 许可：论文页面声明采用 Creative Commons Attribution License（CC BY）；PLOS 的许可说明也将 supporting information 纳入 CC BY，除非某个文件另有声明。再分发词例索引时应保留上述署名和来源链接。

`src/utils/subtlexWordExamples.json` 是从词频表筛选出的派生索引，不包含原始词频数值。生成规则为：只取 2–4 个汉字的词，要求出现在至少 10 个字幕语境（`W-CD >= 10`），排除 `scripts/word-example-safety-terms.json` 中列出的不适龄词项，再按语境数、总词频降序排列，每字保留前三词。该附件共有 99,121 个词条；当前索引覆盖 3,788 个汉字。应用运行时只加载精简索引，不访问网络。

每字展示顺序仍由 `src/utils/chars.ts` 管理：原有人工精选词例优先，其次是儿童常用词表，最后才使用 SUBTLEX-CH 词频例词。过滤词项集中维护在 `scripts/word-example-safety-terms.json`，SUBTLEX 和 MteH 的生成器共用，避免粗俗辱骂、性羞辱、露骨成人内容以及明显血腥、自伤和严重暴力例词进入复习卡片。过滤项按完整词义审定，生成器按词项片段匹配；对含过滤片段但语义中性的固定表达（如“高潮迭起”“放荡不羁”“杀手锏”）保留显式例外，避免仅因单字敏感而误删。这样保留更适合儿童学习的用词，同时扩大生僻字覆盖。

### 重新生成索引

1. 从 Supporting Information File S1 下载 ZIP，并解压出 `SUBTLEX-CH-WF` 文件。
2. 运行：

   ```bash
   node scripts/generate-subtlex-word-examples.mjs /path/to/SUBTLEX-CH-WF
   ```

脚本只依赖 Node.js 内置模块，默认覆盖生成 `src/utils/subtlexWordExamples.json`。

## MteH

MteH v0.1.3 为每个汉字提供一条短语或成语提示。本项目使用其 `Hint` 字段，补足 SUBTLEX-CH 索引未覆盖的字符。来源文件与项目说明：

- Rebecca J. Stones, [MteH v0.1.3](https://github.com/becky82/mteh/tree/main/versions/v0.1.3)，来源文件：[`mteh_v0.1.3.txt`](https://github.com/becky82/mteh/blob/main/versions/v0.1.3/mteh_v0.1.3.txt)。
- 许可：MteH 仓库声明为 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)。再分发时保留作者与来源署名；本项目筛选后的派生词例索引也按 CC BY-SA 4.0 提供，并注明筛选修改。

`src/utils/mtehWordExamples.json` 仅保留 2–4 个汉字、包含目标字、且未被 SUBTLEX-CH 覆盖的提示；并使用与 SUBTLEX 相同的过滤词项表排除明显不适合儿童复习卡片的内容。每个字最多一条。MteH 提示可能是成语、短语或专名，应用只在精选词、儿童常用词和 SUBTLEX-CH 词例之后使用，且每字总计最多展示三词。

### 重新生成 MteH 补充索引

1. 下载上方链接的 `mteh_v0.1.3.txt`。
2. 运行：

   ```bash
   node scripts/generate-mteh-word-examples.mjs /path/to/mteh_v0.1.3.txt
   ```

脚本只依赖 Node.js 内置模块，默认生成 `src/utils/mtehWordExamples.json`。索引只保留 SUBTLEX-CH 未覆盖的字，以减少重复数据；过滤规则和派生词表均保留在项目中，便于复现。
