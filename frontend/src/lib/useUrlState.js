/**
 * useUrlState(defaults) — list filters / search / page kept in the URL query
 * string, so Back (e.g. from a job to the board) returns to the same view and
 * filtered views can be linked to (dashboard cells → /jobs?state=PRICING).
 *
 *   const [state, set] = useUrlState({ state: '', q: '', page: 1 })
 *   set({ state: 'PRICING' })        // resets page to 1 unless page is given
 */
import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'

export function useUrlState(defaults) {
  const [params, setParams] = useSearchParams()
  const key = JSON.stringify(defaults)

  const state = useMemo(() => {
    const d = JSON.parse(key)
    const out = {}
    for (const [k, def] of Object.entries(d)) {
      const raw = params.get(k)
      if (raw === null) out[k] = def
      else if (typeof def === 'number') out[k] = Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : def
      else if (typeof def === 'boolean') out[k] = raw === 'true'
      else out[k] = raw
    }
    return out
  }, [params, key])

  const set = useCallback((patch) => {
    setParams((prev) => {
      const d = JSON.parse(key)
      const next = new URLSearchParams(prev)
      const p = { ...patch }
      if (!('page' in p) && 'page' in d) p.page = d.page
      for (const [k, v] of Object.entries(p)) {
        if (v === undefined || v === null || v === '' || v === d[k] || v === false) next.delete(k)
        else next.set(k, String(v))
      }
      return next
    }, { replace: true })
  }, [setParams, key])

  return [state, set]
}

export default useUrlState
