#!/usr/bin/env node
/**
 * 从 MteH v0.1.3 生成补充词例索引。
 * 用法：node scripts/generate-mteh-word-examples.mjs /path/to/mteh_v0.1.3.txt
 */

import { readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'

const inputPath = process.argv[2]
if (!inputPath) {
  process.stderr.write(
    '用法：node scripts/generate-mteh-word-examples.mjs /path/to/mteh_v0.1.3.txt\n',
  )
  process.exit(1)
}

const subtlexPath = fileURLToPath(new URL('../src/utils/subtlexWordExamples.json', import.meta.url))
const safetyTermsPath = new URL('./word-example-safety-terms.json', import.meta.url)
const outputPath =
  process.argv[3] ?? fileURLToPath(new URL('../src/utils/mtehWordExamples.json', import.meta.url))
let subtlexExamples
let source
let unsuitableTerms
try {
  subtlexExamples = JSON.parse(await readFile(subtlexPath, 'utf8'))
  source = await readFile(inputPath, 'utf8')
  unsuitableTerms = JSON.parse(await readFile(safetyTermsPath, 'utf8'))
} catch (error) {
  process.stderr.write(
    `无法读取词例数据：${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exit(1)
}
if (
  !Array.isArray(unsuitableTerms) ||
  !unsuitableTerms.every(term => typeof term === 'string' && term.length > 0)
) {
  throw new Error('不适龄词例过滤规则格式不符合预期')
}
const isUnsuitableWord = word => unsuitableTerms.some(term => word.includes(term))
const subtlexCharacters = new Set(Object.keys(subtlexExamples))
const rows = source.split(/\r?\n/).filter(line => line.trim() && !line.trimStart().startsWith('#'))
const examplesByCharacter = Object.create(null)
let skippedUnsafe = 0
let skippedInvalid = 0
let skippedSubtlex = 0

for (const line of rows) {
  const columns = line.trim().split(/\s+/u)
  if (columns.length !== 6) {
    skippedInvalid += 1
    continue
  }

  const [character, , hint] = columns
  if (
    !/^\p{Script=Han}$/u.test(character) ||
    !/^\p{Script=Han}{2,4}$/u.test(hint) ||
    !hint.includes(character)
  ) {
    skippedInvalid += 1
    continue
  }
  if (isUnsuitableWord(hint)) {
    skippedUnsafe += 1
    continue
  }
  if (subtlexCharacters.has(character)) {
    skippedSubtlex += 1
    continue
  }

  // 每个字只保留 MteH 原有的一条提示，且避免重复行覆盖前一条。
  if (!examplesByCharacter[character]) examplesByCharacter[character] = [hint]
}

if (rows.length < 4000) {
  throw new Error(`MteH 源文件行数异常：预期至少 4000 行，实际 ${rows.length} 行`)
}

const serializedIndex = Object.entries(examplesByCharacter)
  .map(([character, words]) => `  ${JSON.stringify(character)}: ${JSON.stringify(words)}`)
  .join(',\n')
await writeFile(outputPath, `{\n${serializedIndex}\n}\n`)
process.stdout.write(
  `生成 ${Object.keys(examplesByCharacter).length} 个汉字的 MteH 补充词例；` +
    `跳过不适龄 ${skippedUnsafe} 条、格式不符 ${skippedInvalid} 条、` +
    `已由 SUBTLEX 覆盖 ${skippedSubtlex} 条：${outputPath}\n`,
)
