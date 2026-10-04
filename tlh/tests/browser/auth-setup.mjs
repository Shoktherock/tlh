import { build, preview } from 'vite';
export default async function setup() {
  process.env.VITE_SUPABASE_URL='https://tlh-test.supabase.co';
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY='sb_publishable_synthetic_browser_test';
  const config={configFile:'tlh/vite.config.ts',mode:'auth-test',build:{outDir:'../test-results/auth-build'},logLevel:'error'};
  await build(config);
  const server=await preview({...config,preview:{host:'127.0.0.1',port:4181,strictPort:true}});
  return async()=>{server.httpServer.closeAllConnections();await new Promise(resolve=>server.httpServer.close(resolve));};
}
