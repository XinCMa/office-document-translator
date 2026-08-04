import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR can be disabled with DISABLE_HMR=true for low-resource environments.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching at the same time to reduce local CPU usage.
      watch: process.env.DISABLE_HMR === 'true' ? null : {
        ignored: ['**/data/**', '**/uploads/**', '**/dist/**']
      },
    },
  };
});
