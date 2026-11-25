import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Builds one self-contained HTML file (JS + CSS inlined) that runs from file:// without a server.
export default defineConfig({
  plugins: [viteSingleFile()],
  build: { target: 'es2022', outDir: 'dist-single', chunkSizeWarningLimit: 8000, assetsInlineLimit: 100000000, cssCodeSplit: false },
  define: { __SINGLE_FILE__: 'true' },
});
