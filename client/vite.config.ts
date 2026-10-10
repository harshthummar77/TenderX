import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // The client always calls /api/v1/... on its own origin; the proxy removes
    // any need for CORS or a base-URL switch in development. It also means the
    // refresh cookie is first-party in dev, which is what makes `withCredentials`
    // work without SameSite gymnastics.
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        /*
         * Split the libraries out of the app bundle (19 §7). It does not make
         * the first download smaller — it makes the second one much smaller,
         * because these three change on an npm upgrade and the app code changes
         * every deploy. Without it, one typo fix re-downloads React.
         */
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          query: ['@tanstack/react-query', '@tanstack/react-table'],
          forms: ['react-hook-form', '@hookform/resolvers', 'zod'],
        },
      },
    },
  },
});
