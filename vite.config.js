import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base relativa: funciona en la raíz (Vercel) y en subcarpetas (GitHub Pages /validar-pagos/)
export default defineConfig({
  base: './',
  plugins: [react()],
});
