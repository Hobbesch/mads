import type React from "react";

/**
 * Kompakte Such-Leiste für den Markdown-Editor (Feature: Text im Dokument finden).
 * Rein präsentational — die gesamte Navigations-/Treffer-Logik liegt im `MarkdownEditor`
 * (treibt CodeMirror in Edit/Split bzw. die gerenderte Vorschau in Preview). Spiegelt den
 * Stil von `MarkdownToolbar`/`MarkdownSource`: keine I/O, `aria-label`/`title` an jedem Button.
 */
export interface MarkdownSearchBarProps {
  query: string;
  onQueryChange(q: string): void;
  /** 1-basierter Index des aktiven Treffers, 0 = kein Treffer. */
  current: number;
  /** Gesamtzahl der Treffer. */
  total: number;
  onNext(): void;
  onPrev(): void;
  onClose(): void;
  /** Damit ⌘F das Feld fokussieren + selektieren kann. */
  inputRef: React.RefObject<HTMLInputElement | null>;
}

export function MarkdownSearchBar({
  query,
  onQueryChange,
  current,
  total,
  onNext,
  onPrev,
  onClose,
  inputRef,
}: MarkdownSearchBarProps) {
  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) onPrev();
      else onNext();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="md-search" role="search">
      <input
        className="md-search-input"
        ref={inputRef}
        value={query}
        placeholder="Suchen…"
        aria-label="Im Dokument suchen"
        spellCheck={false}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={onInputKey}
      />
      <span className="md-search-count" aria-live="polite">
        {total ? `${current}/${total}` : query ? "0/0" : ""}
      </span>
      <button
        className="md-iconbtn"
        onClick={onPrev}
        disabled={!total}
        title="Vorheriger Treffer (⇧⏎)"
        aria-label="Vorheriger Treffer"
      >
        ↑
      </button>
      <button
        className="md-iconbtn"
        onClick={onNext}
        disabled={!total}
        title="Nächster Treffer (⏎)"
        aria-label="Nächster Treffer"
      >
        ↓
      </button>
      <button className="md-iconbtn" onClick={onClose} title="Schließen (Esc)" aria-label="Suche schließen">
        ✕
      </button>
    </div>
  );
}
