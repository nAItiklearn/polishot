import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Last line of defence: a rendering bug shows a plain message and a way back instead of a blank window.
 * Nothing about the user's capture, text or settings is logged.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    if (import.meta.env.DEV) console.error('[preview] render error', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="pv-fatal" role="alert">
        <p className="pv-fatal-title">Something went wrong in this window.</p>
        <p className="pv-fatal-sub">Your captures are safe in History. Reload to carry on.</p>
        <button type="button" className="pe-btn pe-btn-primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
