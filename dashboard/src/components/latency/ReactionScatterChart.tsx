import React, { useState } from 'react';
import { formatLatency, formatShortAddress } from '../../lib/format';
import { LatencySample } from '../../types/dashboard';
import { EmptyState } from '../common/EmptyState';

interface ReactionScatterChartProps {
  samples: LatencySample[];
}

export const ReactionScatterChart: React.FC<ReactionScatterChartProps> = ({ samples }) => {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  if (samples.length === 0) {
    return (
      <div className="terminal-chart-box">
        <div className="chart-header">
          <span className="chart-title">REACTION LATENCY TIMELINE</span>
          <span className="chart-badge">MEASURED SAMPLES</span>
        </div>
        <EmptyState
          title="No Latency Samples"
          description="Latency benchmarks will populate as live trades are processed by the mirror engine."
        />
      </div>
    );
  }

  // Reverse so chronological order left to right
  const data = [...samples].reverse().slice(-40);
  const width = 700;
  const height = 220;
  const padding = { top: 20, right: 30, bottom: 30, left: 45 };

  const values = data.map((s) => (s.l_decision_ms || 0) + (s.l_quote_ms || 0) + (s.l_submit_ms || 0));
  const maxVal = Math.max(100, Math.ceil(Math.max(...values, 50) / 50) * 50);

  const xScale = (idx: number) =>
    padding.left + (idx / Math.max(1, data.length - 1)) * (width - padding.left - padding.right);
  const yScale = (val: number) =>
    height - padding.bottom - (Math.min(val, maxVal) / maxVal) * (height - padding.top - padding.bottom);

  // 100ms target line
  const target100Y = yScale(100);

  // Path generator
  const points = data.map((s, idx) => ({
    x: xScale(idx),
    y: yScale((s.l_decision_ms || 0) + (s.l_quote_ms || 0) + (s.l_submit_ms || 0)),
    sample: s,
    val: (s.l_decision_ms || 0) + (s.l_quote_ms || 0) + (s.l_submit_ms || 0),
  }));

  const pathD = points.length > 1
    ? points.reduce((acc, pt, i) => `${acc} ${i === 0 ? 'M' : 'L'} ${pt.x},${pt.y}`, '')
    : '';

  return (
    <div className="terminal-chart-box">
      <div className="chart-header">
        <div>
          <span className="chart-title">REACTION LATENCY TIMELINE</span>
          <span className="chart-subtitle">Decision to transaction preflight dispatch (ms)</span>
        </div>
        <div className="chart-legend">
          <span className="legend-item">
            <span className="legend-dot dot-cyan" /> Reaction Sample
          </span>
          <span className="legend-item">
            <span className="legend-line line-target" /> 100ms SLA Target
          </span>
        </div>
      </div>

      <div className="svg-chart-wrapper">
        <svg viewBox={`0 0 ${width} ${height}`} className="terminal-svg-chart">
          {/* Horizontal Gridlines */}
          {[0, maxVal * 0.25, maxVal * 0.5, maxVal * 0.75, maxVal].map((tick) => {
            const y = yScale(tick);
            return (
              <g key={tick}>
                <line
                  x1={padding.left}
                  y1={y}
                  x2={width - padding.right}
                  y2={y}
                  stroke="rgba(255, 255, 255, 0.06)"
                  strokeDasharray="3 3"
                />
                <text
                  x={padding.left - 8}
                  y={y + 3}
                  textAnchor="end"
                  className="chart-axis-text"
                >
                  {tick.toFixed(0)}ms
                </text>
              </g>
            );
          })}

          {/* 100ms Goal Threshold Line */}
          {100 <= maxVal && (
            <g>
              <line
                x1={padding.left}
                y1={target100Y}
                x2={width - padding.right}
                y2={target100Y}
                stroke="#10b981"
                strokeWidth="1.5"
                strokeDasharray="4 4"
                opacity="0.6"
              />
              <text
                x={width - padding.right - 4}
                y={target100Y - 4}
                textAnchor="end"
                fill="#10b981"
                fontSize="9"
                fontWeight="600"
              >
                100ms Fast-Path Target
              </text>
            </g>
          )}

          {/* Line connecting points */}
          {pathD && (
            <path
              d={pathD}
              fill="none"
              stroke="#00e5ff"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity="0.85"
            />
          )}

          {/* Data Points */}
          {points.map((pt, idx) => (
            <circle
              key={idx}
              cx={pt.x}
              cy={pt.y}
              r={hoveredIdx === idx ? 5 : 3.5}
              fill={pt.val < 50 ? '#14f195' : pt.val <= 100 ? '#00e5ff' : '#f59e0b'}
              stroke="#07090d"
              strokeWidth="1.5"
              className="chart-point"
              onMouseEnter={() => setHoveredIdx(idx)}
              onMouseLeave={() => setHoveredIdx(null)}
            />
          ))}

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
                stroke="rgba(0, 229, 255, 0.4)"
                strokeWidth="1"
              />
              <text x="60" y="15" textAnchor="middle" fill="#f4f7fb" fontSize="10" fontWeight="700">
                {formatLatency(points[hoveredIdx].val)}
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
