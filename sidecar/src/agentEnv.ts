/**
 * Env-Scrub für den Agenten-Tool-Prozess (User-Entscheidung 2026-07-09: „implement + live-test").
 *
 * Der Bash-Tool-Prozess eines Agenten läuft INNERHALB der Claude-Code-CLI, die die Agent-SDK als
 * Subprozess startet. Dessen Env = das, was wir der SDK als `options.env` geben (die SDK MERGT nicht,
 * sie ERSETZT — daher spreaden wir `process.env` und entfernen nur die Geheimnisse). Ohne Scrub
 * könnte ein prompt-injizierter Agent `echo $GH_TOKEN` / `echo $AWS_SECRET_ACCESS_KEY` ausführen und
 * die Tokens exfiltrieren (der Klassifizierer in safe-command.ts ist nur UX, keine harte Grenze).
 *
 * GESTRIPPT werden NUR Credentials, die die CLI für SICH NICHT braucht: GitHub- und AWS-Tokens.
 * mads' EIGENE git/gh-Operationen laufen als separate Sidecar-Subprozesse (git.ts) mit der vollen
 * Sidecar-Env — die sind unberührt und behalten GH_TOKEN.
 *
 * BEWUSSTE GRENZE (nicht hier lösbar): die Anthropic-Auth selbst — `ANTHROPIC_API_KEY` bzw.
 * `CLAUDE_CODE_OAUTH_TOKEN` — lässt sich auf dieser Ebene NICHT vor dem Bash-Tool verstecken: die CLI
 * BRAUCHT sie, und der Bash-Subprozess erbt genau diese CLI-Env. Sie hier zu strippen bräche die
 * Agent-Authentifizierung. Das erfordert `apiKeyHelper` (Key out-of-band) oder eine OS-Sandbox, die
 * die Env für Tool-Subprozesse getrennt kontrolliert — aufgeschobene Strukturarbeit.
 */

/** Credential-Env-Namen, die der Agenten-Tool-Prozess NICHT sehen soll (CLI braucht sie nicht). */
export const AGENT_STRIPPED_ENV: readonly string[] = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
];

/**
 * Kopie von `base` (Default: `process.env`) OHNE die AGENT_STRIPPED_ENV-Schlüssel. Gibt zusätzlich
 * die tatsächlich entfernten Namen zurück (für ein transparentes Log beim Agent-Start).
 */
export function scrubbedAgentEnv(base: NodeJS.ProcessEnv = process.env): {
  env: Record<string, string | undefined>;
  stripped: string[];
} {
  const env: Record<string, string | undefined> = { ...base };
  const stripped: string[] = [];
  for (const k of AGENT_STRIPPED_ENV) {
    if (env[k] !== undefined) {
      delete env[k];
      stripped.push(k);
    }
  }
  return { env, stripped };
}

/**
 * Auth-Variablen, die eine ANGEMELDETE Sitzung übersteuern. Sie haben in Claude Code Vorrang vor
 * dem Schlüsselbund-Login — stünden sie noch in der Env, liefe der Agent trotz gesetztem
 * `CLAUDE_CONFIG_DIR` weiter auf dem übersteuernden Zugang und die Kontowahl wäre wirkungslos.
 */
export const ACCOUNT_OVERRIDE_ENV: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
];

/**
 * Env für einen Agenten-Prozess unter einem BESTIMMTEN Claude-Konto.
 *
 * ZWEI Bindungswege, absichtlich in dieser Rangfolge:
 *
 * 1. **`token`** (aus `claude setup-token`, gelesen aus dem Schlüsselbund) — die belastbare
 *    Bindung. Sie hängt an nichts ausser sich selbst.
 * 2. **`configDir`** — die Verzeichnis-Anmeldung. Sie trennt die Konten zwar wirklich (ein
 *    frisches Verzeichnis ist „Not logged in"), aber WELCHES Konto darin landet, entscheidet beim
 *    `claude auth login` die BROWSER-Sitzung — nicht `--email`. Genau daran liefen am 05.09.2026
 *    beide mads-Profile still auf dasselbe Konto.
 *
 * Auth-Übersteuerer aus der geerbten Env werden entfernt, sobald ein Konto bewusst gewählt ist
 * (eigener `configDir` ODER eigener Token). Nur im reinen Standardfall ohne Token bleiben sie
 * stehen — wer mads ohne Konto-Umschaltung nutzt und sich per `ANTHROPIC_API_KEY` anmeldet, soll
 * genau so weiterlaufen wie bisher.
 */
export function accountAgentEnv(
  configDir: string,
  defaultConfigDir: string,
  base: NodeJS.ProcessEnv = process.env,
  token?: string,
): { env: Record<string, string | undefined>; stripped: string[]; tokenApplied: boolean } {
  const { env, stripped } = scrubbedAgentEnv(base);
  const isDefaultDir = configDir === defaultConfigDir;

  if (isDefaultDir) {
    // WICHTIG: Für das Standardverzeichnis die Variable ENTFERNEN, nicht auf `~/.claude` setzen.
    // Claude Code leitet den Schlüsselbund-Eintrag unterschiedlich ab, je nachdem ob
    // CLAUDE_CONFIG_DIR GESETZT ist — mit `=~/.claude` sucht es einen abgeleiteten Eintrag, der für
    // das Standardkonto gar nicht existiert, und meldet „Not logged in". Verifiziert:
    //   ohne Variable          → loggedIn: true
    //   CLAUDE_CONFIG_DIR=~/.claude → loggedIn: false   ← genau dieser Fehler
    //   CLAUDE_CONFIG_DIR=~/.claude-medici → loggedIn: true
    // Löschen (statt nur nicht setzen) macht das Verhalten auch dann deterministisch, wenn der
    // Sidecar-Prozess die Variable selbst geerbt hat.
    delete env.CLAUDE_CONFIG_DIR;
  } else {
    env.CLAUDE_CONFIG_DIR = configDir;
  }

  if (!isDefaultDir || token) {
    for (const k of ACCOUNT_OVERRIDE_ENV) {
      if (env[k] !== undefined) {
        delete env[k];
        // Einen geerbten Token, den wir gleich durch den EIGENEN ersetzen, nicht als „entfernt"
        // melden — das Log soll die Kontowahl beschreiben, nicht einen Scheinverlust.
        if (!(token && k === "CLAUDE_CODE_OAUTH_TOKEN")) stripped.push(k);
      }
    }
  }

  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return { env, stripped, tokenApplied: !!token };
}
