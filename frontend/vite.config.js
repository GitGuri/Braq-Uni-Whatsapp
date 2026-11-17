import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Long-lived vendor chunks (cached across deploys); route pages are lazy-loaded in App.jsx.
// antd + its rc-* / @ant-design internals import each other, so they must share one chunk
// (splitting them produces circular chunks).
function manualChunks(id) {
  if (!id.includes('node_modules')) return undefined
  if (/[\/]node_modules[\/](react|react-dom|react-router|react-router-dom|@remix-run|scheduler)[\/]/.test(id)) return 'react'
  if (/[\/]node_modules[\/](antd|@ant-design|rc-[^\/]+|@rc-component)[\/]/.test(id)) return 'antd'
  return 'vendor'
}

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: { manualChunks },
    },
    // The only chunk above Vite's 500 kB default is the self-contained antd library chunk
    // (~1 MB min / ~315 kB gzip); app code is split per route and every page chunk is < 25 kB.
    chunkSizeWarningLimit: 1100,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
