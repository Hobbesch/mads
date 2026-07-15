/**
 * Tests für die Commit-Hygiene (shared/commit-hygiene.ts). Via `npm run test:hygiene`.
 * Verhindert die Regression, die Rebases blockierte: ein `.venv`(-Symlink) im Autopilot-Commit.
 */
import { isArtifactPath } from "./commit-hygiene";

const results: string[] = [];
let failed = 0;
function check(name: string, cond: boolean): void {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
}

// die Regression: .venv (auch als Symlink/Datei, an jeder Tiefe)
check(".venv (root) ist Artefakt", isArtifactPath(".venv"));
check(".venv tiefer im Baum ist Artefakt", isArtifactPath("sub/pkg/.venv"));
check(".venv/-Inhalt ist Artefakt", isArtifactPath(".venv/bin/python"));
check("node_modules ist Artefakt", isArtifactPath("frontend/node_modules/react/index.js"));
check("__pycache__ ist Artefakt", isArtifactPath("paix/__pycache__/x.cpython-312.pyc"));
check(".pyc-Datei ist Artefakt", isArtifactPath("paix/module.pyc"));
check(".egg-info ist Artefakt", isArtifactPath("src/paix.egg-info/PKG-INFO"));
check(".DS_Store ist Artefakt", isArtifactPath("docs/.DS_Store"));

// KEINE False-Positives auf echten Quellpfaden (konservativ: dist/build/target NICHT gesperrt)
check("normale Quelldatei kein Artefakt", !isArtifactPath("src/paix/catalog.py"));
check("ADR-Datei kein Artefakt", !isArtifactPath("docs/decisions/ADR-0074-x.md"));
check("dist/ NICHT gesperrt (kann Quellordner sein)", !isArtifactPath("dist/index.js"));
check("build/ NICHT gesperrt", !isArtifactPath("build/main.rs"));
check("target/ NICHT gesperrt", !isArtifactPath("target/release/app"));
check("Datei namens venvX kein Artefakt", !isArtifactPath("src/venv_helper.py"));

// eslint-disable-next-line no-console
console.log(results.join("\n"));
if (failed > 0) {
  // eslint-disable-next-line no-console
  console.error(`\n${failed} Hygiene-Test(s) fehlgeschlagen.`);
  process.exit(1);
}
