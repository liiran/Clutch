import { defineConfig, loadEnv } from 'vite'
import { clutchApi } from './server/api.ts'

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env }
  return {
    plugins: [clutchApi({ model: env.CLUTCH_CLAUDE_MODEL || 'sonnet', effort: env.CLUTCH_CLAUDE_EFFORT || 'medium', bin: env.CLUTCH_CLAUDE_BIN || undefined })],
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
    preview: { host: '127.0.0.1', port: 4173, strictPort: true },
    build: { chunkSizeWarningLimit: 900 },
  }
})
