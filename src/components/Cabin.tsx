import { Fan, Music2, Sun, Wind } from 'lucide-react';
import type { Vehicle } from '../domain/runtime';

export default function Cabin({ vehicle, active }: { vehicle: Vehicle; active: boolean }) {
  return (
    <div className={`cabin-view ${active ? 'cabin-active' : ''}`} aria-label="虚拟座舱状态图">
      <div className="cabin-grid" />
      <div className="cabin-caption">
        <span className="live-dot" /> VIRTUAL CABIN<span>MODEL 01</span>
      </div>
      <div className={`device-tag climate-tag ${vehicle.climatePower ? 'on' : ''}`}>
        <Fan size={15} className={vehicle.climatePower ? 'spinning' : ''} />
        <div>
          <span>空调系统</span>
          <strong>
            {vehicle.climatePower ? `${vehicle.targetTemperature}°C · ${vehicle.fan} 档` : '待机'}
          </strong>
        </div>
      </div>
      <svg
        className="car-diagram"
        viewBox="0 0 300 440"
        role="img"
        aria-label="车辆俯视示意，包含四个座位、仪表台和车舱"
      >
        <defs>
          <linearGradient id="car-body" x1="0" y1="0" x2="1" y2="1">
            <stop stopColor="#35424b" />
            <stop offset=".45" stopColor="#172129" />
            <stop offset="1" stopColor="#2d3a42" />
          </linearGradient>
          <linearGradient id="glass" x1="0" y1="0" x2="0" y2="1">
            <stop stopColor="#425761" stopOpacity=".6" />
            <stop offset="1" stopColor="#18262e" stopOpacity=".8" />
          </linearGradient>
          <radialGradient id="air">
            <stop stopColor="#c0ef7c" stopOpacity=".22" />
            <stop offset="1" stopColor="#c0ef7c" stopOpacity="0" />
          </radialGradient>
        </defs>
        <ellipse cx="150" cy="235" rx="116" ry="193" fill="#03080c" opacity=".6" />
        <path
          d="M82 33Q150 7 218 33Q246 69 248 159L248 315Q244 384 215 411Q150 434 85 411Q56 384 52 315V159Q54 69 82 33Z"
          fill="url(#car-body)"
          stroke="#63727a"
          strokeWidth="1.2"
        />
        <path d="M89 46Q150 25 211 46L225 91Q150 65 75 91Z" fill="#25323b" stroke="#52616a" />
        <path
          d="M76 102Q150 74 224 102L213 163Q150 142 87 163Z"
          fill="url(#glass)"
          stroke="#647881"
          strokeWidth=".8"
        />
        <path d="M82 173Q150 150 218 173V334Q150 356 82 334Z" fill="#10191f" stroke="#4b5e68" />
        <path
          d="M62 162L74 186V326L62 311ZM238 162L226 186V326L238 311Z"
          fill="#3b4e58"
          opacity=".6"
        />
        <path
          d="M88 354Q150 371 212 354L205 392Q150 410 95 392Z"
          fill="url(#glass)"
          stroke="#4b5e68"
        />
        <path
          d="M71 64L94 56M206 56L229 64"
          stroke="#c0ef7c"
          strokeWidth="4"
          strokeLinecap="round"
        />
        <path
          d="M76 393L94 402M206 402L224 393"
          stroke="#c77d70"
          strokeWidth="3"
          strokeLinecap="round"
          opacity=".7"
        />
        <path
          d="M52 161L38 174V192L52 187M248 161L262 174V192L248 187"
          fill="#27343c"
          stroke="#566973"
        />
        <path
          d="M91 176Q150 160 209 176"
          fill="none"
          stroke={vehicle.light > 0 ? '#f8d28d' : '#5a7474'}
          strokeWidth="3"
          opacity={vehicle.light > 0 ? '1' : '.4'}
        />
        <rect x="129" y="174" width="42" height="13" rx="3" fill="#4c6671" />
        <rect x="141" y="200" width="18" height="77" rx="7" fill="#2a383f" stroke="#3b505b" />
        <circle cx="110" cy="187" r="12" fill="none" stroke="#7c898f" strokeWidth="3" />
        <path d="M100 188h20M110 188v10" stroke="#7c898f" strokeWidth="2" />
        {[92, 171].map((x) => (
          <g key={x}>
            <rect x={x} y="210" width="39" height="54" rx="13" fill="#2e3b43" stroke="#61717a" />
            <rect x={x + 5} y="202" width="29" height="14" rx="6" fill="#46555e" stroke="#6b7c84" />
            <path d={`M${x + 9} 220v32M${x + 30} 220v32`} stroke="#465a65" />
            <rect x={x} y="289" width="39" height="42" rx="10" fill="#2e3b43" stroke="#61717a" />
            <rect x={x + 5} y="282" width="29" height="13" rx="5" fill="#46555e" />
          </g>
        ))}
        {vehicle.climatePower && (
          <g className="airflow">
            <ellipse cx="150" cy="245" rx="86" ry="100" fill="url(#air)" />
            <path
              d="M105 193q-14 23 0 40t0 40M150 193q-14 23 0 40t0 40M195 193q-14 23 0 40t0 40"
              stroke="#c0ef7c"
              strokeWidth="1.3"
              fill="none"
              strokeDasharray="5 7"
              opacity=".65"
            />
          </g>
        )}
        <path d="M55 218h5M240 218h5M55 315h5M240 315h5" stroke="#8c9ca4" strokeWidth="2" />
      </svg>
      <div className={`device-tag media-tag ${vehicle.playing ? 'on' : ''}`}>
        <Music2 size={15} />
        <div>
          <span>媒体系统</span>
          <strong>{vehicle.playing ? vehicle.track : '未播放'}</strong>
        </div>
        {vehicle.playing && (
          <div className="equalizer">
            <i />
            <i />
            <i />
          </div>
        )}
      </div>
      <div className={`device-tag light-tag ${vehicle.light > 0 ? 'on' : ''}`}>
        <Sun size={15} />
        <div>
          <span>阅读灯</span>
          <strong>{vehicle.light > 0 ? `${vehicle.light}%` : '关闭'}</strong>
        </div>
      </div>
      <div className="cabin-bottom">
        <span>
          <Wind size={12} /> {vehicle.recirculation ? '内循环' : '外循环'}
        </span>
        <span>模拟状态 · 非真实车辆</span>
      </div>
    </div>
  );
}
