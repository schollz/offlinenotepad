import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    {
      name: 'keep-embedded-build-directory',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: '.gitkeep', source: '' })
      },
    },
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icon.svg'],
      manifest: {
        name: 'Offline Notepad',
        short_name: 'Notepad',
        description: 'A private, encrypted notebook that works offline.',
        theme_color: '#1769e0',
        background_color: '#f5f7fb',
        display: 'standalone',
        start_url: '/app',
        scope: '/',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
      },
      workbox: {
        globPatterns: ['index.html', '**/*.{js,css,svg,woff2,webmanifest}'],
        globIgnores: ['public.html'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [
          /^\/api\//,
          /^\/ws$/,
          /^\/healthz$/,
          /^\/blog(?:\/|$)/,
          /^\/p\//,
          /^\/[a-f0-9]{8}(?:\/raw)?$/,
        ],
        cleanupOutdatedCaches: true,
        runtimeCaching: [],
      },
    }),
  ],
  build: {
    outDir: resolve(import.meta.dirname, '../internal/site/build'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        blog: resolve(import.meta.dirname, 'blog.html'),
        public: resolve(import.meta.dirname, 'public.html'),
      },
      output: {
        assetFileNames: 'static/[name]-[hash][extname]',
        chunkFileNames: 'static/[name]-[hash].js',
        entryFileNames: 'static/[name]-[hash].js',
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8251',
      '/ws': { target: 'ws://127.0.0.1:8251', ws: true },
    },
  },
})
