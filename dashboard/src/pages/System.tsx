import React from 'react';
import { EventConsole } from '../components/system/EventConsole';
import { SystemDiagnostics } from '../components/system/SystemDiagnostics';
import { ExecutionWalletCard } from '../components/wallet/ExecutionWalletCard';
import { WalletInfoCard } from '../components/wallet/WalletInfoCard';
import { LiveConsoleEvent, StreamStatus, Telemetry } from '../types/dashboard';

interface SystemProps {
  telemetry: Telemetry | null;
  streamStatus: StreamStatus;
  events: LiveConsoleEvent[];
  isStreamPaused: boolean;
  onToggleStreamPause: () => void;
  onClearEvents: () => void;
}

export const System: React.FC<SystemProps> = ({
  telemetry,
  streamStatus,
  events,
  isStreamPaused,
  onToggleStreamPause,
  onClearEvents,
}) => {
  return (
    <div className="system-page-root">
      <div className="page-header-block">
        <h2 className="page-title">System Diagnostics & Event Stream</h2>
        <p className="page-subtitle">
          Internal node process telemetry, database sync states, and real-time Server-Sent Events (SSE) message log.
        </p>
      </div>

      <SystemDiagnostics telemetry={telemetry} streamStatus={streamStatus} />

      <div style={{ marginTop: 20 }}>
        <ExecutionWalletCard />
      </div>

      <div style={{ marginTop: 20 }}>
        <WalletInfoCard />
      </div>

      <div style={{ marginTop: 24 }}>
        <EventConsole
          events={events}
          isPaused={isStreamPaused}
          onTogglePause={onToggleStreamPause}
          onClear={onClearEvents}
        />
      </div>
    </div>
  );
};
