/**
 * Externer Link-Öffner mit Bestätigung (docs/design/08-markdown-editor.md §5.4).
 *
 * paix-Invariante 4 (außen-sichtbare Aktionen explizit): `https`-Links öffnen direkt,
 * ALLES andere (`http`, `file:`, custom schemes) nur nach Bestätigung mit voll
 * sichtbarem Ziel-URL. Verwendet von Chat-Markdown (`MessageTimeline`) UND der
 * Editor-Preview (`MarkdownEditor`) — eine Stelle, eine Policy.
 */
import { openUrl } from "@tauri-apps/plugin-opener";

export function openExternalLink(href: string): void {
  let scheme = "";
  try {
    scheme = new URL(href).protocol.replace(/:$/, "").toLowerCase();
  } catch {
    // Relativ/ungültig → wie ein nicht-https-Ziel behandeln (Bestätigung).
    scheme = "";
  }
  if (scheme === "https") {
    void openUrl(href);
    return;
  }
  if (confirm(`Externen Link öffnen?\n\n${href}`)) {
    void openUrl(href);
  }
}
