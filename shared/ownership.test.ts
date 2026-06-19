/**
 * Tests für die Region-Ownership-Trespass-Logik (shared/ownership.ts).
 * Bewusst dependency-frei (throw-basiert), lauffähig via `npm run test:ownership`
 * (esbuild-Bundle + node). Deckt die Kernregel + das reale paix-Beispiel ab
 * (docs/design/06-ownership-and-coordination.md §7, docs/research/_paix-ownership-reference.md).
 */
import { detectTrespass, pathMatches } from "./ownership";
import type { OwnershipRule, ChangedRegion } from "./protocol";

const rules: OwnershipRule[] = [
  { id: "r1", path: "src/paix/mail/pst/**", kind: "exclusive", ownerAgentId: "agent-pst" },
  { id: "r2", path: "src/paix/mail/mail.py", kind: "exclusive", ownerAgentId: "agent-pst", pattern: "_pst|is_pst" },
  { id: "r4", path: "src/paix/mail/mail.py", kind: "shared_seam", ownerAgentId: "agent-postfach", symbols: ["mail_account_view"] },
  { id: "rlf", path: "src/paix/mail/mail_state.py", kind: "land_first" },
];

const results: string[] = [];
let failed = 0;

function check(name: string, cond: boolean): void {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
}
function tres(changes: ChangedRegion[], agent: string) {
  return detectTrespass(changes, rules, agent);
}

// Kernregel + paix-Szenarien
check("postfach edits own mail_account_view = clean",
  tres([{ path: "src/paix/mail/mail.py", symbols: ["mail_account_view"] }], "agent-postfach").length === 0);

const t2 = tres([{ path: "src/paix/mail/mail.py", symbols: ["mail_account_view"] }], "agent-pst");
check("pst edits foreign mail_account_view = trespass owned_symbol", t2.length === 1 && t2[0].reason === "owned_symbol");

check("pst edits own _pst_move_targets = clean",
  tres([{ path: "src/paix/mail/mail.py", symbols: ["_pst_move_targets"] }], "agent-pst").length === 0);

const t4 = tres([{ path: "src/paix/mail/mail.py", symbols: ["_pst_move_targets"] }], "agent-postfach");
check("postfach edits foreign _pst_ pattern = trespass owned_pattern", t4.length === 1 && t4[0].reason === "owned_pattern");

const t5 = tres([{ path: "src/paix/mail/pst/store.py", symbols: ["load"] }], "agent-postfach");
check("postfach edits foreign pst/** = trespass exclusive_file", t5.length === 1 && t5[0].reason === "exclusive_file");

check("same file, different symbols = both clean",
  tres([{ path: "src/paix/mail/mail.py", symbols: ["mail_account_view"] }], "agent-postfach").length === 0 &&
  tres([{ path: "src/paix/mail/mail.py", symbols: ["_pst_scan_results"] }], "agent-pst").length === 0);

const t7 = tres([{ path: "src/paix/mail/mail_state.py", symbols: ["whatever"] }], "agent-pst");
check("land_first always flagged", t7.length === 1 && t7[0].reason === "land_first");

check("glob ** matches nested", pathMatches("src/paix/mail/pst/a/b.py", "src/paix/mail/pst/**"));
check("glob * stays within segment", !pathMatches("src/paix/mail/x/y.py", "src/paix/mail/*.py"));

for (const r of results) console.log(r);
console.log(`\n${results.length - failed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} ownership test(s) failed`);
