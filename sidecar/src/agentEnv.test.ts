import { scrubbedAgentEnv } from "./agentEnv.js";

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

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} agentEnv test(s) failed`);
