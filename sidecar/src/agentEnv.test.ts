import { accountAgentEnv, scrubbedAgentEnv } from "./agentEnv.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log("PASS", name);
  } else {
    failed++;
    console.log("FAIL", name);
  }
}

const base: NodeJS.ProcessEnv = {
  PATH: "/usr/bin",
  HOME: "/Users/x",
  ANTHROPIC_API_KEY: "sk-ant-keep",
  CLAUDE_CODE_OAUTH_TOKEN: "oauth-keep",
  GH_TOKEN: "ghp_secret",
  GITHUB_TOKEN: "gho_secret",
  GH_ENTERPRISE_TOKEN: "ghe_secret",
  AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
  AWS_SECRET_ACCESS_KEY: "secret",
  AWS_SESSION_TOKEN: "sess",
  AWS_SECURITY_TOKEN: "sec",
  AWS_REGION: "eu-central-1",
  MY_APP_VAR: "v",
};

const { env, stripped } = scrubbedAgentEnv(base);

check(
  "GitHub-/AWS-Credentials entfernt",
  !("GH_TOKEN" in env) && !("GITHUB_TOKEN" in env) && !("GH_ENTERPRISE_TOKEN" in env) &&
    !("AWS_ACCESS_KEY_ID" in env) && !("AWS_SECRET_ACCESS_KEY" in env) &&
    !("AWS_SESSION_TOKEN" in env) && !("AWS_SECURITY_TOKEN" in env),
);
check(
  "Anthropic-Auth BLEIBT (CLI braucht sie — sonst Auth-Bruch)",
  env.ANTHROPIC_API_KEY === "sk-ant-keep" && env.CLAUDE_CODE_OAUTH_TOKEN === "oauth-keep",
);
check(
  "nicht-geheime Env bleibt (PATH/HOME/AWS_REGION/App-Var)",
  env.PATH === "/usr/bin" && env.HOME === "/Users/x" && env.AWS_REGION === "eu-central-1" && env.MY_APP_VAR === "v",
);
check("stripped listet exakt die 7 entfernten", stripped.length === 7 && stripped.includes("GH_TOKEN") && stripped.includes("AWS_SECRET_ACCESS_KEY"));
check("Original-base wird NICHT mutiert", base.GH_TOKEN === "ghp_secret");
check("fehlende Keys → leere stripped-Liste", scrubbedAgentEnv({ PATH: "/x" }).stripped.length === 0);

// ---- Mehrkonten: CLAUDE_CONFIG_DIR wählt das Konto ------------------------------------------
const DEF = "/Users/x/.claude";
const ALT = "/Users/x/.claude-zweit";

const std = accountAgentEnv(DEF, DEF, base);
// Regressionsschutz: `CLAUDE_CONFIG_DIR=~/.claude` zu SETZEN bricht die Anmeldung des
// Standardkontos ("Not logged in") — Claude Code sucht dann einen abgeleiteten
// Schlüsselbund-Eintrag, den es dafür nicht gibt. Die Variable muss FEHLEN.
check("Standard-Konto: CLAUDE_CONFIG_DIR ist NICHT gesetzt", !("CLAUDE_CONFIG_DIR" in std.env));
check(
  "Standard-Konto: geerbtes CLAUDE_CONFIG_DIR wird entfernt (deterministisch)",
  !("CLAUDE_CONFIG_DIR" in accountAgentEnv(DEF, DEF, { ...base, CLAUDE_CONFIG_DIR: ALT }).env),
);
check(
  "Standard-Konto: Auth-Übersteuerer BLEIBEN (bestehende API-Key-Anmeldung darf nicht brechen)",
  std.env.ANTHROPIC_API_KEY === "sk-ant-keep" && std.env.CLAUDE_CODE_OAUTH_TOKEN === "oauth-keep",
);
check("Standard-Konto: weiterhin genau 7 gestrippt", std.stripped.length === 7);

const alt = accountAgentEnv(ALT, DEF, base);
check("Zweitkonto: CLAUDE_CONFIG_DIR zeigt dorthin", alt.env.CLAUDE_CONFIG_DIR === ALT);
check(
  "Zweitkonto: Auth-Übersteuerer ENTFERNT (sonst wäre die Kontowahl wirkungslos)",
  !("ANTHROPIC_API_KEY" in alt.env) && !("CLAUDE_CODE_OAUTH_TOKEN" in alt.env),
);
check("Zweitkonto: GitHub-/AWS-Scrub gilt weiterhin", !("GH_TOKEN" in alt.env) && !("AWS_SESSION_TOKEN" in alt.env));
check("Zweitkonto: harmlose Env bleibt", alt.env.PATH === "/usr/bin" && alt.env.MY_APP_VAR === "v");
check("Zweitkonto: stripped meldet die Übersteuerer mit", alt.stripped.includes("ANTHROPIC_API_KEY"));
check("Original-base bleibt auch hier unberührt", base.ANTHROPIC_API_KEY === "sk-ant-keep");
check(
  "ANTHROPIC_AUTH_TOKEN wird ebenfalls entfernt",
  !("ANTHROPIC_AUTH_TOKEN" in accountAgentEnv(ALT, DEF, { ...base, ANTHROPIC_AUTH_TOKEN: "t" }).env),
);

// ---- Token-Bindung: CLAUDE_CODE_OAUTH_TOKEN schlaegt die Verzeichnis-Anmeldung --------------
const TOK = "sk-ant-oat01-profil-token";

const altTok = accountAgentEnv(ALT, DEF, base, TOK);
check("Token-Profil: eigener Token wird gesetzt", altTok.env.CLAUDE_CODE_OAUTH_TOKEN === TOK);
check("Token-Profil: CLAUDE_CONFIG_DIR bleibt zusaetzlich gesetzt", altTok.env.CLAUDE_CONFIG_DIR === ALT);
check("Token-Profil: geerbter API-Key ist weg (sonst uebersteuert er den Token)", !("ANTHROPIC_API_KEY" in altTok.env));
check("Token-Profil: tokenApplied meldet die Bindung", altTok.tokenApplied === true);
check(
  "Token-Profil: der ERSETZTE Token wird nicht als entfernt gemeldet",
  !altTok.stripped.includes("CLAUDE_CODE_OAUTH_TOKEN") && altTok.stripped.includes("ANTHROPIC_API_KEY"),
);

// Regressionsschutz fuer den Fall, der den Fehler vom 05.09.2026 ausmachte: ein token-gebundenes
// Profil auf dem STANDARD-Verzeichnis darf nicht still auf die geerbte Anmeldung zurueckfallen.
const stdTok = accountAgentEnv(DEF, DEF, base, TOK);
check("Standard-Verzeichnis + Token: Token gewinnt", stdTok.env.CLAUDE_CODE_OAUTH_TOKEN === TOK);
check("Standard-Verzeichnis + Token: CLAUDE_CONFIG_DIR bleibt ungesetzt", !("CLAUDE_CONFIG_DIR" in stdTok.env));
check("Standard-Verzeichnis + Token: geerbter API-Key ist weg", !("ANTHROPIC_API_KEY" in stdTok.env));

// Ohne Token bleibt das bisherige Verhalten exakt erhalten.
check("ohne Token: tokenApplied ist false", accountAgentEnv(ALT, DEF, base).tokenApplied === false);
check("Original-base bleibt auch mit Token unberuehrt", base.CLAUDE_CODE_OAUTH_TOKEN === "oauth-keep");

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} agentEnv test(s) failed`);
