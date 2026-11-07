import { useEffect, useState } from 'react';
import { PackageCheck } from 'lucide-react';
import { napRestored, parseScenePackage, type ScenePackage } from '../domain/scene-package';
import { validateScenario, type Scenario } from '../domain/scenario';
import type { RunSnapshot } from '../domain/runtime';
import { downloadJson } from '../storage';
import { scenePackageRequest } from './scenePackageRequest';

interface ReleaseStatus {
  packages: ScenePackage[];
  installedVersion: number | null;
}

export default function NapRelease({
  scenario,
  run,
  openVehicle,
}: {
  scenario: Scenario;
  run: RunSnapshot | null;
  openVehicle: () => void;
}) {
  const [status, setStatus] = useState<ReleaseStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const pack = status?.packages.find((item) => item.version === scenario.version);
  const confirmed = JSON.stringify(validateScenario(scenario).scenario);
  const matching = pack && JSON.stringify(pack.scenario) === confirmed;
  const ready = Boolean(run && JSON.stringify(run.scenario) === confirmed && napRestored(run));
  const installed = matching && status?.installedVersion === scenario.version;
  const endpoint = '/api/scene-packages';

  useEffect(() => {
    const controller = new AbortController();
    scenePackageRequest(endpoint, undefined, controller.signal)
      .then((data: ReleaseStatus) =>
        setStatus({ ...data, packages: data.packages.map(parseScenePackage) }),
      )
      .catch((failure) => {
        if (!controller.signal.aborted) setError(failure.message);
      });
    return () => controller.abort();
  }, []);

  async function publish() {
    if (!run || !status) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const next = parseScenePackage(await scenePackageRequest(endpoint, run));
      setStatus({
        ...status,
        packages: [...status.packages.filter((item) => item.version !== next.version), next],
      });
      setMessage(`已发布定时午休 v${next.version}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '发布失败。');
    } finally {
      setBusy(false);
    }
  }

  async function deliver() {
    if (!matching || !status) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const data = await scenePackageRequest(`${endpoint}/${scenario.version}/deliver`, {});
      const delivered = parseScenePackage(data.scenePackage);
      setStatus({ ...status, installedVersion: delivered.version });
      setMessage(`v${delivered.version} 已下发到模拟车端`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '下发失败。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel nap-release" aria-label="发布定时午休">
      <div className="panel-heading">
        <span>
          <PackageCheck size={16} /> 发布到模拟车端
        </span>
        <span className="pill">v{scenario.version}</span>
      </div>
      <div className="scene-delivery-content">
        <ol className="delivery-progress" aria-label="当前版本交付进度">
          <li className={ready || matching ? 'done' : ''}>
            <span>预演</span>
            <strong>{ready || matching ? '已验证' : '待验证'}</strong>
          </li>
          <li className={matching ? 'done' : ''}>
            <span>发布</span>
            <strong>{matching ? `已发布 v${scenario.version}` : '待发布'}</strong>
          </li>
          <li className={installed ? 'done' : ''}>
            <span>车端安装</span>
            <strong>{installed ? `已安装 v${scenario.version}` : '待下发'}</strong>
          </li>
        </ol>
        <p className="muted">
          {matching
            ? `已发布 v${scenario.version}。模拟车端${status?.installedVersion ? `已安装 v${status.installedVersion}` : '尚未安装'}。`
            : pack
              ? '该版本号已发布了不同内容。请先保存一个新版本。'
              : ready
                ? '唤醒和设置恢复已验证，可以发布此版本。'
                : '请先完成当前版本的唤醒和设置恢复预演。'}
        </p>
        <div className="scene-delivery-actions">
          <button
            className="button primary"
            disabled={!status || !ready || Boolean(pack) || busy}
            onClick={publish}
          >
            发布场景包
          </button>
          <button className="button secondary" disabled={!matching || busy} onClick={deliver}>
            下发到模拟车端
          </button>
          {pack && matching && (
            <button
              className="text-button"
              onClick={() => downloadJson(`cabinlab-nap-v${pack.version}.json`, pack)}
            >
              导出场景包
            </button>
          )}
          {status?.installedVersion && (
            <button className="text-button" onClick={openVehicle}>
              打开我的场景
            </button>
          )}
        </div>
        {message && <p role="status">{message}</p>}
        {error && (
          <p className="compile-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
