/**
 * Character Metadata Utilities
 *
 * Provides pinyin and word examples for Chinese characters.
 * This is a minimal built-in dataset. In a production app, this would
 * be replaced with a comprehensive dictionary API or dataset.
 */

interface CharInfo {
  pinyin: string
  words: string[]
}

/**
 * Built-in character metadata database.
 * Contains common elementary school characters.
 * This will be extended or replaced with an external data source.
 */
const CHAR_DATABASE: Record<string, CharInfo> = {
  '一': { pinyin: 'yī', words: ['一个', '第一', '唯一'] },
  '二': { pinyin: 'èr', words: ['二月', '第二', '二手'] },
  '三': { pinyin: 'sān', words: ['三月', '再三', '三角'] },
  '四': { pinyin: 'sì', words: ['四月', '四周', '四季'] },
  '五': { pinyin: 'wǔ', words: ['五月', '五星', '五彩'] },
  '六': { pinyin: 'liù', words: ['六月', '六角', '六艺'] },
  '七': { pinyin: 'qī', words: ['七月', '七夕', '七彩'] },
  '八': { pinyin: 'bā', words: ['八月', '八方', '八成'] },
  '九': { pinyin: 'jiǔ', words: ['九月', '九霄', '九牛'] },
  '十': { pinyin: 'shí', words: ['十月', '十足', '十年'] },
  '上': { pinyin: 'shàng', words: ['上学', '上升', '上下'] },
  '下': { pinyin: 'xià', words: ['下午', '下雨', '下课'] },
  '大': { pinyin: 'dà', words: ['大人', '大家', '大小'] },
  '小': { pinyin: 'xiǎo', words: ['小孩', '小心', '小学'] },
  '人': { pinyin: 'rén', words: ['人们', '人生', '人口'] },
  '口': { pinyin: 'kǒu', words: ['门口', '口水', '开口'] },
  '手': { pinyin: 'shǒu', words: ['手机', '手工', '洗手'] },
  '日': { pinyin: 'rì', words: ['日出', '日月', '生日'] },
  '月': { pinyin: 'yuè', words: ['月亮', '月光', '明月'] },
  '水': { pinyin: 'shuǐ', words: ['水果', '水面', '河水'] },
  '火': { pinyin: 'huǒ', words: ['火车', '火光', '大火'] },
  '山': { pinyin: 'shān', words: ['山上', '山水', '高山'] },
  '石': { pinyin: 'shí', words: ['石头', '石子', '宝石'] },
  '田': { pinyin: 'tián', words: ['田地', '田野', '农田'] },
  '木': { pinyin: 'mù', words: ['木头', '树木', '草木'] },
  '草': { pinyin: 'cǎo', words: ['草地', '草原', '青草'] },
  '鸟': { pinyin: 'niǎo', words: ['鸟儿', '小鸟', '飞鸟'] },
  '虫': { pinyin: 'chóng', words: ['虫子', '昆虫', '小虫'] },
  '鱼': { pinyin: 'yú', words: ['鱼儿', '金鱼', '钓鱼'] },
  '天': { pinyin: 'tiān', words: ['天空', '今天', '明天'] },
  '地': { pinyin: 'dì', words: ['地方', '地图', '大地'] },
  '风': { pinyin: 'fēng', words: ['风吹', '大风', '风景'] },
  '雨': { pinyin: 'yǔ', words: ['下雨', '雨伞', '暴雨'] },
  '云': { pinyin: 'yún', words: ['白云', '乌云', '云朵'] },
  '雪': { pinyin: 'xuě', words: ['雪花', '下雪', '白雪'] },
  '中': { pinyin: 'zhōng', words: ['中国', '中心', '中午'] },
  '国': { pinyin: 'guó', words: ['国家', '中国', '外国'] },
  '学': { pinyin: 'xué', words: ['学习', '学生', '学校'] },
  '生': { pinyin: 'shēng', words: ['生活', '学生', '生日'] },
  '字': { pinyin: 'zì', words: ['字体', '汉字', '名字'] },
  '书': { pinyin: 'shū', words: ['书本', '读书', '书包'] },
  '好': { pinyin: 'hǎo', words: ['你好', '好事', '好看'] },
  '不': { pinyin: 'bù', words: ['不是', '不好', '不同'] },
  '白': { pinyin: 'bái', words: ['白色', '白天', '明白'] },
  '红': { pinyin: 'hóng', words: ['红色', '红花', '火红'] },
  '来': { pinyin: 'lái', words: ['回来', '过来', '未来'] },
  '去': { pinyin: 'qù', words: ['回去', '出去', '过去'] },
  '走': { pinyin: 'zǒu', words: ['走路', '行走', '走动'] },
  '跑': { pinyin: 'pǎo', words: ['跑步', '奔跑', '跑车'] },
  '看': { pinyin: 'kàn', words: ['看见', '看书', '好看'] },
  '听': { pinyin: 'tīng', words: ['听见', '听话', '听力'] },
  '说': { pinyin: 'shuō', words: ['说话', '听说', '小说'] },
  '写': { pinyin: 'xiě', words: ['写字', '书写', '写作'] },
  '读': { pinyin: 'dú', words: ['读书', '阅读', '朗读'] },
  '坐': { pinyin: 'zuò', words: ['坐下', '乘坐', '坐车'] },
  '立': { pinyin: 'lì', words: ['站立', '立即', '独立'] },
  '见': { pinyin: 'jiàn', words: ['看见', '再见', '见面'] },
  '门': { pinyin: 'mén', words: ['门口', '大门', '开门'] },
  '马': { pinyin: 'mǎ', words: ['马上', '白马', '骑马'] },
  '牛': { pinyin: 'niú', words: ['牛奶', '小牛', '水牛'] },
  '羊': { pinyin: 'yáng', words: ['山羊', '羊毛', '白羊'] },
  '左': { pinyin: 'zuǒ', words: ['左边', '左手', '左右'] },
  '右': { pinyin: 'yòu', words: ['右边', '右手', '左右'] },
  '前': { pinyin: 'qián', words: ['前面', '前天', '前进'] },
  '后': { pinyin: 'hòu', words: ['后面', '后天', '后来'] },
  '多': { pinyin: 'duō', words: ['多少', '很多', '许多'] },
  '少': { pinyin: 'shǎo', words: ['多少', '少量', '少年'] },
  '男': { pinyin: 'nán', words: ['男孩', '男人', '男生'] },
  '女': { pinyin: 'nǚ', words: ['女孩', '女人', '女生'] },
  '爸': { pinyin: 'bà', words: ['爸爸', '老爸'] },
  '妈': { pinyin: 'mā', words: ['妈妈', '老妈'] },
  '哥': { pinyin: 'gē', words: ['哥哥', '大哥', '表哥'] },
  '弟': { pinyin: 'dì', words: ['弟弟', '小弟', '兄弟'] },
  '姐': { pinyin: 'jiě', words: ['姐姐', '大姐', '姐妹'] },
  '妹': { pinyin: 'mèi', words: ['妹妹', '小妹', '姐妹'] },
  '家': { pinyin: 'jiā', words: ['家人', '回家', '大家'] },
  '爱': { pinyin: 'ài', words: ['爱心', '可爱', '热爱'] },
  '笑': { pinyin: 'xiào', words: ['笑声', '微笑', '大笑'] },
  '哭': { pinyin: 'kū', words: ['哭泣', '大哭', '哭声'] },
  '春': { pinyin: 'chūn', words: ['春天', '春风', '春节'] },
  '夏': { pinyin: 'xià', words: ['夏天', '盛夏', '立夏'] },
  '秋': { pinyin: 'qiū', words: ['秋天', '秋风', '中秋'] },
  '冬': { pinyin: 'dōng', words: ['冬天', '寒冬', '立冬'] },
  '早': { pinyin: 'zǎo', words: ['早上', '早晨', '早安'] },
  '晚': { pinyin: 'wǎn', words: ['晚上', '夜晚', '晚安'] },
  '星': { pinyin: 'xīng', words: ['星星', '星光', '星球'] },
  '阳': { pinyin: 'yáng', words: ['太阳', '阳光', '夕阳'] },
  '光': { pinyin: 'guāng', words: ['光芒', '灯光', '光明'] },
  '河': { pinyin: 'hé', words: ['河水', '小河', '黄河'] },
  '海': { pinyin: 'hǎi', words: ['大海', '海水', '海洋'] },
  '江': { pinyin: 'jiāng', words: ['江水', '长江', '江边'] },
  '湖': { pinyin: 'hú', words: ['湖水', '湖泊', '江湖'] },
  '叶': { pinyin: 'yè', words: ['叶子', '树叶', '红叶'] },
}

