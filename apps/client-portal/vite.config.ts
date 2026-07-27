import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The Client Portal is its own deployment.
 *
 * Not a route inside the console: customers and staff are different audiences
 * with different sessions, and keeping the bundles apart means a customer's
 * browser never downloads the admin screens at all. The two apps share the API
 * and nothing else.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5181,
    proxy: {
      '/api': { target: process.env.ORBIT_API_URL ?? 'http://localhost:4055', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: { manualChunks: { vendor: ['react', 'react-dom', 'react-router-dom'] } },
    },
  },
});
