import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  error: Error | null;
}

/**
 * Fängt Render-Fehler ab, damit die App im Fehlerfall eine lesbare Meldung zeigt
 * (statt eines leeren grauen Fensters) — und der Fehler diagnostizierbar wird.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("mads UI-Fehler:", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="fatal-error">
        <div className="fatal-card">
          <div className="fatal-title">mads konnte die Oberfläche nicht laden</div>
          <div className="fatal-sub">Ein Fehler beim Rendern hat die App gestoppt:</div>
          <pre className="fatal-trace">{error.stack || error.message}</pre>
          <button className="fatal-reload" onClick={() => location.reload()}>
            Neu laden
          </button>
        </div>
      </div>
    );
  }
}
