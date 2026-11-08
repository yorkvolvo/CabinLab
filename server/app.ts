import express from 'express';
import packageInfo from '../package.json';
import { compile, compileRequestSchema, type ProviderConfig } from './provider';
import { CompileError } from '../src/domain/compiler';
import { scenePackagesRouter } from './scene-packages';

export function createApp(
  config: ProviderConfig,
  fetcher: typeof fetch = fetch,
  renderUrl?: string,
) {
  const publicUrl = renderUrl ? new URL(renderUrl) : undefined;
  if (publicUrl && (publicUrl.protocol !== 'https:' || publicUrl.href !== `${publicUrl.origin}/`)) {
    throw new Error('RENDER_EXTERNAL_URL 必须是 HTTPS 站点地址');
  }
  if (publicUrl && config.provider !== 'demo') {
    throw new Error('Render 演示仅支持 LLM_PROVIDER=demo');
  }

  const app = express();
  app.disable('x-powered-by');
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const allowedHost = publicUrl
      ? req.headers.host?.toLowerCase() === publicUrl.host
      : ['localhost', '127.0.0.1', '[::1]'].includes(req.hostname);
    if (!allowedHost) {
      res.status(403).json({ error: '请求域名不在允许范围内' });
      return;
    }
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      // Render terminates TLS. Use its configured public origin instead of forwarded headers.
      const expectedOrigin = publicUrl?.origin ?? `${req.protocol}://${req.headers.host}`;
      if ((publicUrl || origin) && origin !== expectedOrigin) {
        res.status(403).json({ error: '仅允许同源请求' });
        return;
      }
      if (!req.is('application/json')) {
        res.status(415).json({ error: '需要 application/json' });
        return;
      }
    }
    next();
  });
  app.use('/api', scenePackagesRouter());
  app.use(express.json({ limit: '24kb' }));
  app.get('/api/health', (_req, res) =>
    res.json({
      status: 'ok',
      mode: config.provider === 'demo' ? 'demo' : 'model',
      ...(config.provider === 'openai' ? { provider: 'openai' } : {}),
      version: packageInfo.version,
    }),
  );
  let inFlight = 0;
  app.post('/api/compile', async (req, res) => {
    const parsed = compileRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: 'invalid_request',
        error: '请输入 4–2000 字的需求；修改时需要当前模板下的已确认合法场景。',
      });
      return;
    }
    if (inFlight >= 2) {
      res.status(429).json({ error: '编译器正在处理请求，请稍后再试。' });
      return;
    }
    inFlight++;
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', onClose);
    try {
      res.json(await compile(parsed.data, config, fetcher, controller.signal));
    } catch (error) {
      if (!res.destroyed)
        res.status(error instanceof CompileError ? error.status : 502).json({
          code: error instanceof CompileError ? error.code : 'compile_failed',
          error:
            error instanceof CompileError
              ? error.message
              : '场景编译失败，未执行任何动作，请稍后重试。',
        });
    } finally {
      inFlight--;
      res.off('close', onClose);
    }
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
  app.use(
    (
      error: { status?: number },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(error.status === 413 ? 413 : 400).json({ error: '请求体过大或不是合法 JSON' });
    },
  );
  return app;
}
