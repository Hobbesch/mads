/**
 * Lesbare Fassung eines Clean-Code-Gate-Ergebnisses — EINE Quelle für die Dashboard-Notice (store.ts)
 * und das Feedback, wenn „PR erstellen" am roten Gate scheitert (orchestrator.ts). Zeigt die Summaries
 * der ROTEN Steps, nicht nur `name:status`: ohne die konkrete Ursache riet der Stream-Agent im Vorfall
 * powerblox-gis (2026-09-15), setzte Quotes um den Platzhalter — und aus einem Treffer wurden drei.
 *
 * Secret-Scan-Summaries enthalten nur Art + maskierte Vorschau (shared/secrets.ts). lint/test-
 * Summaries sind dagegen rohe Tool-Ausgabe → hier zusätzlich redactSecrets, damit auch dort nie
 * Klartext durchgeht.
 */
import { redactSecrets } from "./secrets";
import type { GateStep } from "./protocol";

function failedSteps(steps: GateStep[]): Array<{ name: string; detail: string }> {
  return steps
    .filter((s) => s.status === "fail")
    .map((s) => ({ name: s.name, detail: redactSecrets(s.summary?.trim() || "fehlgeschlagen (ohne Details)") }));
}

/** Klartext-Notice: Kopfzeile mit allen Steps, darunter je roter Step seine Summary. */
export function gateNoticeText(ok: boolean, steps: GateStep[]): string {
  const head = `Clean-Code-Gate: ${ok ? "grün" : "rot"} — ${steps.map((s) => `${s.name}:${s.status}`).join(", ")}`;
  return [head, ...failedSteps(steps).map((f) => `✖ ${f.name}: ${f.detail}`)].join("\n");
}

// Markdown-Sonderzeichen entschärfen: maskierte Vorschauen enthalten `***`, Bezeichner `_`.
const escapeMd = (s: string): string => s.replace(/[\\`*_[\]<>~|&]/g, "\\$&");

/** Markdown für den Stream-Verlauf, wenn „PR erstellen" am roten Gate scheitert. */
export function gateBlockedPrMarkdown(steps: GateStep[]): string {
  const lines = failedSteps(steps).map((f) => `- **${escapeMd(f.name)}**: ${escapeMd(f.detail)}`);
  return ["⛔ PR nicht erstellt — Clean-Code-Gate ist rot:", "", ...lines].join("\n");
}
