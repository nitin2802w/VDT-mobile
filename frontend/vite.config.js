import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    host: true,         // Listen on all network interfaces
    allowedHosts: true, // Allow localtunnel host headers
  },
})

