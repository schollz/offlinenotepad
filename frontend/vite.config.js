import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { offlineCache } from './scripts/offline-cache.js';

const backend = process.env.NOTEPAD_BACKEND || 'http://localhost:8251';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), offlineCache()],
  server: {
    proxy: {
      '/ws': { target: backend, ws: true },
      '/api': backend,
    },
  },
});
