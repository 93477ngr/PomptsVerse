import tailwindcss from '@tailwindcss/vite';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig(() => {
  return {
    appType: 'mpa' as const,
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      target: 'es2020',
      sourcemap: false,
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
          admin: path.resolve(__dirname, 'admin.html'),
          googleVerify: path.resolve(__dirname, 'google93e1f106c7169015.html'),
        },
        output: {
          manualChunks(id) {
            if (id.includes('firebase')) {
              return 'vendor-firebase';
            }
            if (id.includes('dompurify') || id.includes('lucide')) {
              return 'vendor-utils';
            }
          }
        }
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      port: 3000,
      host: '0.0.0.0',
      allowedHosts: true as const,
    },
  };
});
