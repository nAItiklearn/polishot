import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

// Three HTML entries: the preview (main editor window), one overlay page shared by every
// overlay-<n> window, and the pin page shared by every pin-<id> window.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: '127.0.0.1',
  },
  build: {
    target: 'chrome110', // WebView2 is evergreen
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        index: resolve(root, 'index.html'),
        overlay: resolve(root, 'overlay.html'),
        pin: resolve(root, 'pin.html'),
        status: resolve(root, 'status.html'),
      },
    },
  },
});
