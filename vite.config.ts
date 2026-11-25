import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, host: true },
  build: { target: 'es2022', outDir: 'dist', chunkSizeWarningLimit: 4000 },
  define: { __SINGLE_FILE__: 'false' },
});
