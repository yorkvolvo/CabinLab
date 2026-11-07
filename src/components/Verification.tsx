import {
  ArrowUpRight,
  Check,
  CheckCheck,
  Circle,
  Download,
  FlaskConical,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { useState } from 'react';
import type { VerificationReport } from '../domain/verification';
import { downloadJson } from '../storage';

export default function Verification({
  report,
  onRun,
  compact = false,
}: {
  report: VerificationReport | null;
  onRun: () => void;
  compact?: boolean;
}) {
  const [filter, setFilter] = useState<'all' | 'failed'>('all');
  const failed = report ? report.total - report.passed : 0;
  return (
    <section className={`panel verification ${compact ? 'compact' : ''}`}>
      <div className="panel-heading">
        <span>
          <ShieldCheck size={17} /> 验证中心
        </span>
        <span className="mono muted">{report ? `${report.total} CHECKS` : 'FIXED CHECKS'}</span>
      </div>
      <div className={`verification-score ${failed ? 'has-failures' : ''}`}>
        <div className="score-icon">
          {failed ? <TriangleAlert size={22} /> : <ShieldCheck size={24} />}
        </div>
        <div>
          <span>
            {report ? (failed ? '发现需要关注的行为' : '当前验证全部通过') : '让场景，经得起测试'}
          </span>
          <strong>
            {report ? (
              <>
                {report.passed}
                <small> / {report.total}</small>
              </>
            ) : (
              <span className="score-dash">—</span>
            )}
          </strong>
        </div>
      </div>
      <p className="verification-note">
        固定产品预期，独立判断结果。修改场景参数，不会改变测试的答案。
      </p>
      <button className="button verify-button" onClick={onRun}>
        <FlaskConical size={15} />
        {report ? '重新验证当前版本' : '运行全部验证'}
        <ArrowUpRight size={15} />
      </button>
      {report ? (
        <>
          <div className="report-meta">
            <span>
              v{report.scenario.version} · {report.scenario.name}
            </span>
            <button
              className="icon-button"
              title="导出验证报告"
              aria-label="导出验证报告"
              onClick={() =>
                downloadJson(`cabinlab-verification-v${report.scenario.version}.json`, report)
              }
            >
              <Download size={14} />
            </button>
          </div>
          <div className="filter-row">
            <button className={filter === 'all' ? 'selected' : ''} onClick={() => setFilter('all')}>
              全部 {report.total}
            </button>
            <button
              className={filter === 'failed' ? 'selected' : ''}
              onClick={() => setFilter('failed')}
            >
              失败 {failed}
            </button>
          </div>
          <div className="check-list">
            {report.cases
              .filter((c) => filter === 'all' || !c.passed)
              .map((c) => (
                <details className={`check-item ${c.passed ? 'passed' : 'failed'}`} key={c.id}>
                  <summary>
                    {c.passed ? <Check size={14} /> : <TriangleAlert size={14} />}
                    <span>{c.name}</span>
                    <span className="check-marker">{c.passed ? '通过' : '失败'}</span>
                  </summary>
                  <div className="check-detail">
                    <span className="eyebrow">{c.group}</span>
                    <p>{c.detail}</p>
                    {c.evidence && (
                      <>
                        <p>
                          虚拟时间 {c.evidence.time}s · {c.evidence.events.length} 条事件 ·{' '}
                          {c.evidence.status}
                        </p>
                        <button
                          className="text-button"
                          onClick={() => downloadJson(`cabinlab-${c.id}-evidence.json`, c.evidence)}
                        >
                          下载该用例证据 <ArrowUpRight size={12} />
                        </button>
                      </>
                    )}
                  </div>
                </details>
              ))}
            {filter === 'failed' && failed === 0 && (
              <div className="empty-small">
                <CheckCheck size={22} />
                <span>没有失败项</span>
              </div>
            )}
          </div>
          <p className="report-footnote">
            {report.baseline}
            <br />
            仅覆盖当前仿真模型，不构成真车安全认证。
          </p>
        </>
      ) : (
        <div className="check-list preview-checks">
          {[
            '持续触发与边界波动',
            '挡位、车速实时守卫',
            '服务超时与部分完成',
            '请求拒绝与结果未知',
            '手动接管优先',
            '停止、重放与能力边界',
          ].map((name) => (
            <div key={name}>
              <Circle size={12} />
              <span>{name}</span>
              <span className="muted">待运行</span>
            </div>
          ))}
          <div className="validation-tip">
            <span className="eyebrow">试一试</span>
            <p>
              把持续时间改为 <b>0 秒</b>，看看验证器能否发现误触发。
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
