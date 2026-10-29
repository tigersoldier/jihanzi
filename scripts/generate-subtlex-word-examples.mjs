#!/usr/bin/env node
/**
 * 从 SUBTLEX-CH-WF 生成按字索引的离线词例。
 * 用法：node scripts/generate-subtlex-word-examples.mjs /path/to/SUBTLEX-CH-WF
 */

import { readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { TextDecoder } from 'node:util'
import { fileURLToPath, URL } from 'node:url'

const inputPath = process.argv[2]
if (!inputPath) {
  process.stderr.write(
    '用法：node scripts/generate-subtlex-word-examples.mjs /path/to/SUBTLEX-CH-WF\n',
  )
  process.exit(1)
}

const outputPath =
  process.argv[3] ??
  fileURLToPath(new URL('../src/utils/subtlexWordExamples.json', import.meta.url))
let text
let unsuitableTerms
try {
  text = new TextDecoder('gb18030').decode(await readFile(inputPath))
  unsuitableTerms = JSON.parse(
    await readFile(new URL('./word-example-safety-terms.json', import.meta.url), 'utf8'),
  )
} catch (error) {
  process.stderr.write(
    `无法读取词频或过滤规则：${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exit(1)
}
if (
  !Array.isArray(unsuitableTerms) ||
  !unsuitableTerms.every(term => typeof term === 'string' && term.length > 0)
) {
  throw new Error('不适龄词例过滤规则格式不符合预期')
}
const safeWordExampleExceptions = new Set(['高潮迭起', '放荡不羁', '杀手锏'])
const isUnsuitableWord = word =>
  !safeWordExampleExceptions.has(word) && unsuitableTerms.some(term => word.includes(term))
const lines = text.split(/\r?\n/)
const headers = lines[2]?.split('\t')
if (!headers) throw new Error('词频文件缺少表头')

const wordColumn = headers.indexOf('Word')
const countColumn = headers.indexOf('WCount')
const contextColumn = headers.indexOf('W-CD')
if ([wordColumn, countColumn, contextColumn].some(index => index < 0)) {
  throw new Error('词频文件表头不符合预期')
}

const candidates = []
let skippedUnsuitable = 0
for (const line of lines.slice(3)) {
  const columns = line.split('\t')
  const word = columns[wordColumn]
  if (!/^\p{Script=Han}{2,4}$/u.test(word ?? '')) continue

  const count = Number(columns[countColumn])
  const contexts = Number(columns[contextColumn])
  if (!Number.isFinite(count) || contexts < 10) continue
  if (isUnsuitableWord(word)) {
    skippedUnsuitable += 1
    continue
  }
  candidates.push({ word, count, contexts })
}

// 优先跨更多影视语境出现的词，再按总词频排序，降低单一作品/人名的影响。
candidates.sort((left, right) => {
  if (left.contexts !== right.contexts) return right.contexts - left.contexts
  if (left.count !== right.count) return right.count - left.count
  if (left.word < right.word) return -1
  if (left.word > right.word) return 1
  return 0
})

const maxExamplesPerCharacter = 3
const examplesByCharacter = Object.create(null)
for (const { word } of candidates) {
  for (const character of new Set(word)) {
    const examples = (examplesByCharacter[character] ??= [])
    if (examples.length < maxExamplesPerCharacter && !examples.includes(word)) {
      examples.push(word)
    }
  }
}

const serializedIndex = Object.entries(examplesByCharacter)
  .map(
    ([character, words]) =>
      `  ${JSON.stringify(character)}: [${words.map(word => JSON.stringify(word)).join(', ')}]`,
  )
  .join(',\n')
await writeFile(outputPath, `{\n${serializedIndex}\n}\n`)
process.stdout.write(
  `生成 ${Object.keys(examplesByCharacter).length} 个汉字的词例（${candidates.length} 个候选词；过滤不适龄词 ${skippedUnsuitable} 条）：${outputPath}\n`,
)
