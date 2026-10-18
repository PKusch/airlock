import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The live demo is served from /airlock/ on GitHub Pages; everywhere else (npm run dev) it is the root.
export default defineConfig({
  base: process.env.AIRLOCK_BASE ?? '/',
  plugins: [react(), tailwindcss()],
  server: { port: 3200 },
});
