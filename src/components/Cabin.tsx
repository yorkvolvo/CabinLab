import { ChevronUp, Fan, Music2, Sun } from 'lucide-react';
import { useId } from 'react';
import type { Vehicle } from '../domain/runtime';

const occupancy = (value: boolean | undefined) =>
  value === undefined ? '未采集' : value ? '有人' : '空座';

export default function Cabin({ vehicle, active }: { vehicle: Vehicle; active: boolean }) {
  const id = useId();
  const seats = [
    { label: '主驾', occupied: vehicle.driverOccupied, heated: (vehicle.driverHeat ?? 0) > 0 },
    { label: '副驾', occupied: vehicle.passengerOccupied, heated: false },
  ];
  const devices = [
    {
      icon: Fan,
      label: '空调',
      enabled: vehicle.climatePower,
      value: vehicle.climatePower ? `${vehicle.targetTemperature}°C · ${vehicle.fan} 档` : '待机',
      detail: vehicle.recirculation ? '内循环' : '外循环',
    },
    {
      icon: Music2,
      label: '媒体',
      enabled: vehicle.playing,
      value: vehicle.playing ? (vehicle.track ?? '播放中') : '未播放',
      detail: `音量 ${vehicle.volume}%`,
    },
    {
      icon: Sun,
      label: '阅读灯',
      enabled: vehicle.light > 0,
      value: vehicle.light > 0 ? `${vehicle.light}%` : '关闭',
      detail: '座舱照明',
    },
  ];
  const feedback = [
    {
      label: '车窗回读',
      value:
        vehicle.windowsClosed === undefined
          ? undefined
          : vehicle.windowsClosed
            ? '四门全闭'
            : '未全闭',
      on: vehicle.windowsClosed,
    },
    {
      label: '前挡除雾回读',
      value:
        vehicle.frontDefrost === undefined ? undefined : vehicle.frontDefrost ? '已开启' : '已关闭',
      on: vehicle.frontDefrost,
    },
    {
      label: '后视镜加热回读',
      value:
        vehicle.mirrorHeat === undefined ? undefined : vehicle.mirrorHeat ? '已开启' : '已关闭',
      on: vehicle.mirrorHeat,
    },
    {
      label: '主驾座椅加热回读',
      value: vehicle.driverHeat === undefined ? undefined : `${vehicle.driverHeat} 档`,
      on: (vehicle.driverHeat ?? 0) > 0,
    },
    {
      label: '充电',
      value: vehicle.charging === undefined ? undefined : vehicle.charging ? '已插枪' : '未插枪',
      on: vehicle.charging,
    },
    {
      label: '主驾车门',
      value:
        vehicle.driverDoorOpen === undefined
          ? undefined
          : vehicle.driverDoorOpen
            ? '已打开'
            : '已关闭',
      on: vehicle.driverDoorOpen,
    },
    {
      label: '后排占用',
      value: vehicle.rearOccupied === undefined ? undefined : occupancy(vehicle.rearOccupied),
      on: vehicle.rearOccupied,
    },
    {
      label: '宠物在舱',
      value:
        vehicle.petPresent === undefined ? undefined : vehicle.petPresent ? '已确认' : '未确认',
      on: vehicle.petPresent,
    },
  ].filter((item) => item.value !== undefined);

  return (
    <section className={`cabin-view ${active ? 'cabin-active' : ''}`} aria-label="虚拟座舱状态图">
      <div className="cabin-stage">
        <div className="cabin-caption">
          <span>
            <ChevronUp size={13} /> 车头方向
          </span>
          <span className="cabin-stage-status">
            <i className="live-dot" /> {active ? '预演中' : '状态预览'}
          </span>
        </div>
        <div className="cabin-vehicle">
          <svg
            className="car-diagram"
            viewBox="0 0 260 340"
            role="img"
            aria-label="车辆俯视图，显示车门、车窗、座位与座舱设备状态"
          >
            <defs>
              <linearGradient id={`${id}-body`} x1="0" x2="1" y1="0" y2=".85">
                <stop stopColor="#809591" />
                <stop offset=".26" stopColor="#3c5656" />
                <stop offset=".58" stopColor="#22393b" />
                <stop offset="1" stopColor="#536962" />
              </linearGradient>
              <linearGradient id={`${id}-glass`} x1="0" x2="1" y1="0" y2="1">
                <stop stopColor="#4c777c" />
                <stop offset="1" stopColor="#172d35" />
              </linearGradient>
              <radialGradient id={`${id}-air`}>
                <stop stopColor="#78d8db" stopOpacity=".27" />
                <stop offset="1" stopColor="#78d8db" stopOpacity="0" />
              </radialGradient>
            </defs>
            <ellipse cx="130" cy="304" rx="97" ry="25" fill="#050a0d" opacity=".66" />
            <g fill="#0b1215" stroke="#526368">
              <rect x="45" y="62" width="23" height="57" rx="8" />
              <rect x="192" y="62" width="23" height="57" rx="8" />
              <rect x="45" y="226" width="23" height="56" rx="8" />
              <rect x="192" y="226" width="23" height="56" rx="8" />
              <path
                d="M50 75v29m160-29v29M50 240v29m160-29v29"
                fill="none"
                stroke="#2a393d"
                strokeWidth="2"
              />
            </g>
            <path
              d="M89 19Q130 6 171 19C196 28 208 61 208 111v150q-1 41-26 56-52 17-104 0-25-15-26-56V111c0-50 12-83 37-92Z"
              fill={`url(#${id}-body)`}
              stroke="#78968f"
              strokeWidth="1.4"
            />
            <path d="M81 41Q130 19 179 41L189 63Q130 48 71 63Z" fill="#263f43" stroke="#658181" />
            <path
              d="M70 80Q130 53 190 80L183 119Q130 99 77 119Z"
              fill={`url(#${id}-glass)`}
              stroke={vehicle.frontDefrost ? '#edb866' : '#7c9997'}
              strokeWidth={vehicle.frontDefrost ? 2 : 1}
            />
            <path d="M85 129Q130 108 175 129l8 129q-53 19-106 0Z" fill="#0d1b20" stroke="#526e6e" />
            <path
              d="M77 275Q130 289 183 275l-11 23q-42 12-84 0Z"
              fill={`url(#${id}-glass)`}
              stroke="#668081"
            />
            <path
              d="M61 117l13 13-5 129-8-12ZM199 117l-13 13 5 129 8-12Z"
              fill={vehicle.windowsClosed ? '#74b7b9' : '#355660'}
              stroke="#789293"
            />
            <path
              d="M54 123l-17 7-2 12 18-3M206 123l17 7 2 12-18-3"
              fill={vehicle.mirrorHeat ? '#e7a55c' : '#4b6566'}
              stroke={vehicle.mirrorHeat ? '#ffdb9a' : '#849a99'}
            />
            {vehicle.driverDoorOpen && (
              <path d="M63 133 38 152v58l23-8Z" fill="#42564a" stroke="#e2ba79" strokeWidth="2" />
            )}
            <path
              d="M65 45l27-10m76 0 27 10"
              stroke="#d9f9c1"
              strokeWidth="4"
              strokeLinecap="round"
            />
            <path
              d="M66 300l19 8m90 0 19-8"
              stroke="#eb7b67"
              strokeWidth="3.5"
              strokeLinecap="round"
            />
            <path
              d="M85 133q45-17 90 0"
              fill="none"
              stroke={vehicle.light > 0 ? '#ffd28c' : '#557b79'}
              strokeWidth={vehicle.light > 0 ? 3 : 1.5}
            />
            <rect x="116" y="131" width="29" height="9" rx="3" fill="#639291" />
            <circle cx="100" cy="141" r="9" fill="#152427" stroke="#9ab2ac" strokeWidth="2" />
            <path d="M92 142h16m-8 0v7" stroke="#9ab2ac" />
            <rect x="124" y="148" width="12" height="61" rx="4" fill="#253e41" stroke="#46676b" />
            <circle cx="130" cy="188" r="3" fill="#6a8988" />
            {vehicle.frontDefrost && (
              <path
                d="M105 103q-8-8 0-16m25 15q-8-8 0-16m25 17q-8-8 0-16"
                fill="none"
                stroke="#ffd185"
                strokeWidth="2"
                strokeLinecap="round"
              />
            )}
            {vehicle.climatePower && (
              <g className="airflow">
                <ellipse cx="130" cy="190" rx="65" ry="76" fill={`url(#${id}-air)`} />
                <path
                  d="M104 150q-15 22-5 47m31-48v55m26-54q15 22 5 47"
                  stroke="#8ad7d8"
                  strokeWidth="1.5"
                  fill="none"
                  strokeDasharray="5 7"
                  opacity=".76"
                />
              </g>
            )}
            {seats.map(({ label, occupied, heated }, index) => (
              <g
                key={label}
                transform={`translate(${index ? 145 : 86} 155)`}
                className={heated ? 'seat-heated' : occupied ? 'seat-occupied' : undefined}
              >
                <rect className="seat-shell" x="0" y="7" width="30" height="47" rx="10" />
                <rect className="seat-head" x="5" width="20" height="12" rx="4" />
                <path className="seat-trim" d="M6 18v18q0 8 8 8h2q8 0 8-8V18M7 32h16" fill="none" />
                {occupied && <circle cx="15" cy="25" r="3" fill="#d7f4b6" />}
              </g>
            ))}
            <g className={vehicle.rearOccupied ? 'seat-occupied' : undefined}>
              <rect className="seat-shell" x="88" y="220" width="84" height="33" rx="10" />
              <path className="seat-trim" d="M116 221v30m28-30v30m-50-13h72" fill="none" />
            </g>
          </svg>
          {seats.map(({ label, occupied }, index) => (
            <div
              key={label}
              className={`cabin-seat cabin-seat-${index ? 'right' : 'left'} ${occupied ? 'occupied' : ''}`}
            >
              <span>{label}</span>
              <strong>{occupancy(occupied)}</strong>
            </div>
          ))}
        </div>
      </div>
      <div className="cabin-devices" aria-label="座舱设备">
        {devices.map(({ icon: Icon, label, enabled, value, detail }) => (
          <div className={`cabin-device ${enabled ? 'on' : ''}`} key={label}>
            <div>
              <Icon size={15} /> <span>{label}</span>
            </div>
            <strong>{value}</strong>
            <small>{detail}</small>
          </div>
        ))}
      </div>
      {feedback.length > 0 && (
        <div className="cabin-feedback" aria-label="设备回读">
          {feedback.map(({ label, value, on }) => (
            <span className={on ? 'on' : ''} key={label}>
              {label}：<strong>{value}</strong>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
