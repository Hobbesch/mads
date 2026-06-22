import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
// GitHub-Markdown-Look für die Render-Pipeline (docs/design/08-markdown-editor.md §0).
// Folgt OS-Light/Dark automatisch (prefers-color-scheme), scoped auf `.markdown-body`.
import "github-markdown-css/github-markdown.css";
// Syntax-Highlighting-Theme (highlight.js, github / github-dark) für Codeblöcke — OS-Light/Dark.
import "./mdHighlight.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
