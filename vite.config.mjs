import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/renderer',
  base: './', // must be relative — the renderer is loaded via file:// in production
  plugins: [react()],
  build: {
    outDir: '../../renderer-dist',
    emptyOutDir: true,
  },
  server: {
    port: 5174,
  },
});