import type { WordBook } from '../core/types'

/**
 * Check whether a single character is a Chinese (Han) character.
 * Uses Unicode property escapes to cover all CJK planes,
 * including Extension A–G in supplementary planes.
 */
export function isChineseChar(char: string): boolean {
  if (!char || char.length === 0) return false
  // \p{Script=Han} matches all Han characters across all Unicode planes
  return /^\p{Script=Han}$/u.test(char)
}

/**
 * Validate that a character can be added to a word book.
 * Throws if the character is not Chinese or already exists in the book.
 */
export function validateAddChar(character: string, wordBook: WordBook): void {
  if (!isChineseChar(character)) {
    throw new Error(`"${character}" 不是汉字，不能添加到生字本`)
  }
  if (wordBook.characters.includes(character)) {
    throw new Error(`"${character}" 已在生字本中，不能重复添加`)
  }
}

/**
 * Get character information (pinyin + words).
 * Returns placeholder data if the character is not in the built-in database.
 */
export function getCharInfo(char: string): CharInfo {
  const info = CHAR_DATABASE[char]
  if (info) return info

  // Return placeholder for unknown characters
  return {
    pinyin: '?',
    words: [],
  }
}

/**
 * Get pinyin for a character.
 */
export function getPinyin(char: string): string {
  return getCharInfo(char).pinyin
}

/**
 * Get example words for a character.
 */
export function getWords(char: string): string[] {
  return getCharInfo(char).words
}
