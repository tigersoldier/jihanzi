/**
 * 基于 location.hash 的轻量路由。
 *
 * 应用部署在 GitHub Pages（base 为 /jihanzi/），没有服务端重写，
 * 因此用 hash 承载 UI 状态：切换页面、查看生字等操作 push 一条
 * 历史记录，手机上系统后退键可逐级返回，刷新后也能恢复到
 * 刷新前的页面。
 *
 * URL 语法：
 *   #/progress                               学习进度（本月）
 *   #/progress/<YYYY-MM>                     学习进度，指定月份
 *   #/progress/<YYYY-MM>/<YYYY-MM-DD>        某天详情
 *   #/progress/<YYYY-MM>/<YYYY-MM-DD>/<字>   从某天详情查看生字
 *   #/child                                  孩子
 *   #/wordbook                               生字本
 *   #/wordbook/wb/<生字本id>                  生字本，选中指定字本
 *   #/wordbook/char/<字>                     生字本中查看生字
 *   #/settings                               设置
 *
 * 各页面职责：
 * - 打开子页面（日详情、生字详情、设置）→ push 历史记录
 * - 选择器类切换（月份翻页、切换生字本）→ replace，避免历史记录膨胀
 */

export type Route =
  | { name: 'progress'; month?: string; day?: string; char?: string }
  | { name: 'child' }
  | { name: 'wordbook'; wbId?: string; char?: string }
  | { name: 'settings' }

/** 学习进度路由（含月份 / 日期 / 生字子状态） */
export type ProgressRoute = Extract<Route, { name: 'progress' }>
/** 生字本路由（含选中字本 / 生字子状态） */
export type WordBookRoute = Extract<Route, { name: 'wordbook' }>

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

function decodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg)
  } catch {
    // 非法百分号编码（如手改 URL 产生）——按原样返回
    return seg
  }
}

/** 把 location.hash 解析为 Route。无法识别的路由回退到默认页（学习进度）。 */
export function parseHash(hash: string): Route {
  const segs = hash
    .replace(/^#/, '')
    .split('/')
    .filter(s => s.length > 0)
    .map(decodeSegment)

  switch (segs[0]) {
    case 'progress': {
      const month = segs[1] && MONTH_RE.test(segs[1]) ? segs[1] : undefined
      if (!month) return { name: 'progress' }
      const day = segs[2] && DAY_RE.test(segs[2]) && segs[2].startsWith(month) ? segs[2] : undefined
      if (!day) return { name: 'progress', month }
      const char = segs[3] || undefined
      return char ? { name: 'progress', month, day, char } : { name: 'progress', month, day }
    }
    case 'child':
      return { name: 'child' }
    case 'wordbook':
      if (segs[1] === 'wb' && segs[2]) return { name: 'wordbook', wbId: segs[2] }
      if (segs[1] === 'char' && segs[2]) return { name: 'wordbook', char: segs[2] }
      return { name: 'wordbook' }
    case 'settings':
      return { name: 'settings' }
    default:
      return { name: 'progress' }
  }
}

/** 把 Route 序列化为 location.hash。 */
export function routeToHash(route: Route): string {
  switch (route.name) {
    case 'progress': {
      let hash = '#/progress'
      if (route.month) {
        hash += `/${route.month}`
        if (route.day) {
          hash += `/${route.day}`
          if (route.char) hash += `/${encodeURIComponent(route.char)}`
        }
      }
      return hash
    }
    case 'child':
      return '#/child'
    case 'wordbook':
      if (route.char) return `#/wordbook/char/${encodeURIComponent(route.char)}`
      if (route.wbId) return `#/wordbook/wb/${encodeURIComponent(route.wbId)}`
      return '#/wordbook'
    case 'settings':
      return '#/settings'
  }
}
