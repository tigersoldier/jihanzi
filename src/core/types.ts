// ============================================================
// Core Type Definitions for 记汉字
// ============================================================

/** Rating grades for character review */
export type Grade = 'a' | 'b' | 'c' | 'd'

/** SM-2 algorithm state for a single character for a single child */
export interface SM2State {
  ease: number // Ease factor (start 2.5, min 1.3)
  interval: number // Current interval in days
  repetitions: number // Number of successful repetitions
  nextReview: string // ISO date string for next review
  lastGrade: Grade // The most recent review grade
  firstReviewDay: string // DayKey of the first review — materialised in snapshot
}

/** A word book — ordered list of characters to learn */
export interface WordBook {
  id: string
  name: string
  characters: string[] // Ordered list of characters
}

/** A child/learner */
export interface Child {
  id: string
  name: string
  wordBookId: string // Reference to the word book
  nextCharIndex: number // Next character index to learn from the word book
  progress: Record<string, SM2State> // char → SM-2 state
}

/** App-level settings */
export interface Settings {
  dailyReviewLimit: number // Default 30
  dailyNewChars: number // Default 5
  maxRounds: number // Default 3
}

/** Types of log entries */
export type LogEntryType =
  | 'create_child'
  | 'update_child'
  | 'delete_child'
  | 'create_wordbook'
  | 'update_wordbook'
  | 'delete_wordbook'
  | 'add_char'
  | 'remove_char'
  | 'reorder_chars'
  | 'review'
  | 'present_chars'
  | 'update_settings'

/** Base log entry */
export interface LogEntry {
  timestamp: number // Unix ms
  type: LogEntryType
}

/** Create a child */
export interface CreateChildEntry extends LogEntry {
  type: 'create_child'
  childId: string
  name: string
  wordBookId: string
}

/** Update a child (rename, reassign wordbook) */
export interface UpdateChildEntry extends LogEntry {
  type: 'update_child'
  childId: string
  name?: string
  wordBookId?: string
}

/** Delete a child */
export interface DeleteChildEntry extends LogEntry {
  type: 'delete_child'
  childId: string
}

/** Create a word book */
export interface CreateWordBookEntry extends LogEntry {
  type: 'create_wordbook'
  wordBookId: string
  name: string
  characters: string[]
}

/** Update a word book name */
export interface UpdateWordBookEntry extends LogEntry {
  type: 'update_wordbook'
  wordBookId: string
  name?: string
}

/** Delete a word book */
export interface DeleteWordBookEntry extends LogEntry {
  type: 'delete_wordbook'
  wordBookId: string
}

/** Add a character to a word book */
export interface AddCharEntry extends LogEntry {
  type: 'add_char'
  wordBookId: string
  character: string
  index: number // position in the list
}

/** Remove a character from a word book */
export interface RemoveCharEntry extends LogEntry {
  type: 'remove_char'
  wordBookId: string
  character: string
  index: number
}

/** Reorder characters in a word book */
export interface ReorderCharsEntry extends LogEntry {
  type: 'reorder_chars'
  wordBookId: string
  characters: string[] // new full order
}

/** Review a character */
export interface ReviewEntry extends LogEntry {
  type: 'review'
  childId: string
  character: string
  grade: Grade
  round: number // 1, 2, or 3
  dayKey: string // "YYYY-MM-DD" — the day this review belongs to
}

/** Batch-present new characters (learn day presenting phase) */
export interface PresentCharsEntry extends LogEntry {
  type: 'present_chars'
  childId: string
  characters: string[] // All new chars shown in one presenting session
  dayKey: string
}

/** Update settings */
export interface UpdateSettingsEntry extends LogEntry {
  type: 'update_settings'
  settings: Partial<Settings>
}

/** Union of all log entry types */
export type AnyLogEntry =
  | CreateChildEntry
  | UpdateChildEntry
  | DeleteChildEntry
  | CreateWordBookEntry
  | UpdateWordBookEntry
  | DeleteWordBookEntry
  | AddCharEntry
  | RemoveCharEntry
  | ReorderCharsEntry
  | ReviewEntry
  | PresentCharsEntry
  | UpdateSettingsEntry

/** Reconstructed application state */
export interface AppState {
  children: Child[]
  wordBooks: WordBook[]
  settings: Settings
}

/** Snapshot of app state at a point in time */
export interface Snapshot {
  timestamp: number // Unix ms — snapshot save time (wall clock)
  /**
   * 日志水位：快照状态已包含所有 timestamp ≤ appliedThrough 的日志效果。
   *
   * 历史教训：重放过滤曾用 snapshot.timestamp（墙钟）当水位，时钟回拨/跨设备
   * 偏移时会把已物化的条目再应用一遍（重复计算）或漏掉新条目。水位取
   * "最后应用条目的 timestamp"，与墙钟解耦。
   *
   * 可选字段：旧版快照无此字段（回退用 timestamp），其缺失本身也是
   * "旧代码产物"标记——同步采纳时触发逐字校验（见 sync.ts）。
   */
  appliedThrough?: number
  state: AppState
}

/** A single task in today's queue */
export interface TaskItem {
  character: string
  pinyin: string
  words: string[]
  isNew: boolean // Is this a new character (first time)?
  isReview: boolean // Is this a review character?
  sm2State?: SM2State // Current SM-2 state (undefined for new chars)
}

/** Day type */
export type DayType = 'learn' | 'review'

/** Default settings */
export const DEFAULT_SETTINGS: Settings = {
  dailyReviewLimit: 30,
  dailyNewChars: 5,
  maxRounds: 3,
}

/** Grade to SM-2 quality score mapping */
export const GRADE_TO_Q: Record<Grade, number> = {
  a: 5,
  b: 3,
  c: 2,
  d: 0,
}

/** Human-readable Chinese labels for each grade */
export const GRADE_LABELS: Record<Grade, string> = {
  a: '完全掌握',
  b: '部分正确',
  c: '需提示',
  d: '遗忘',
}

/** Tailwind color classes for each grade */
export const GRADE_COLORS: Record<Grade, string> = {
  a: 'bg-green-100 text-green-700',
  b: 'bg-blue-100 text-blue-700',
  c: 'bg-yellow-100 text-yellow-700',
  d: 'bg-red-100 text-red-700',
}

/** SM-2 constants (from the algorithm authors, not adjustable) */
export const SM2_INITIAL_EASE = 2.5
export const SM2_MIN_EASE = 1.3
export const SM2_INITIAL_INTERVAL = 1

/**
 * 间隔天数上限（100 年）。
 *
 * 防御纵深：正常 SM-2 复习链（连续 a 评级）需要 11+ 次才能触达该值，
 * 实际使用中不可能达到。若日志重复条目被多次应用（同步 bug 的历史教训），
 * interval 会按 ease 指数爆炸，此上限保证最坏情况下仍得到合法日期，
 * 而不是 "NaN-NaN-NaN"。
 */
export const MAX_SANE_INTERVAL_DAYS = 36500
