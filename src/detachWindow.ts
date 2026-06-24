import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

/** Stabiles, label-taugliches Kürzel je Pfad (Tauri-Window-Label: [a-zA-Z0-9-/:_]). */
function labelFor(path: string): string {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (Math.imul(h, 31) + path.charCodeAt(i)) | 0;
  return `md-${Math.abs(h).toString(36)}`;
}

/**
 * Markdown-Datei in einem EIGENEN OS-Fenster öffnen (Wunsch: „vom Hauptfenster loslösen").
 * Lädt dieselbe App-Bundle mit `?detach=md&path=…`; main.tsx rendert dort den reinen
 * Markdown-Editor. Liest/schreibt über die geteilte Core-FsScope (vom Hauptfenster
 * registriert). Liefert false, wenn das Fenster nicht erstellt werden konnte (Fallback:
 * Vollbild im selben Fenster).
 */
export async function openMarkdownWindow(path: string): Promise<boolean> {
  try {
    const label = labelFor(path);
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) {
      await existing.setFocus();
      return true;
    }
    const win = new WebviewWindow(label, {
      url: `index.html?detach=md&path=${encodeURIComponent(path)}`,
      title: path.split("/").pop() ?? "Markdown",
      width: 900,
      height: 820,
      resizable: true,
    });
    return await new Promise<boolean>((resolve) => {
      win.once("tauri://created", () => resolve(true));
      win.once("tauri://error", () => resolve(false));
      // Falls keines der Events feuert (z. B. fehlende Capability) → nach kurzer Frist false.
      setTimeout(() => resolve(false), 2500);
    });
  } catch {
    return false;
  }
}
