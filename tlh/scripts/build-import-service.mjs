import { build } from 'esbuild';
await build({entryPoints:['tlh/server/import-service.mjs'],bundle:true,platform:'neutral',format:'esm',target:'es2022',outfile:'supabase/functions/_shared/import-service.mjs'});
await build({entryPoints:['tlh/server/quote-service.mjs'],bundle:true,platform:'neutral',format:'esm',target:'es2022',outfile:'supabase/functions/_shared/quote-service.mjs'});
await build({entryPoints:['tlh/server/analysis-input-service.mjs'],bundle:true,platform:'neutral',format:'esm',target:'es2022',outfile:'supabase/functions/_shared/analysis-input-service.mjs'});
console.log('Bundled the validated import rules for the Supabase function.');

await build({entryPoints:['tlh/server/activity-service.mjs'],bundle:true,platform:'neutral',format:'esm',target:'es2022',outfile:'supabase/functions/_shared/activity-service.mjs'});

await build({entryPoints:['tlh/server/replacement-service.mjs'],bundle:true,platform:'neutral',format:'esm',target:'es2022',outfile:'supabase/functions/_shared/replacement-service.mjs'});
