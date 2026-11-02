import { useRef, useState } from 'react';
import { FileCheck2, Upload, X } from 'lucide-react';
import { evidenceMaxBytes, inspectEvidence } from '../domain/evidence';
import { downloadJson } from '../storage';
import { runStatusLabels } from '../domain/runtime';

export default function EvidenceInspector() {
  const [result, setResult] = useState<ReturnType<typeof inspectEvidence> | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  const file = useRef<HTMLInputElement | null>(null);
  return (
    <section className="panel evidence-inspector">
      <div className="panel-heading">
        <span>
          <FileCheck2 size={15} />
          证据复核台
        </span>
      </div>
      <div className="evidence-content">
        <p>导入之前导出的运行证据或完整实验，在独立虚拟运行中核对每条事件与终态。</p>
        <input
          ref={file}
          className="sr-only"
          type="file"
          accept=".json,application/json"
          aria-label="导入证据文件"
          onChange={async (event) => {
            const selected = event.target.files?.[0];
            event.target.value = '';
            if (!selected) return;
            const id = ++request.current;
            setLoading(true);
            setError('');
            setResult(null);
            try {
              if (selected.size > evidenceMaxBytes) throw new Error('证据文件超过 1 MB 限制。');
              const text = await selected.text();
              if (id !== request.current) return;
              setResult(inspectEvidence(text));
            } catch (error) {
              if (id === request.current)
                setError(error instanceof Error ? error.message : '证据读取失败，请重试。');
            } finally {
              if (id === request.current) setLoading(false);
            }
          }}
        />
        <button className="button secondary" onClick={() => file.current?.click()}>
          <Upload size={14} />
          {loading ? '正在核验…' : '导入并核验'}
        </button>
        <p className="small muted">
          仅本地读取，最大 1 MB / 1
          小时。导入不会覆盖场景、版本或正在运行的实验；文件内的验证报告不作为测试答案。
        </p>
        {error && (
          <p className="evidence-error" role="alert">
            {error}
          </p>
        )}
        {result && (
          <div className="evidence-result" role="status">
            <div>
              <strong>重放一致性核验通过</strong>
              <button
                className="icon-button"
                aria-label="清除导入证据"
                onClick={() => {
                  request.current++;
                  setResult(null);
                }}
              >
                <X size={14} />
              </button>
            </div>
            <p>
              {result.source.scenario.name} · v{result.source.scenario.version} ·{' '}
              {result.source.time} 秒
            </p>
            <p>
              原始运行结果：<strong>{runStatusLabels[result.source.status]}</strong>
              。核验通过表示这一结果可复现，不代表所有动作成功。
            </p>
            <dl>
              <div>
                <dt>事件一致</dt>
                <dd>{result.source.events.length} 条</dd>
              </div>
              <div>
                <dt>输入命令</dt>
                <dd>{result.source.commands.length} 条</dd>
              </div>
              <div>
                <dt>运行时</dt>
                <dd>{result.source.runtimeVersion}</dd>
              </div>
              <div>
                <dt>回读温度 / 音量</dt>
                <dd>
                  {result.replayed.vehicle.targetTemperature}°C / {result.replayed.vehicle.volume}%
                </dd>
              </div>
            </dl>
            <p className="small">结构、事件和状态一致不代表来源可信，也不是签名认证或真车验收。</p>
            <details>
              <summary>查看复现事件</summary>
              <ol>
                {result.replayed.events.map((item) => (
                  <li key={item.index}>
                    <span className="mono">{item.time}s</span> {item.detail}
                  </li>
                ))}
              </ol>
            </details>
            <button
              className="text-button"
              onClick={() =>
                downloadJson(
                  `cabinlab-replayed-v${result.source.scenario.version}.json`,
                  result.replayed,
                )
              }
            >
              导出复现证据
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
