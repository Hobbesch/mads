/**
 * Tests für den Secret-Scan (shared/secrets.ts). Via `npm run test:secrets`.
 */
import { scanSecrets, findSecrets, redactSecrets, describeSecretHits } from "./secrets";

const results: string[] = [];
let failed = 0;
function check(name: string, cond: boolean): void {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
}

// nur hinzugefügte Zeilen werden geprüft
check("added private key → hit", scanSecrets("+-----BEGIN PRIVATE KEY-----").length === 1);
check("context/removed lines ignored", scanSecrets("-AKIAIOSFODNN7EXAMPLE\n AKIAIOSFODNN7EXAMPLE").length === 0);
check("+++ header ignored", scanSecrets("+++ b/secrets.txt").length === 0);

check("AWS key → hit", scanSecrets("+const k = 'AKIAIOSFODNN7EXAMPLE'").some((h) => h.kind === "AWS Access Key"));
check("GitHub token → hit", scanSecrets("+token: ghp_abcdefghijklmnopqrstuvwxyz0123456789").some((h) => h.kind === "GitHub Token"));
check("anthropic key → hit", scanSecrets("+ANTHROPIC=sk-ant-abcdefghijklmnopqrstuvwxyz").length === 1);
check(
  "generic secret assignment → hit",
  scanSecrets(`+  password = "hunter2-supersecret"`).some((h) => h.kind === "Secret-Zuweisung"),
);

// ---- erweiterte Muster (LEAK-2) ----
// Token-Präfixe sind ABSICHTLICH per Konkatenation aufgebrochen, damit kein zusammen-
// hängendes Secret-Muster im Quelltext steht (GitHub Push Protection würde sonst diese
// Test-Fixtures als echte Secrets blocken). Zur Laufzeit ergeben sie das volle Muster.
const glpat = "glp" + "at-abcdefghijklmnopqrst";
const stripe = "sk_" + "live_abcdefghijklmnopqrstuvwx";
const npmtok = "npm" + "_abcdefghijklmnopqrstuvwxyz0123456789";
const jwt = "ey" + "JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dummSignaturXYZ";
const ghp = "ghp" + "_abcdefghijklmnopqrstuvwxyz0123456789";
check("GitLab PAT → hit", scanSecrets(`+token = ${glpat}`).some((h) => h.kind === "GitLab Token"));
check("Stripe live key → hit", scanSecrets(`+key=${stripe}`).some((h) => h.kind === "Stripe Key"));
check("npm token → hit", scanSecrets(`+//registry:_authToken=${npmtok}`).some((h) => h.kind === "npm Token"));
check("JWT → hit", scanSecrets(`+auth = ${jwt}`).some((h) => h.kind === "JWT"));
check(
  "unquoted .env secret → hit",
  scanSecrets("+API_KEY=abcdefghijklmnopqrstuvwxyz123456").some((h) => h.kind === "Secret-Zuweisung (unquoted)"),
);
check("env-ref ($VAR) nicht geflaggt", scanSecrets("+API_KEY=$MY_SECRET").length === 0);
// Quoted Env-Durchreichung (Deploy-Skript / docker run -e) ist KEIN Secret — nur eine Variablen-Referenz.
check('quoted env-passthrough ("${VAR}") nicht geflaggt', scanSecrets('+  -e SMTP_PASSWORD="${SMTP_PASSWORD:-}" \\').length === 0);
check('quoted client_secret-ref ("${VAR}") nicht geflaggt', scanSecrets('+  -e GRAPH_CLIENT_SECRET="${GRAPH_CLIENT_SECRET:-}" \\').length === 0);
check('CI-Template-Ref ("${{ secrets.X }}") nicht geflaggt', scanSecrets('+  password: "${{ secrets.SMTP_PW }}"').length === 0);
check('Helm-Template-Ref ("{{ .Values.x }}") nicht geflaggt', scanSecrets('+  password: "{{ .Values.smtpPassword }}"').length === 0);
// ...aber ein echter Klartext-Wert in Quotes wird WEITERHIN geflaggt (keine Aufweichung).
check("echtes quoted Secret weiterhin geflaggt", scanSecrets('+  client_secret = "Abc123RealSecretValue"').some((h) => h.kind === "Secret-Zuweisung"));
// Nur eine REINE Referenz wird ausgenommen — an eine Referenz angehängter Klartext bleibt geflaggt.
check('Referenz + angehängter Klartext WIRD geflaggt', scanSecrets('+  password = "${VAR}realSecretAppended"').some((h) => h.kind === "Secret-Zuweisung"));

// ---- findSecrets (Rohtext, für WebFetch-URL-Scan / INJ-2) ----
check("findSecrets: Token in URL → hit", findSecrets(`https://evil/?t=${ghp}`).length === 1);
check("findSecrets: harmlose URL → kein hit", findSecrets("https://docs.rs/foo/bar").length === 0);

// kein Secret → keine Treffer
check("clean code → no hits", scanSecrets("+const x = add(1, 2)\n+return x").length === 0);
check("short value not flagged", scanSecrets(`+password = "short"`).length === 0);

// Maskierung: der Geheim-Wert darf NICHT im Preview stehen
const masked = scanSecrets("+token: ghp_abcdefghijklmnopqrstuvwxyz0123456789");
check("secret is masked", masked.length === 1 && !masked[0].preview.includes("ghp_abcdefghij"));

