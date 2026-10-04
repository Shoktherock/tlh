import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import { accountConfig } from './src/accounts/config.mjs';
export default defineConfig(({mode}) => {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const env = loadEnv(mode, root, 'VITE_');
  const config = accountConfig(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY);
  return {
  root: fileURLToPath(new URL('.', import.meta.url)),
  server: { host: '127.0.0.1', port: 4180, strictPort: true },
  preview: { host: '127.0.0.1', port: 4180, strictPort: true },
  build: { outDir: 'dist', commonjsOptions: { include: [/node_modules/, /generated[\\/]validate\.cjs/] } },
  plugins: [{name:'supabase-connect-policy',transformIndexHtml(html) {
    return config ? html.replace("connect-src 'self'", `connect-src 'self' ${config.url}`) : html;
  }}],
};});
