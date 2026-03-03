import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    // Output into the Go package that embeds it — avoids the go:embed ".." restriction.
    outDir: '../internal/api/ui_static',
    emptyOutDir: true,
  },
  // In dev, proxy /api and /ws to the Go backend.
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
})
