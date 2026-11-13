import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: '../extension/media/webview',
    emptyOutDir: true,
    cssCodeSplit: false,
    modulePreload: false,
    sourcemap: false,
    target: 'es2022',
    assetsDir: '.',
    rollupOptions: {
      output: {
        format: 'iife',
        name: 'CodeFlowWebview',
        entryFileNames: 'index.js',
        assetFileNames: 'index.[ext]',
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./src/testSetup.ts'],
  },
});
