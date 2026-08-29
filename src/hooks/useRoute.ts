import { useCallback, useEffect, useState } from 'react'
import { parseHash, routeToHash, type Route } from '../router'

interface UseRouteReturn {
  /** 当前路由（随 hash 变化实时同步） */
  route: Route
  /**
   * 切换到目标路由：默认 push 一条历史记录（系统后退键可返回）；
   * options.replace = true 时替换当前记录（选择器类切换，不污染历史）。
   */
  navigate: (route: Route, options?: { replace?: boolean }) => void
  /**
   * 返回上一页，与系统后退键行为一致。无历史可退时（如直接打开
   * 深链接、刷新后首条记录）回退到 fallback 路由，保证停留在应用内。
   */
  goBack: (fallback: Route) => void
}

/**
 * 把 UI 状态映射到 location.hash 的路由钩子。
 * 组件根据 route 派生自己的展示状态，不再各自持有 useState。
 */
export function useRoute(): UseRouteReturn {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash))

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(window.location.hash))
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const navigate = useCallback((next: Route, options: { replace?: boolean } = {}) => {
    const hash = routeToHash(next)
    // 目标就是当前 hash 时不动作（也不产生多余历史记录）
    if (window.location.hash === hash) return
    if (options.replace) {
      window.location.replace(hash)
    } else {
      window.location.hash = hash
    }
  }, [])

  const goBack = useCallback(
    (fallback: Route) => {
      if (window.history.length > 1) {
        window.history.back()
      } else {
        navigate(fallback, { replace: true })
      }
    },
    [navigate],
  )

  return { route, navigate, goBack }
}
