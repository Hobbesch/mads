/**
 * Deterministischer Secret-Scan. `findSecrets` prüft beliebigen Text (z. B. eine
 * WebFetch-URL oder eine zu pushende Diff-Zeile); `scanSecrets` ist der Diff-Wrapper
 * (nur HINZUGEFÜGTE Zeilen). Pur & testbar; Treffer werden maskiert — der Geheim-Wert
 * wird NIE im Klartext zurückgegeben/geloggt.
 *
 * Wird fail-closed an drei Egress-Punkten genutzt: P6-Gate (gate.ts), Push/Sync
 * (git.ts, LEAK-1) und WebFetch-URL (safe-command.ts, INJ-2). Muster sind bewusst
 * präfix-/format-basiert (geringe False-Positive-Rate), da ein Treffer den Push blockt.
 */
export interface SecretHit {
  kind: string;
  preview: string; // maskierte Vorschau der betroffenen Zeile
}

const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: "Private Key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { kind: "AWS Access Key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ }, // AKIA=long-lived, ASIA=temporary (SEC-3)
  { kind: "GitHub Token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { kind: "GitHub Fine-grained PAT", re: /\bgithub_pat_[0-9A-Za-z_]{20,}\b/ }, // SEC-3
  { kind: "GitLab Token", re: /\bglpat-[0-9A-Za-z_-]{20,}\b/ },
  { kind: "Slack Token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "Slack Webhook", re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_+-]{20,}/ },
  { kind: "Google API Key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "OpenAI/Anthropic Key", re: /\b(?:sk|sk-ant)-[A-Za-z0-9_-]{20,}\b/ },
  { kind: "Stripe Key", re: /\b[rs]k_live_[0-9A-Za-z]{20,}\b/ },
  { kind: "npm Token", re: /\bnpm_[0-9A-Za-z]{36}\b/ },
  { kind: "JWT", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  {
    kind: "Secret-Zuweisung",
    re: /(?:api[_-]?key|secret|passwd|password|token|access[_-]?key|client[_-]?secret|private[_-]?key)\s*[:=]\s*['"][^'"]{12,}['"]/i,
  },
  {
    // Unquoted (z. B. .env-Zeile) — eng gefasst: spezifische Schlüsselnamen, Wert ≥20
    // Zeichen, nicht mit $/Quote beginnend → niedrige False-Positive-Rate trotz fail-closed.
    kind: "Secret-Zuweisung (unquoted)",
    re: /(?:api[_-]?key|secret|passwd|password|access[_-]?key|client[_-]?secret|private[_-]?key)\s*[:=]\s*(?!["'$])[^\s"']{20,}/i,
  },
];

function mask(line: string, match: string): string {
  const masked = line.replace(match, "***").trim();
  return masked.length > 80 ? masked.slice(0, 80) + "…" : masked;
}

/** Scannt beliebigen Text (mehrzeilig erlaubt) auf bekannte Secret-Muster. */
export function findSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const line of String(text ?? "").split("\n")) {
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

/**
 * Ersetzt JEDEN Treffer aller Muster durch einen Platzhalter (SEC-1/SEC-4: nicht nur der erste
 * Treffer, sondern alle). Zum Redigieren von Egress-Text, BEVOR er den Host verlässt (NDJSON-Stream
 * → UI/Bridge/Transcript, Stderr-Log). Kein Klartext-Secret bleibt zurück. Gibt bei keinem Treffer
 * denselben String-Inhalt zurück (identitätsschonend für Aufrufer, die auf Änderung prüfen).
 */
export function redactSecrets(text: string): string {
  const s = String(text ?? "");
  if (!s) return s;
  let out = s;
  for (const p of PATTERNS) {
    const g = new RegExp(p.re.source, p.re.flags.includes("g") ? p.re.flags : p.re.flags + "g");
    out = out.replace(g, () => `«redacted:${p.kind}»`);
  }
  return out;
}

/** Diff-Wrapper: prüft nur hinzugefügte Zeilen (aber nicht den "+++"-Datei-Header). */
export function scanSecrets(diff: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const raw of diff.split("\n")) {
    if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
    hits.push(...findSecrets(raw.slice(1)));
  }
  return hits;
}
