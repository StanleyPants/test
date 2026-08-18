import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The JoyAI server (FastAPI + WebSocket) normally listens on :8080.
// In dev we proxy /api and /ws to it so the browser sees a same-origin app
// and getUserMedia keeps working over plain http://localhost.
const JOYAI_ORIGIN = process.env.JOYAI_ORIGIN ?? 'http://127.0.0.1:8080'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: JOYAI_ORIGIN, ws: true, changeOrigin: true },
      '/health': { target: JOYAI_ORIGIN, changeOrigin: true },
      '/debug': { target: JOYAI_ORIGIN, changeOrigin: true },
      '/ref-images': { target: JOYAI_ORIGIN, changeOrigin: true },
      '/load': { target: JOYAI_ORIGIN, changeOrigin: true },
      '/download_last': { target: JOYAI_ORIGIN, changeOrigin: true },
    },
  },
})
