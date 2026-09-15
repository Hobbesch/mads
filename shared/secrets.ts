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

// Reine Env-Referenz — der Wert kommt zur Laufzeit aus der Umgebung, im Code steht KEIN Klartext:
// `import.meta.env.X`, `process.env.X`/`[X]`, `os.environ[X]`, `os.environ.get(X)`, `os.getenv(X)`,
// `Deno.env.get(X)`. Argument = Bezeichner oder Name in Quotes/Backticks — bewusst OHNE Default-
// Argument (`os.getenv(X, FALLBACK)` kann Klartext tragen).
const ENV_NAME = "[A-Za-z_]\\w*";
const ENV_ARG = `(?:${ENV_NAME}|"${ENV_NAME}"|'${ENV_NAME}'|\`${ENV_NAME}\`)`;
const ENV_REF =
  `(?:(?:import\\.meta|process)\\.env(?:\\.${ENV_NAME}|\\[${ENV_ARG}\\])` +
  `|os\\.environ(?:\\[${ENV_ARG}\\]|\\.get\\(${ENV_ARG}\\))` +
  `|os\\.getenv\\(${ENV_ARG}\\)` +
  `|Deno\\.env\\.get\\(${ENV_ARG}\\))`;
// Die Ausnahme greift nur, wenn die Referenz der GANZE Wert ist (danach höchstens TS-`!` und `;`/`,`/
// schließende Klammern) UND der Rest der Zeile kein String-Literal enthält — sonst kann ein Klartext-
// Fallback danebenstehen (`process.env.X ?? "…"`) oder angehängt sein (`process.env.X||abc…`).
const PURE_ENV_REF = `${ENV_REF}[!;,)\\]}]*(?:[^\\S\\n][^"'\`\\n]*)?(?:\\n|$)`;

// `assignment`: Treffer beginnt mit dem Schlüsselnamen — der bleibt in der Vorschau sichtbar.
const PATTERNS: Array<{ kind: string; re: RegExp; assignment?: boolean }> = [
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
    assignment: true,
    // Wert in Quotes ≥12 Zeichen — ABER nicht, wenn der GANZE Wert eine reine Variablen-/Template-
    // Referenz ist (`"${VAR}"`, `"${VAR:-x}"`, `"$VAR"`, `"${{ secrets.X }}"`, `"{{ .Values.x }}"`): das ist
    // der idiomatische, SICHERE Weg, Secrets via Env durchzureichen (z. B. `-e PASSWORD="${PASSWORD:-}"`)
    // und enthält KEINEN Klartext. Ein an eine Referenz ANGEHÄNGTER Klartext (`"${X}realsecret"`) wird
    // weiterhin geflaggt; format-spezifische Muster (AWS/GitHub/JWT …) greifen ohnehin unabhängig davor.
    re: /(?:api[_-]?key|secret|passwd|password|token|access[_-]?key|client[_-]?secret|private[_-]?key)\s*[:=]\s*['"](?!(?:\$\{[^'"{}]*\}|\$\w+|\$?\{\{[^'"]*\}\})['"])[^'"]{12,}['"]/i,
  },
  {
    // Unquoted (z. B. .env-Zeile) — eng gefasst: spezifische Schlüsselnamen, Wert ≥20
    // Zeichen, nicht mit $/Quote beginnend → niedrige False-Positive-Rate trotz fail-closed.
    // Analog zur `${VAR}`-Ausnahme oben: eine reine Env-Referenz (PURE_ENV_REF) ist kein Klartext —
    // die CARTO-Konstante in powerblox-gis (Wert per import.meta.env) wurde sonst allein wegen der
    // Länge des Ausdrucks geflaggt (Vorfall powerblox-gis, 2026-09-15). Platzhalter-Werte und `.example`-
    // Dateien sind bewusst NICHT ausgenommen (fail-closed).
    kind: "Secret-Zuweisung (unquoted)",
    assignment: true,
    re: new RegExp(
      `(?:api[_-]?key|secret|passwd|password|access[_-]?key|client[_-]?secret|private[_-]?key)\\s*[:=]\\s*(?!["'$])(?!${PURE_ENV_REF})[^\\s"']{20,}`,
      "i",
    ),
  },
];

/**
 * Maskierte Vorschau: die Zeile NUR bis zum Treffer, ab dort `***`. Der Rest der Zeile fällt bewusst
 * weg — dort kann ein zweites Secret oder ein Klartext-Fallback stehen, den kein Muster erkennt, und
 * die Vorschau geht an UI und Agent. Bei Zuweisungen bleibt der Schlüssel sichtbar (`API_KEY = ***`),
 * damit klar ist, WELCHE Zeile gemeint ist. Der Zeilenanfang läuft zusätzlich durch redactSecrets
 * (ein weiter vorn stehender Treffer eines später geprüften Musters).
 */
function mask(line: string, m: RegExpMatchArray, assignment: boolean): string {
  const at = m.index ?? line.indexOf(m[0]);
  const key = assignment ? (/^[^:=]*[:=]\s*/.exec(m[0])?.[0] ?? "") : "";
  let head = redactSecrets(line.slice(0, at)).trimStart();
  if (head.length > 60) head = "…" + head.slice(-60);
  return `${head}${key}***`.trim();
}

/** Scannt beliebigen Text (mehrzeilig erlaubt) auf bekannte Secret-Muster. */
export function findSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const line of String(text ?? "").split("\n")) {
    for (const p of PATTERNS) {
      const m = line.match(p.re);
      if (m) {
        hits.push({ kind: p.kind, preview: mask(line, m, p.assignment === true) });
        break;
      }
    }
  }
  return hits;
}

/** Kurzfassung für Gate-/Push-Meldungen: Art + maskierte Vorschau, höchstens `max` Einträge. */
export function describeSecretHits(hits: SecretHit[], max = 5): string {
  const shown = hits.slice(0, max).map((h) => `${h.kind} (${h.preview})`);
  if (hits.length > max) shown.push(`… +${hits.length - max} weitere`);
  return shown.join(" · ");
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
