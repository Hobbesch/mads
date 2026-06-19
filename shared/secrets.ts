/**
 * Deterministischer Secret-Scan über einen unified git-Diff (P6-Gate).
 * Prüft nur HINZUGEFÜGTE Zeilen. Pur & testbar; gefundene Treffer werden maskiert
 * (der Geheim-Wert wird NIE im Klartext zurückgegeben/geloggt).
 */
export interface SecretHit {
  kind: string;
  preview: string; // maskierte Vorschau der betroffenen Zeile
}

const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: "Private Key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { kind: "AWS Access Key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "GitHub Token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { kind: "Slack Token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "Google API Key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "OpenAI/Anthropic Key", re: /\b(?:sk|sk-ant)-[A-Za-z0-9_-]{20,}\b/ },
  {
    kind: "Secret-Zuweisung",
    re: /(?:api[_-]?key|secret|password|passwd|token|access[_-]?key)\s*[:=]\s*['"][^'"]{12,}['"]/i,
  },
];

function mask(line: string, match: string): string {
  const masked = line.replace(match, "***").trim();
  return masked.length > 80 ? masked.slice(0, 80) + "…" : masked;
}

export function scanSecrets(diff: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const raw of diff.split("\n")) {
    // nur hinzugefügte Zeilen (aber nicht der "+++"-Datei-Header)
    if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
    const line = raw.slice(1);
    for (const p of PATTERNS) {
      const m = line.match(p.re);
      if (m) {
        hits.push({ kind: p.kind, preview: mask(line, m[0]) });
        break;
      }
    }
  }
  return hits;
}
