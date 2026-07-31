import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The landing site is its own deployment and shares nothing with the console,
 * the portal or the API but a set of links. It has no session, no data layer
 * and no runtime dependency on any of them — which is why it can be static.
 */
export default defineConfig({
  plugins: [react()],
  server: { port: 5182 },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: { manualChunks: { vendor: ['react', 'react-dom'], motion: ['framer-motion'] } },
    },
  },
});
