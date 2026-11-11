import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  failed: boolean;
}

/**
 * Last line of defence: a rendering bug shows a plain message and a way back instead of a blank window.
 * The error and where it happened (message, stack, component stack) are written to the console so a
 * crash can be diagnosed; nothing about the user's capture, text or settings is added to it.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  private offHmr: (() => void) | undefined;

  override componentDidMount(): void {
    // During development a hot update can leave modules briefly out of step (a component renders against an
    // API that has not reloaded yet). Once the update has finished, try again instead of staying stuck.
    if (import.meta.hot) {
      const retry = () => this.setState((s) => (s.failed ? { failed: false } : null));
      import.meta.hot.on('vite:afterUpdate', retry);
      this.offHmr = () => import.meta.hot?.off('vite:afterUpdate', retry);
    }
  }

  override componentWillUnmount(): void {
    this.offHmr?.();
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[preview] render error: ${error.name}: ${error.message}\n${error.stack ?? '(no stack)'}\nComponent stack:${info.componentStack ?? ' (none)'}`);
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
