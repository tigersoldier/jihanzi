import { getPinyin } from '../../utils/chars'

/** 一轮复习写过的字：轮次 + 该轮写过的汉字 */
export interface RoundCharGroup {
  round: number
  chars: string[]
}

interface ReadAloudReminderProps {
  /** 按轮次分组的所写汉字（轮次升序） */
  groups: RoundCharGroup[]
  /** 提醒语，如「请让孩子把这轮写的字读一遍」 */
  message: string
}

/**
 * 朗读提醒：复习完成后，提醒家长让孩子把本轮/本次写的字都读一遍。
 * 每个字附带拼音，便于家长核对读音。
 */
export default function ReadAloudReminder({ groups, message }: ReadAloudReminderProps) {
  if (groups.length === 0) return null

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-left">
      <div className="flex items-start gap-2 mb-3">
        <span className="text-xl leading-none">🗣️</span>
        <p className="text-sm font-medium text-amber-800">{message}</p>
      </div>
      <div className="space-y-3">
        {groups.map(group => (
          <div key={group.round}>
            <p className="text-xs text-amber-600 mb-1.5">第 {group.round} 轮写的字</p>
            <div className="flex flex-wrap gap-2">
              {group.chars.map(char => (
                <div
                  key={char}
                  className="bg-white rounded-xl border border-amber-100 px-3 py-1.5 text-center"
                >
                  <div className="text-2xl font-kai text-gray-800 leading-tight">{char}</div>
                  <div className="text-[10px] text-gray-400 leading-tight mt-0.5">
                    {getPinyin(char)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
