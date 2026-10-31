import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// Operator-only build of the Teams v4 capture page (npm run capture:teams); not part of the app build.
export default defineConfig({
  root: 'capture',
  base: './',
  plugins: [react()],
  build: { outDir: '../dist/capture', emptyOutDir: true },
});
