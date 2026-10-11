import { isLearningKaiGlyphSupported } from './learningFontCoverage'

export const LEARNING_KAI_FAMILY = 'LXGW WenKai GB Lite'

let fontLoadPromise: Promise<void> | null = null

/** 加载随应用分发的楷体；不支持的字或加载失败时拒绝显示汉字。 */
export function loadLearningKaiFont(character: string): Promise<void> {
  if (!isLearningKaiGlyphSupported(character)) {
    return Promise.reject(new Error('该字不在内嵌楷体字库中'))
  }

  if (typeof document === 'undefined' || !document.fonts) {
    return Promise.reject(new Error('当前环境不支持网页字体加载'))
  }

  if (!fontLoadPromise) {
    fontLoadPromise = document.fonts
      .load(`400 16px "${LEARNING_KAI_FAMILY}"`, '一')
      .then(faces => {
        if (!faces.some(face => face.family === LEARNING_KAI_FAMILY && face.status === 'loaded')) {
          throw new Error('内嵌楷体加载失败')
        }
      })
      .catch(error => {
        fontLoadPromise = null
        throw error
      })
  }

  return fontLoadPromise
}
