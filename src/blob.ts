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
 * Verzeichnis eines Pfads (alles vor dem letzten `/`). Plattform-neutral auf `/`
 * (Core liefert kanonisierte Posix-Pfade). Leer-Fallback → "." (defensiv).
 */
export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "." : path.slice(0, i);
}
