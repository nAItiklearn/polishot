import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: { port: 5199, strictPort: true, host: '127.0.0.1' },
  preview: { port: 5199, strictPort: true, host: '127.0.0.1' },
  build: { outDir: '../dist-playground', emptyOutDir: true },
});
