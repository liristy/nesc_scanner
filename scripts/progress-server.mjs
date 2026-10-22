import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { progressPage } from '../src/progress-view.mjs';

export function createProgressServer(root) {
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(progressPage()); return; }
    if (req.url === '/progress.json') {
      try { const data = await fs.readFile(path.join(root, 'run/progress.json')); res.setHeader('Content-Type', 'application/json'); res.end(data); }
      catch { res.writeHead(404).end('{}'); }
      return;
    }
    res.writeHead(404).end();
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.JY_PROGRESS_PORT || 8086);
  const root = path.resolve(process.env.JY_ALARM_DATA_DIR || '.');
  createProgressServer(root).listen(port, '127.0.0.1', () => console.info(`实时进度：http://127.0.0.1:${port}（按 Ctrl+C 关闭）`));
}
