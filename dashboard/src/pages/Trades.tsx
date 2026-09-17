import React from 'react';
import { TradeFeed } from '../components/trading/TradeFeed';
import { Order } from '../types/dashboard';

interface TradesProps {
  orders: Order[];
  isLoading?: boolean;
}

export const Trades: React.FC<TradesProps> = ({ orders, isLoading }) => {
  return (
    <div className="trades-page-root">
      <div className="page-header-block">
        <h2 className="page-title">Live Mirror Trades</h2>
        <p className="page-subtitle">
          Real-time stream of detected target trader signals, risk evaluations, and follower execution orders. Click any row to inspect side-by-side reconciliation.
        </p>
      </div>

      <TradeFeed orders={orders} isLoading={isLoading} />
    </div>
  );
};
