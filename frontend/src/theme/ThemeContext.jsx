import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { flushSync } from 'react-dom'
import { ConfigProvider, theme as antTheme } from 'antd'

/*
 * Light "workroom" theme by default, dark on request. The palette lives in two
 * places that must stay in sync: CSS variables in index.css (used by our own
 * markup) and the antd tokens below (used by antd components).
 */

const FONT = '"Archivo", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'

const TOKENS = {
  light: {
    colorPrimary:         '#C8102E',
    colorInfo:            '#2557D6',
    colorLink:            '#2557D6',
    colorSuccess:         '#1E7F4F',
    colorWarning:         '#B45309',
    colorError:           '#B42318',
    colorBgLayout:        '#EDEFF2',
    colorBgContainer:     '#FFFFFF',
    colorBgElevated:      '#FFFFFF',
    colorBorder:          '#D5DAE1',
    colorBorderSecondary: '#E4E7EC',
    colorText:            '#172036',
    colorTextSecondary:   '#5A6377',
    colorTextTertiary:    '#7A8294',
    colorTextQuaternary:  '#A3A9B6',
    colorFillAlter:       '#F6F7F9',
  },
  dark: {
    colorPrimary:         '#D7363D',
    colorInfo:            '#7AA2FF',
    colorLink:            '#8FB0FF',
    colorSuccess:         '#3DD68C',
    colorWarning:         '#F5A524',
    colorError:           '#FF6369',
    colorBgLayout:        '#111216',
    colorBgContainer:     '#18191E',
    colorBgElevated:      '#202128',
    colorBorder:          '#30323A',
    colorBorderSecondary: '#25272D',
    colorText:            '#ECEDF1',
    colorTextSecondary:   '#A1A6B3',
    colorTextTertiary:    '#7F8594',
    colorTextQuaternary:  '#5C6170',
    colorFillAlter:       '#1D1E24',
  },
}

const ThemeContext = createContext({ mode: 'light', toggle: () => {} })

function readSaved() {
  try { return localStorage.getItem('braq_theme') === 'dark' ? 'dark' : 'light' } catch { return 'light' }
}

export function ThemeProvider({ children }) {
  const [mode, setMode] = useState(readSaved)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', mode)
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', mode === 'dark' ? '#111216' : '#EDEFF2')
    try { localStorage.setItem('braq_theme', mode) } catch { /* private mode: theme just isn't remembered */ }
  }, [mode])

  // Switching theme answers a click, so it gets a short circular reveal from the
  // toggle button (View Transitions API). Browsers without it — or people who
  // prefer reduced motion — get an instant switch.
  const toggle = useCallback((event) => {
    const next = mode === 'dark' ? 'light' : 'dark'
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (!document.startViewTransition || reduced) { setMode(next); return }

    const x = event?.clientX ?? window.innerWidth - 40
    const y = event?.clientY ?? 32
    const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y))
    const transition = document.startViewTransition(() => {
      flushSync(() => setMode(next))
      document.documentElement.setAttribute('data-theme', next)
    })
    transition.ready.then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        { duration: 420, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', pseudoElement: '::view-transition-new(root)' },
      )
    }).catch(() => {})
  }, [mode])

  // Focus rings use the info blue: red is reserved for actions and alerts, and a
  // red-bordered field reads as an error.
  const focus = (m) => ({
    activeBorderColor: TOKENS[m].colorInfo,
    hoverBorderColor:  TOKENS[m].colorTextTertiary,
    activeShadow:      `0 0 0 3px ${m === 'dark' ? 'rgba(122,162,255,0.25)' : 'rgba(37,87,214,0.18)'}`,
  })

  const antdTheme = useMemo(() => ({
    algorithm: mode === 'dark' ? antTheme.darkAlgorithm : antTheme.defaultAlgorithm,
    token: {
      ...TOKENS[mode],
      fontFamily: FONT,
      fontSize: 14,
      borderRadius: 8,
      borderRadiusSM: 6,
      borderRadiusLG: 12,
      controlHeight: 36,
      motionDurationMid: '0.18s',
      motionDurationSlow: '0.24s',
    },
    components: {
      Button:   { fontWeight: 600, primaryShadow: 'none', defaultShadow: 'none', dangerShadow: 'none' },
      Table:    { headerBg: 'transparent', headerColor: TOKENS[mode].colorTextSecondary, headerSplitColor: 'transparent', rowHoverBg: TOKENS[mode].colorFillAlter, cellPaddingBlock: 14 },
      Card:     { headerFontSize: 15 },
      Tag:      { defaultBg: TOKENS[mode].colorFillAlter },
      Segmented:{ itemSelectedBg: TOKENS[mode].colorBgContainer },
      Modal:    { titleFontSize: 17 },
      Input:       focus(mode),
      InputNumber: focus(mode),
      Select:      { ...focus(mode), activeOutlineColor: mode === 'dark' ? 'rgba(122,162,255,0.25)' : 'rgba(37,87,214,0.18)', optionSelectedBg: TOKENS[mode].colorFillAlter },
      DatePicker:  focus(mode),
    },
  }), [mode])

  const value = useMemo(() => ({ mode, toggle }), [mode, toggle])

  return (
    <ThemeContext.Provider value={value}>
      <ConfigProvider theme={antdTheme}>{children}</ConfigProvider>
    </ThemeContext.Provider>
  )
}

export const useTheme = () => useContext(ThemeContext)
