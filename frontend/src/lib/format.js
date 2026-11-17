/**
 * Display formatting — the one place money, dates, names and labels are turned
 * into text. Pages import from here instead of keeping their own copies.
 */
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime.js'

dayjs.extend(relativeTime)

const NBSP = ' '

/**
 * Rands: "R 12 345.67" (space thousands, point decimal, matching the number inputs).
 * null / undefined / '' → the fallback (default "—").
 */
export function money(value, { fallback = '—', currency = 'ZAR' } = {}) {
  if (value === null || value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const [whole, cents] = Math.abs(n).toFixed(2).split('.')
  const symbol = !currency || currency === 'ZAR' ? 'R' : currency
  return `${n < 0 ? '-' : ''}${symbol}${NBSP}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP)}.${cents}`
}

/** "3 Oct 2026" */
export const date = (v, fallback = '—') => (v ? dayjs(v).format('D MMM YYYY') : fallback)

/** "3 Oct 2026, 14:05" */
export const dateTime = (v, fallback = '—') => (v ? dayjs(v).format('D MMM YYYY, HH:mm') : fallback)

/** "3 Oct" this year, "3 Oct 2025" otherwise */
export const shortDate = (v, fallback = '—') => {
  if (!v) return fallback
  const d = dayjs(v)
  return d.isSame(dayjs(), 'year') ? d.format('D MMM') : d.format('D MMM YYYY')
}

/** "2 days ago" / "in 3 hours" */
export const fromNow = (v, fallback = '') => (v ? dayjs(v).fromNow() : fallback)

/** Short time for list rows: 14:05 today, "Yesterday", weekday this week, else 3 Oct. */
export function listTime(value) {
  if (!value) return ''
  const t = dayjs(value)
  const now = dayjs()
  if (t.isSame(now, 'day')) return t.format('HH:mm')
  if (t.isSame(now.subtract(1, 'day'), 'day')) return 'Yesterday'
  if (now.diff(t, 'day') < 7) return t.format('ddd')
  return shortDate(value)
}

/** "Today" / "Yesterday" / "Monday 3 October" / "3 October 2025" — chat day dividers. */
export function dayLabel(value) {
  const d = dayjs(value)
  const now = dayjs()
  if (d.isSame(now, 'day')) return 'Today'
  if (d.isSame(now.subtract(1, 'day'), 'day')) return 'Yesterday'
  return d.isSame(now, 'year') ? d.format('dddd D MMMM') : d.format('D MMMM YYYY')
}

/** First letter of a name, upper case ("?" when empty). */
export const initial = (name) => (String(name ?? '').trim()[0] ?? '?').toUpperCase()

/** Up to two initials: "Thabo Nkosi" → "TN". */
export const initials = (name = '') =>
  String(name ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?'

/** snake_case / UPPER_CASE / "Left Chest" → "Left chest" (sentence case). */
export function sentence(value) {
  const s = String(value ?? '').replace(/_/g, ' ').trim().toLowerCase()
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''
}

/** "1 unit" / "3 units" */
export const plural = (n, one, many = `${one}s`) => `${n} ${Number(n) === 1 ? one : many}`

/** Lower-case the first letter (for "Before you can approve: add at least …"). */
export const lowerFirst = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : '')

/** A ticket's number as clients see it: the first 8 characters of its id, upper case ("3F2A9C1D"). */
export const ticketNo = (id) => String(id ?? '').slice(0, 8).toUpperCase()
