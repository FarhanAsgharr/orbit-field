import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    // The API is same-origin in production behind a reverse proxy; in dev the
    // proxy keeps cookies and CORS out of the picture entirely.
    proxy: {
      '/api': { target: process.env.ORBIT_API_URL ?? 'http://localhost:4055', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Recharts is large and only used on the analytics route; splitting it
        // keeps the initial load of the operational screens small.
        manualChunks: { charts: ['recharts'], vendor: ['react', 'react-dom', 'react-router-dom'] },
      },
    },
  },
});
