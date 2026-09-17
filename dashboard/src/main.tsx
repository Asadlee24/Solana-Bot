import React, { Component, ErrorInfo, ReactNode } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[Dashboard Error Boundary Caught]:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh',
          backgroundColor: '#07090e',
          color: '#e2e8f0',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          fontFamily: 'Inter, system-ui, sans-serif'
        }}>
          <div style={{
            maxWidth: '520px',
            width: '100%',
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,77,77,0.3)',
            borderRadius: '12px',
            padding: '24px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.6)'
          }}>
            <h2 style={{ color: '#ff4d4d', fontSize: '18px', marginBottom: '12px', fontWeight: 700 }}>
              Dashboard Notice
            </h2>
            <p style={{ color: '#94a3b8', fontSize: '13px', lineHeight: 1.6, marginBottom: '16px' }}>
              The trading terminal encountered an issue while rendering. You can reload or check the console.
            </p>
            <pre style={{
              background: 'rgba(0,0,0,0.5)',
              padding: '12px',
              borderRadius: '6px',
              fontSize: '11px',
              color: '#fca5a5',
              overflowX: 'auto',
              marginBottom: '16px'
            }}>
              {this.state.error?.message || 'Unknown error'}
            </pre>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                padding: '8px 16px',
                background: '#14f195',
                color: '#07090e',
                border: 'none',
                borderRadius: '6px',
                fontWeight: 700,
                fontSize: '12px',
                cursor: 'pointer'
              }}
            >
              Reload Dashboard
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
