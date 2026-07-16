/**
 * Blob-/Base64-Helfer (docs/design/08-markdown-editor.md §2.3) — aus `Inspector.tsx`
 * gehoben, damit Composer-Bild-Paste UND Markdown-Bild-Paste denselben Code teilen
 * (statt zwei Kopien). Reine UI-Utilities, kein FS/Prozess.
 */

/** Base64-Payload (ohne `data:`-Präfix) eines Blobs. */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Base64 → Uint8Array (für den binären Core-Schreibpfad `mads_write_file_bytes`). */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
};

/** Datei-Endung aus einem MIME-Typ (Bild-Paste-Namensbildung, §1.2). */
export function extForMime(mime: string): string {
  return EXT_BY_MIME[mime] ?? "png";
}

/**
 * Kleines Anzeige-Thumbnail eines Bildes per Canvas (JPEG). Zweck: das ECHTE Bild in der Timeline
 * zeigen — auf Mac UND Remote —, ohne das Vollbild durch Ringpuffer/Snapshot-Replay/Bridge zu
 * schleusen (ein Screenshot sind schnell mehrere MB; das Thumbnail liegt typisch bei 10–30 KB).
 * Seitenverhältnis bleibt erhalten; kleine Bilder werden NICHT hochskaliert.
 * `undefined` = kein Thumbnail möglich (z. B. SVG/kaputte Datei) → die UI fällt auf den Zähler zurück.
 */
export async function makeThumbnail(blob: Blob, maxPx = 320, quality = 0.7): Promise<{ thumbBase64: string; thumbMediaType: string } | undefined> {
  // Sehr große Quellen NICHT dekodieren: createImageBitmap materialisiert das Vollbild (Breite×Höhe×4
  // Byte) — ein 20-MB-Foto kostet transient hunderte MB und kann die WKWebView abschießen. Lieber
  // kein Thumbnail (die UI fällt auf den Chip zurück) als ein Absturz beim Anhängen.
  if (blob.size > 12 * 1024 * 1024) return undefined;
  try {
    // resizeWidth/-Height: Engines, die das unterstützen, skalieren schon beim Dekodieren herunter
    // und materialisieren das Vollbild nie.
    const bitmap = await createImageBitmap(blob, { resizeWidth: maxPx, resizeHeight: maxPx, resizeQuality: "medium" }).catch(() =>
      createImageBitmap(blob),
    );
    try {
      const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return undefined;
      // JPEG kennt kein Alpha → transparente PNGs/Fenster-Screenshots bekämen sonst einen SCHWARZEN
      // Rahmen. Vorher weiß füllen (passt zum üblichen Dokument-/Screenshot-Hintergrund).
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bitmap, 0, 0, w, h);
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      const b64 = dataUrl.split(",")[1];
      return b64 ? { thumbBase64: b64, thumbMediaType: "image/jpeg" } : undefined;
    } finally {
      bitmap.close();
    }
  } catch {
    return undefined; // nicht dekodierbar → ohne Thumbnail weiter (Anhang selbst bleibt intakt)
  }
}

/**
 * Verzeichnis eines Pfads (alles vor dem letzten `/`). Plattform-neutral auf `/`
 * (Core liefert kanonisierte Posix-Pfade). Leer-Fallback → "." (defensiv).
 */
export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "." : path.slice(0, i);
}
