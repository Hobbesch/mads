import { useEffect } from "react";
import { useStore } from "../store";

/**
 * Leichte globale Save-Notice (docs/design/08-markdown-editor.md §3.3, OE-37) — ein
 * Save ist nicht agent-gebunden, daher ein eigener kleiner Toast (statt der agent-
 * gebundenen `notice()`). Auto-Dismiss nach 2,2 s. Reine UI: liest `saveNotice`.
 */
export function SaveToast() {
  const saveNotice = useStore((s) => s.saveNotice);
  const clear = useStore((s) => s.clearSaveNotice);

  useEffect(() => {
    if (!saveNotice) return;
    const t = setTimeout(clear, 2200);
    return () => clearTimeout(t);
  }, [saveNotice, clear]);

  if (!saveNotice) return null;
  return (
    <div className={`save-toast ${saveNotice.tone}`} role="status" aria-live="polite" onClick={clear}>
      {saveNotice.text}
    </div>
  );
}