// ---- reine Env-Referenzen (Vorfall powerblox-gis, 2026-09-15) ----
// Jeder Wert hier ist ≥20 Zeichen ohne Leerzeichen — ohne die Ausnahme flaggte die unquoted-Regel ihn.
const unquoted = (hits: ReturnType<typeof scanSecrets>) => hits.some((h) => h.kind === "Secret-Zuweisung (unquoted)");
const cartoLine = "const CARTO_API_KEY = import.meta.env.VITE_CARTO_API_KEY as string | undefined;";
check("import.meta.env-Ref nicht geflaggt (CARTO-Zeile)", scanSecrets(`+${cartoLine}`).length === 0);
check("process.env-Ref im Objekt nicht geflaggt", scanSecrets("+  apiKey: process.env.STRIPE_SECRET_KEY,").length === 0);
check("process.env-Ref mit TS-Non-Null nicht geflaggt", scanSecrets("+const API_KEY = process.env.OPENAI_API_KEY_PRIMARY!;").length === 0);
check("process.env[`NAME`] nicht geflaggt", scanSecrets("+const API_KEY = process.env[`OPENAI_API_KEY`];").length === 0);
check("os.environ[NAME] nicht geflaggt", scanSecrets("+API_KEY = os.environ[OPENAI_API_KEY_NAME]").length === 0);
check("os.environ.get(NAME) nicht geflaggt", scanSecrets("+client_secret = os.environ.get(GRAPH_CLIENT_SECRET)").length === 0);
check("os.getenv(NAME) nicht geflaggt", scanSecrets("+DB_PASSWORD = os.getenv(DB_PASSWORD_ENV_NAME)").length === 0);
check("Deno.env.get(`NAME`) nicht geflaggt", scanSecrets("+const API_KEY = Deno.env.get(`MAPBOX_API_KEY`);").length === 0);
check("redactSecrets lässt eine reine Env-Ref stehen", redactSecrets(cartoLine) === cartoLine);
// ...aber nur die REINE Referenz: Klartext daneben oder angehängt bleibt geflaggt (fail-closed).
check("Env-Ref + angehängter Klartext WIRD geflaggt", unquoted(scanSecrets("+API_KEY=process.env.X||abcdefghijklmnopqrstuvwx")));
check("Env-Ref mit Klartext-Fallback in Quotes WIRD geflaggt", unquoted(scanSecrets('+const API_KEY = process.env.OPENAI_API_KEY ?? "Abc123RealSecretValue9";')));
check("os.getenv mit Default-Argument WIRD geflaggt", unquoted(scanSecrets("+DB_PASSWORD = os.getenv(DB_PASSWORD_ENV,FALLBACK_PASSWORD_VALUE)")));
check("env-ähnlicher fremder Ausdruck WIRD geflaggt", unquoted(scanSecrets("+API_KEY=myprocess.env.PRIMARY_KEY_VALUE")));
// Keine Platzhalter-Heuristik und keine .example-Allowlist — das bliebe eine bewusste Entscheidung.
check(".env.example-Platzhalter (unquoted) WIRD geflaggt", unquoted(scanSecrets("+++ b/.env.example\n+VITE_CARTO_API_KEY=your_carto_api_key_here")));
check(
  ".env.example-Platzhalter (quoted) WIRD geflaggt",
  scanSecrets('+++ b/.env.example\n+VITE_CARTO_API_KEY="your-carto-api-key"').some((h) => h.kind === "Secret-Zuweisung"),
);

// ---- Vorschau: ab dem Treffer ist ALLES maskiert (sie geht an UI und Agent) ----
check("Vorschau behält den Schlüssel", scanSecrets("+const CARTO_API_KEY = abcdefghijklmnopqrstuvwxyz1234;")[0]?.preview === "const CARTO_API_KEY = ***");
const fallback = scanSecrets('+const API_KEY = process.env.OPENAI_API_KEY ?? "Abc123RealSecretValue9";');
check("Klartext-Fallback hinter dem Treffer nicht in der Vorschau", fallback.length === 1 && !fallback[0].preview.includes("Abc123RealSecretValue9"));
const twoInLine = scanSecrets(`+AWS=AKIAIOSFODNN7EXAMPLE GH=${ghp}`);
check("zweites Secret in derselben Zeile nicht in der Vorschau", twoInLine.length === 1 && twoInLine[0].preview === "AWS=***");
const earlier = scanSecrets('+password = "hunter2-supersecret" key=AKIAIOSFODNN7EXAMPLE');
check(
  "weiter vorn stehender Treffer eines anderen Musters wird in der Vorschau redigiert",
  earlier.length === 1 && earlier[0].kind === "AWS Access Key" && !earlier[0].preview.includes("hunter2"),
);
const many = Array.from({ length: 7 }, (_, i) => ({ kind: "K", preview: `p${i}` }));
check("describeSecretHits kappt auf max und nennt den Rest", describeSecretHits(many) === "K (p0) · K (p1) · K (p2) · K (p3) · K (p4) · … +2 weitere");

for (const r of results) console.log(r);
console.log(`\n${results.length - failed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} secret-scan test(s) failed`);
