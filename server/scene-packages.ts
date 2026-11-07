import express from 'express';
import { evidenceMaxBytes } from '../src/domain/evidence';
import { packageNapPreview, type ScenePackage } from '../src/domain/scene-package';

export function scenePackagesRouter() {
  const router = express.Router();
  const published = new Map<number, ScenePackage>();
  let installed: ScenePackage | null = null;

  router.get('/scene-packages', (_req, res) => {
    res.json({ packages: [...published.values()], installedVersion: installed?.version ?? null });
  });
  router.get('/vehicle/scene-package', (_req, res) => {
    res.json({ scenePackage: installed });
  });
  router.post('/scene-packages', express.json({ limit: evidenceMaxBytes }), (req, res) => {
    try {
      const next = packageNapPreview(JSON.stringify(req.body) ?? '');
      const existing = published.get(next.version);
      if (existing && JSON.stringify(existing) !== JSON.stringify(next)) {
        res.status(409).json({ error: '该版本已发布，保存为新版本后再发布。' });
        return;
      }
      published.set(next.version, next);
      res.status(existing ? 200 : 201).json(next);
    } catch (error) {
      res.status(422).json({ error: error instanceof Error ? error.message : '预演证据无效。' });
    }
  });
  router.post('/scene-packages/:version/deliver', express.json({ limit: '1kb' }), (req, res) => {
    const version = req.params.version;
    const pack =
      version && /^[1-9]\d{0,2}$/.test(version) ? published.get(Number(version)) : undefined;
    if (!pack) {
      res.status(404).json({ error: '请先发布这个版本。' });
      return;
    }
    installed = pack;
    res.json({ scenePackage: installed });
  });
  return router;
}
