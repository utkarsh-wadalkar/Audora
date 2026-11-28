import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    target: 'chrome90',
    assetsInlineLimit: 0,
    rollupOptions: { input: path.resolve(__dirname, 'android.html') },
  },
});
