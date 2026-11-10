import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

// The Android app serves this build from its APK assets at
// https://appassets.androidplatform.net/assets/editor/index.html, so every URL in the output is relative
// (`base: './'`) and the bundle is written straight into the Gradle module's assets folder
// (`:app:buildEditorHost` runs `pnpm --filter @polishot/android-editor-host build` before assets are merged).
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    // One copy of React for this app and the editor package, whichever node_modules each resolves from.
    dedupe: ['react', 'react-dom'],
  },
  build: {
    outDir: resolve(root, '../app/src/main/assets/editor'),
    emptyOutDir: true,
    // Android System WebView is evergreen; devices that can run API 29 apps have Chromium 110 or newer by now.
    target: 'chrome110',
    sourcemap: false,
    cssCodeSplit: false,
    // No data: URIs for fonts or images: the page's CSP only allows them from the asset origin.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    chunkSizeWarningLimit: 1500,
  },
});
