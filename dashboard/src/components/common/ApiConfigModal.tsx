import { CheckCircle2, Globe, RefreshCw, Server, XCircle } from 'lucide-react';
import React, { useState } from 'react';
import { getApiBase, setApiBase } from '../../lib/api';
import { Modal } from './Modal';

interface ApiConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export const ApiConfigModal: React.FC<ApiConfigModalProps> = ({
  isOpen,
  onClose,
  onSaved,
}) => {
  const [apiUrl, setApiUrl] = useState<string>(getApiBase());
  const [testState, setTestState] = useState<'IDLE' | 'TESTING' | 'SUCCESS' | 'ERROR'>('IDLE');
  const [testMsg, setTestMsg] = useState<string>('');

  const handleTest = async () => {
    setTestState('TESTING');
    setTestMsg('');
    const testTarget = apiUrl.trim().replace(/\/+$/, '');

    try {
      const url = testTarget ? `${testTarget}/api/telemetry` : '/api/telemetry';
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!res.ok) {
        throw new Error(`Server returned HTTP ${res.status}`);
      }
      const data = await res.json();
      setTestState('SUCCESS');
      setTestMsg(`Connected! Mode: ${data.executionMode || 'ACTIVE'}, Total Orders: ${data.totalOrders ?? 0}`);
    } catch (err: any) {
      setTestState('ERROR');
      if (err.name === 'AbortError') {
        setTestMsg('Connection timed out after 5s. Verify backend is running.');
      } else {
        setTestMsg(err.message || 'Failed to connect to backend server.');
      }
    }
  };

  const handleSave = () => {
    setApiBase(apiUrl.trim());
    onSaved();
    onClose();
  };

  const handleReset = () => {
    setApiUrl('');
    setApiBase('');
    setTestState('IDLE');
    setTestMsg('');
    onSaved();
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Backend Bot API Connection"
      subtitle="Connect this Web Terminal to your live Solana copy-trading bot"
      maxWidth={520}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div>
          <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
            BOT BACKEND URL (REST & SSE)
          </label>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              type="text"
              className="wallet-input"
              style={{ flex: 1, padding: '10px 12px', background: 'rgba(15, 23, 42, 0.6)', border: '1px solid var(--border-subtle)', borderRadius: '6px', color: '#fff', fontSize: '13px' }}
              placeholder="e.g. http://localhost:3001 or https://my-bot.up.railway.app"
              value={apiUrl}
              onChange={(e) => {
                setApiUrl(e.target.value);
                setTestState('IDLE');
              }}
            />
            <button
              type="button"
              className="btn-primary"
              style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '0 14px', whiteSpace: 'nowrap' }}
              onClick={handleTest}
              disabled={testState === 'TESTING'}
            >
              {testState === 'TESTING' ? (
                <>
                  <RefreshCw size={13} className="spin" />
                  <span>Testing...</span>
                </>
              ) : (
                <>
                  <Server size={13} />
                  <span>Test</span>
                </>
              )}
            </button>
          </div>
          <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '6px 0 0 0' }}>
            Leave blank to use default relative path (standard when running locally or on same domain).
          </p>
        </div>

        {/* Test status banner */}
        {testState === 'SUCCESS' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px', background: 'rgba(16, 185, 129, 0.1)', border: '1px solid rgba(16, 185, 129, 0.3)', borderRadius: '6px', color: '#10b981', fontSize: '12px' }}>
            <CheckCircle2 size={16} />
            <span>{testMsg}</span>
          </div>
        )}

        {testState === 'ERROR' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '6px', color: '#ef4444', fontSize: '12px' }}>
            <XCircle size={16} />
            <span>{testMsg}</span>
          </div>
        )}

        {/* Informational Guidance */}
        <div style={{ background: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--border-subtle)', borderRadius: '6px', padding: '12px', fontSize: '11px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Globe size={13} color="#29d4ff" />
            <span>Deploying & Remote Access</span>
          </div>
          <p style={{ margin: 0 }}>
            When viewing on Vercel:
            <br />
            • If running the bot backend locally, you can expose it securely via ngrok (e.g. <code>ngrok http 3001</code>) and paste the HTTPS URL above.
            <br />
            • Or deploy the backend to Railway / Render / Fly.io and enter its public URL.
          </p>
        </div>

        {/* Action Buttons */}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '8px' }}>
          <button
            type="button"
            className="btn-danger"
            style={{ background: 'transparent', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)', padding: '8px 12px', borderRadius: '6px', fontSize: '12px' }}
            onClick={handleReset}
          >
            Reset to Default
          </button>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              className="btn-primary"
              style={{ background: 'rgba(255, 255, 255, 0.05)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)', padding: '8px 14px', borderRadius: '6px', fontSize: '12px' }}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              style={{ padding: '8px 18px', borderRadius: '6px', fontSize: '12px', fontWeight: 600 }}
              onClick={handleSave}
            >
              Save & Apply
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
};
