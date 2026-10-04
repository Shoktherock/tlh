import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Deliberately serve an explicit allowlist, never the repo or personal Export-CSV directory.
const root = new URL('../', import.meta.url);
const routes = new Map([
  ['/demo/', ['demo/index.html', 'text/html']],
  ['/demo/style.css', ['demo/style.css', 'text/css']],
  ['/dist/demo.js', ['dist/demo.js', 'text/javascript']],
  ['/dist/content.js', ['dist/content.js', 'text/javascript']],
  ['/snapshot.schema.json', ['snapshot.schema.json', 'application/json']],
]);
export function createPilotServer() { return createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  if (pathname === '/') { res.writeHead(302, { Location: '/demo/' }); res.end(); return; }
  const route = routes.get(pathname);
  if (!route || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404); res.end('Not found'); return; }
  try {
    const body = await readFile(new URL(route[0], root));
    res.writeHead(200, { 'Content-Type': `${route[1]}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-TLH-Pilot': '1',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'; object-src 'none'; base-uri 'none'" });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { res.writeHead(503); res.end('Run npm run build first.'); }
}); }

export async function startPilotServer(port = Number(process.env.PORT || 4173)) {
  const server = createPilotServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startPilotServer();
  console.log(`Local helper pilot: http://127.0.0.1:${server.address().port}/demo/`);
}
