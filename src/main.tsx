import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { DetachedMarkdown } from "./DetachedMarkdown";
// App-Styles auch im losgelösten Markdown-Fenster (rendert NICHT <App/>, das die CSS sonst lädt).
import "./App.css";
// GitHub-Markdown-Look für die Render-Pipeline (docs/design/08-markdown-editor.md §0).
// Folgt OS-Light/Dark automatisch (prefers-color-scheme), scoped auf `.markdown-body`.
import "github-markdown-css/github-markdown.css";
// Syntax-Highlighting-Theme (highlight.js, github / github-dark) für Codeblöcke — OS-Light/Dark.
import "./mdHighlight.css";

// Losgelöstes Markdown-Fenster (?detach=md&path=…) → schlanker Render ohne App/Sidecar.
const params = new URLSearchParams(window.location.search);
const detachPath = params.get("detach") === "md" ? params.get("path") : null;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      {detachPath ? <DetachedMarkdown path={detachPath} /> : <App />}
    </ErrorBoundary>
  </React.StrictMode>,
);
