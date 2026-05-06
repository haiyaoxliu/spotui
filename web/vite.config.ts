import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { spotuiSidecar } from './server/index.js'

export default defineConfig({
  plugins: [react(), spotuiSidecar()],
  server: {
    host: '127.0.0.1',
    port: 8888,
    strictPort: true,
  },
})
