import { defineConfig } from 'vite';

// Relative base so the static build works on Vercel, GitHub Pages,
// or any plain static file host without path rewrites.
export default defineConfig({
  base: './',
});
