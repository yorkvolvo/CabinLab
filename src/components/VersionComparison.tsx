import { useState } from 'react';
import { ArrowRight, Download, GitCompareArrows } from 'lucide-react';
import type { Scenario } from '../domain/scenario';
import {
  compareVersions,
  scenarioChanges,
  type VersionComparisonResult,
} from '../domain/comparison';
import { downloadJson } from '../storage';

export function ScenarioDiff({ before, after }: { before: Scenario; after: Scenario }) {
  const changes = scenarioChanges(before, after);
  return changes.length ? (
    <dl className="scenario-diff">
      {changes.map((change) => (
        <div key={change.field}>
          <dt>{change.field}</dt>
          <dd>
            <span className="diff-before">{change.before}</span>
            <ArrowRight size={13} aria-label="改为" />
            <span className="diff-after">{change.after}</span>
          </dd>
        </div>
      ))}
    </dl>
  ) : (
    <p className="small muted">参数与动作没有变化。</p>
  );
}

export default function VersionComparison({
  scenario,
  versions,
}: {
  scenario: Scenario;
  versions: Scenario[];
}) {
  const alternatives = versions.filter((s) => s.version !== scenario.version);
  const [version, setVersion] = useState(alternatives[0]?.version ?? scenario.version);
  const [result, setResult] = useState<VersionComparisonResult | null>(null);
  const before = alternatives.find((s) => s.version === version);
  return (
    <details className="panel version-comparison">
      <summary>
        <GitCompareArrows size={15} />
        <strong>版本差异与回归</strong>
        <span>{before ? `v${before.version} → v${scenario.version}` : '保存修改后开始对照'}</span>
      </summary>
      <div className="comparison-content">
        {!before ? (
          <p className="small muted">
            当前只有一个已确认版本。修改参数并保存后，即可看到字段差异和新增失败用例。
          </p>
        ) : (
          <>
            <div className="comparison-toolbar">
              <label>
                对照版本{' '}
                <select
                  aria-label="对照版本"
                  value={version}
                  onChange={(e) => {
                    setVersion(Number(e.target.value));
                    setResult(null);
                  }}
                >
                  {alternatives.map((s) => (
                    <option key={s.version} value={s.version}>
                      v{s.version}
                      {s.version === 1 ? ' · 原始示例' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <span>当前版本 v{scenario.version}</span>
              <button
                className="button secondary"
                onClick={() => setResult(compareVersions(before, scenario))}
              >
                对照验证两个版本
              </button>
            </div>
            <ScenarioDiff before={before} after={scenario} />
            <p className="small muted">
              两个版本都使用同一套固定的模板产品基线与断言。对照版本只决定差异方向，不会成为测试答案。
            </p>
            {result && (
              <div className="comparison-result" role="status">
                <div className="comparison-stats">
                  <strong>
                    v{before.version}：{result.previous.passed}/{result.previous.total}{' '}
                    <ArrowRight size={14} /> v{scenario.version}：{result.current.passed}/
                    {result.current.total}
                  </strong>
                  <span className={result.regressions ? 'regression-count' : ''}>
                    新增失败 {result.regressions} 项
                  </span>
                  <span>恢复通过 {result.recoveries} 项</span>
                </div>
                <ul>
                  {result.transitions
                    .filter((item) => item.change !== 'unchanged')
                    .map((item) => (
                      <li key={item.id} className={item.change}>
                        <strong>
                          {item.change === 'regression' ? '新增失败' : '恢复通过'} · {item.name}
                        </strong>
                        <p>{item.afterDetail}</p>
                      </li>
                    ))}
                </ul>
                {!result.regressions && !result.recoveries && (
                  <p>验证结果没有变化。字段差异仍可在上方核对。</p>
                )}
                <button
                  className="text-button"
                  onClick={() =>
                    downloadJson(
                      `cabinlab-comparison-v${before.version}-v${scenario.version}.json`,
                      result,
                    )
                  }
                >
                  <Download size={13} />
                  导出版本对照
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </details>
  );
}
