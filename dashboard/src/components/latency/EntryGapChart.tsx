import React, { useState } from 'react';
import { formatBps, formatShortAddress } from '../../lib/format';
import { LatencySample } from '../../types/dashboard';
import { EmptyState } from '../common/EmptyState';

interface EntryGapChartProps {
  samples: LatencySample[];
}

export const EntryGapChart: React.FC<EntryGapChartProps> = ({ samples }) => {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const gapSamples = samples.filter((s) => s.entry_gap_bps !== null && s.entry_gap_bps !== undefined);

  if (gapSamples.length === 0) {
    return (
      <div className="terminal-chart-box">
        <div className="chart-header">
          <span className="chart-title">ENTRY PRICE GAP TIMELINE (BPS)</span>
        </div>
        <EmptyState
          title="No Entry Gap Samples"
          description="Slippage and execution gap metrics will be tracked as trades land on-chain."
        />
      </div>
    );
  }

  const data = [...gapSamples].reverse().slice(-40);
  const width = 700;
  const height = 220;
  const padding = { top: 25, right: 30, bottom: 30, left: 55 };

  const values = data.map((s) => s.entry_gap_bps || 0);
  const minVal = Math.min(-50, Math.floor(Math.min(...values, 0) / 50) * 50);
  const maxVal = Math.max(250, Math.ceil(Math.max(...values, 200) / 50) * 50);
  const range = maxVal - minVal || 1;

  const xScale = (idx: number) =>
    padding.left + (idx / Math.max(1, data.length - 1)) * (width - padding.left - padding.right);
  const yScale = (val: number) =>
    height - padding.bottom - ((val - minVal) / range) * (height - padding.top - padding.bottom);

  const zeroY = yScale(0);
  const threshold200Y = yScale(200);

  const points = data.map((s, idx) => ({
    x: xScale(idx),
    y: yScale(s.entry_gap_bps || 0),
    val: s.entry_gap_bps || 0,
    sample: s,
  }));

  const pathD = points.length > 1
    ? points.reduce((acc, pt, i) => `${acc} ${i === 0 ? 'M' : 'L'} ${pt.x},${pt.y}`, '')
    : '';

  return (
    <div className="terminal-chart-box">
      <div className="chart-header">
        <div>
          <span className="chart-title">ENTRY PRICE GAP TIMELINE (BPS)</span>
          <span className="chart-subtitle">Follower price slippage vs target trader (1 bps = 0.01%)</span>
        </div>
        <div className="chart-legend">
          <span className="legend-item">
            <span className="legend-line line-zero" /> 0 bps Parity
          </span>
          <span className="legend-item">
            <span className="legend-line line-danger" /> 200 bps Max Gap Threshold
          </span>
        </div>
      </div>

      <div className="svg-chart-wrapper">
        <svg viewBox={`0 0 ${width} ${height}`} className="terminal-svg-chart">
          {/* Zero Parity Reference Line */}
          <line
            x1={padding.left}
            y1={zeroY}
            x2={width - padding.right}
            y2={zeroY}
            stroke="#94a3b8"
            strokeWidth="1"
            strokeDasharray="4 4"
            opacity="0.5"
          />
          <text
            x={padding.left - 8}
            y={zeroY + 3}
            textAnchor="end"
            className="chart-axis-text"
            fill="#94a3b8"
          >
            0 bps
          </text>

          {/* 200 bps Max Slippage Threshold Line */}
          {200 <= maxVal && (
            <line
              x1={padding.left}
              y1={threshold200Y}
              x2={width - padding.right}
              y2={threshold200Y}
              stroke="#ef4444"
              strokeWidth="1.25"
              strokeDasharray="3 3"
              opacity="0.65"
            />
          )}

          {/* Ticks */}
          {[minVal, maxVal].map((tick) => {
            const y = yScale(tick);
            return (
              <g key={tick}>
                <line
                  x1={padding.left}
                  y1={y}
                  x2={width - padding.right}
                  y2={y}
                  stroke="rgba(255, 255, 255, 0.05)"
                />
                <text
                  x={padding.left - 8}
                  y={y + 3}
                  textAnchor="end"
                  className="chart-axis-text"
                >
                  {tick > 0 ? `+${tick}` : tick} bps
                </text>
              </g>
            );
          })}

          {/* Path */}
          {pathD && (
            <path
              d={pathD}
              fill="none"
              stroke="#14f195"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}

          {/* Points */}
          {points.map((pt, idx) => {
            const isFavorable = pt.val <= 50;
            const isCritical = pt.val > 200;
            const fill = isFavorable ? '#10b981' : isCritical ? '#ef4444' : '#f59e0b';

            return (
              <circle
                key={idx}
                cx={pt.x}
                cy={pt.y}
                r={hoveredIdx === idx ? 5 : 3.5}
                fill={fill}
                stroke="#07090d"
                strokeWidth="1.5"
                className="chart-point"
                onMouseEnter={() => setHoveredIdx(idx)}
                onMouseLeave={() => setHoveredIdx(null)}
              />
            );
          })}

          {/* Tooltip Overlay */}
          {hoveredIdx !== null && points[hoveredIdx] && (
            <g
              transform={`translate(${Math.min(
                Math.max(points[hoveredIdx].x - 60, padding.left),
                width - padding.right - 120
              )}, ${Math.max(points[hoveredIdx].y - 45, 10)})`}
            >
              <rect
                width="120"
                height="36"
                rx="4"
                fill="#0d1117"
                stroke="rgba(20, 241, 149, 0.4)"
                strokeWidth="1"
              />
              <text x="60" y="15" textAnchor="middle" fill="#f4f7fb" fontSize="10" fontWeight="700">
                {formatBps(points[hoveredIdx].val)}
              </text>
              <text x="60" y="28" textAnchor="middle" fill="#8993a4" fontSize="8">
                {formatShortAddress(points[hoveredIdx].sample.target_signature, 4, 4)}
              </text>
            </g>
          )}
        </svg>
      </div>
    </div>
  );
};
