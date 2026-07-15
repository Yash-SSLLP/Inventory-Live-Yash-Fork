import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies /api to the deployed Express backend. The backend is served over HTTPS on
// 443 (behind a reverse proxy); port 4002 is NOT publicly reachable. Override with VITE_API_TARGET.
const API_TARGET = process.env.VITE_API_TARGET || 'https://inventory.salestracker.in';
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        secure: true,
      },
    },
  },
});
