import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// 開発時は Vite（127.0.0.1:5173）が /api と /ws を Hub に中継する
const hub = `http://127.0.0.1:${process.env.AGENTPWA_PORT ?? 8787}`;

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'AgentPWA',
        short_name: 'AgentPWA',
        description: 'Claude と Codex のセッションをまとめて操作する',
        lang: 'ja',
        display: 'standalone',
        background_color: '#0d1117',
        theme_color: '#151b23',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        // /files/ はファイルビュワーの iframe が開く。index.html を返さないようにする
        navigateFallbackDenylist: [/^\/api\//, /^\/ws/, /^\/files\//],
      },
    }),
  ],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: hub },
      '/ws': { target: hub, ws: true },
      '/files': { target: hub },
    },
  },
  preview: { host: '127.0.0.1' },
});
