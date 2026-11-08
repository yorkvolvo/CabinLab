import express from 'express';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { configFromEnv } from './provider';

const app = createApp(configFromEnv(process.env), fetch, process.env.RENDER_EXTERNAL_URL);
const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 不合法');

if (process.argv.includes('--production')) {
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  app.use(express.static(dist, { dotfiles: 'deny', index: 'index.html' }));
  app.get('/{*path}', (_req, res) => res.sendFile(`${dist}/index.html`));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}

const server = app.listen(port, host, () =>
  console.log(`场景工作室 → http://${host}:${port} (${process.env.LLM_PROVIDER || 'demo'})`),
);
server.on('error', (e) => {
  console.error(`场景工作室启动失败：${e.message}`);
  process.exit(1);
});
