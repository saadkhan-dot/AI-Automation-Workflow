import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_');
  const backend = env.VITE_API_PROXY_TARGET || 'http://localhost:3000';
  return {
    server: {
      port: 5173,
      proxy: { '/api': backend, '/health': backend },
    },
  };
});
