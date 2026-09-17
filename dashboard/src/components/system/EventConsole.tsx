import { Pause, Play, Terminal, Trash2 } from 'lucide-react';
import React, { useState } from 'react';
import { formatClockTime } from '../../lib/format';
import { LiveConsoleEvent } from '../../types/dashboard';

interface EventConsoleProps {
  events: LiveConsoleEvent[];
  isPaused: boolean;
  onTogglePause: () => void;
  onClear: () => void;
}

export const EventConsole: React.FC<EventConsoleProps> = ({
  events,
  isPaused,
  onTogglePause,
  onClear,
}) => {
  const [filterType, setFilterType] = useState<string>('ALL');

  const filteredEvents = filterType === 'ALL'
    ? events
    : events.filter((e) => e.type === filterType);

  const getEventBadgeClass = (type: LiveConsoleEvent['type']) => {
    switch (type) {
      case 'TARGET_EVENT':
        return 'event-tag-target';
      case 'MIRROR_ORDER':
        return 'event-tag-mirror';
      case 'POSITION_UPDATE':
        return 'event-tag-position';
      case 'LATENCY_SAMPLE':
        return 'event-tag-latency';
      default:
        return 'event-tag-sys';
    }
  };

  return (
    <div className="terminal-console-root">
      <div className="console-toolbar">
        <div className="console-title-group">
          <Terminal size={14} color="#14f195" />
          <span className="console-title">HOT PATH SSE EVENT STREAM</span>
          <span className="console-count mono">{events.length} Buffered Events</span>
        </div>

        <div className="console-actions">
          {/* Type Filter */}
          <select
            className="console-filter-select mono"
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
          >
            <option value="ALL">All Event Types</option>
            <option value="TARGET_EVENT">TARGET_EVENT</option>
            <option value="MIRROR_ORDER">MIRROR_ORDER</option>
            <option value="POSITION_UPDATE">POSITION_UPDATE</option>
            <option value="LATENCY_SAMPLE">LATENCY_SAMPLE</option>
          </select>

          {/* Pause / Resume */}
          <button
            type="button"
            className={`btn-console-tool ${isPaused ? 'active' : ''}`}
            onClick={onTogglePause}
            title={isPaused ? 'Resume streaming logs' : 'Pause streaming logs'}
          >
            {isPaused ? <Play size={12} /> : <Pause size={12} />}
            <span>{isPaused ? 'Resume' : 'Pause'}</span>
          </button>

          {/* Clear */}
          <button
            type="button"
            className="btn-console-tool"
            onClick={onClear}
            title="Clear buffered logs locally"
          >
            <Trash2 size={12} />
            <span>Clear</span>
          </button>
        </div>
      </div>

      {/* Terminal Viewport */}
      <div className="console-viewport mono">
        {filteredEvents.length === 0 ? (
          <div className="console-empty">
            <span>// Awaiting real-time events from /api/events/stream...</span>
          </div>
        ) : (
          filteredEvents.map((ev) => (
            <div key={ev.id} className="console-line">
              <span className="console-timestamp">{formatClockTime(ev.timestamp)}</span>
              <span className={`console-event-tag ${getEventBadgeClass(ev.type)}`}>
                {ev.type}
              </span>
              <span className="console-summary">{ev.summary}</span>
              <span className="console-raw-payload">
                {JSON.stringify(ev.payload).substring(0, 140)}
                {JSON.stringify(ev.payload).length > 140 ? '...' : ''}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
