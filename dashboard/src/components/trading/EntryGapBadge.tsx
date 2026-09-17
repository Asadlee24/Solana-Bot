import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import React from 'react';

interface EntryGapBadgeProps {
  entryGapPct?: number | null;
  entryGapBps?: number | null;
  isEstimated?: boolean;
}

export const EntryGapBadge: React.FC<EntryGapBadgeProps> = ({
  entryGapPct,
  entryGapBps,
  isEstimated = false,
}) => {
  if (entryGapPct === undefined || entryGapPct === null || isNaN(entryGapPct)) {
    return <span className="entry-gap-pill neutral">—</span>;
  }

  const isZero = Math.abs(entryGapPct) < 0.05;
  const isBetter = entryGapPct < -0.05; // Bought cheaper than trader
  const isAcceptable = entryGapPct >= 0 && entryGapPct <= 2.0; // Under 200 bps
  const isWorse = entryGapPct > 2.0; // Over 200 bps slippage

  const toneClass = isZero
    ? 'neutral'
    : isBetter
    ? 'favorable'
    : isAcceptable
    ? 'acceptable'
    : 'unfavorable';

  const prefix = entryGapPct > 0 ? '+' : '';
  const bpsStr = entryGapBps !== undefined && entryGapBps !== null ? ` (${prefix}${entryGapBps} bps)` : '';

  return (
    <span
      className={`entry-gap-pill ${toneClass}`}
      title={`${prefix}${entryGapPct.toFixed(2)}% gap vs target trader execution${
        isEstimated ? ' (Estimated from AMM pool depth)' : ' (Measured on-chain)'
      }`}
    >
      {isZero ? (
        <Minus size={11} />
      ) : isBetter ? (
        <ArrowDownRight size={11} />
      ) : (
        <ArrowUpRight size={11} />
      )}
      <span>
        {prefix}
        {entryGapPct.toFixed(1)}%{bpsStr}
      </span>
      {isEstimated && <span className="tag-est">EST</span>}
    </span>
  );
};
