/**
 * Laufzeit-Kollisionsschutz zwischen parallelen Sub-Agenten (pur & testbar).
 *
 * Kernidee: jeden aktiven Agenten-Diff in geänderte Regionen (Datei + umgebende
 * Symbole) zerlegen und paarweise auf Überlapp prüfen. Gleiche Datei + VERSCHIEDENE
 * Symbole = KEINE Kollision (genau der paix-`mail.py`-Fall: postfach ⟷ pst-test).
 * Gleiche Datei + gemeinsames Symbol = echte Kollision; gleiche Datei ohne Symbol-
 * Info = konservative Warnung.
 *
 * Siehe docs/design/06-ownership-and-coordination.md.
 */
import type { ChangedRegion } from "./protocol";

/** Parst einen `git diff --unified=0` in geänderte Regionen je Datei. */
export function parseDiffRegions(diff: string): ChangedRegion[] {
  const byFile = new Map<string, Set<string>>();
  let current: string | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).replace(/^b\//, "").trim();
      current = p === "/dev/null" ? undefined : p;
      if (current && !byFile.has(current)) byFile.set(current, new Set());
    } else if (line.startsWith("@@") && current) {
      const ctx = line.replace(/^@@.*?@@/, "").trim(); // Funktions-Kontext nach dem 2. @@
      const sym = extractSymbol(ctx);
      if (sym) byFile.get(current)!.add(sym);
    }
  }
  return [...byFile.entries()].map(([path, syms]) => ({ path, symbols: [...syms] }));
}

/**
 * Kontexte, die KEINE Symbol-Granularität tragen, weil sie die ganze Datei umspannen.
 *
 * WARUM diese Liste existiert (Vorfall 2026-08-28, Boba): `git diff --unified=0` liefert als
 * Hunk-Kontext die letzte Zeile, die seine Heuristik für einen Funktionskopf hält. Ohne
 * konfigurierten Diff-Driver ist das bei C# durchgehend `namespace X` — bei JEDEM Hunk JEDER
 * Datei dieses Namespace. Der `slice(0, 40)`-Fallback machte daraus ein Pseudo-Symbol, das
 * zwischen zwei Streams zwangsläufig identisch war: die Schnittmenge war nie leer, also meldete
 * `detectCollisions` `severity: "region"` (harte Kollision) für Hunks, die in Wahrheit hunderte
 * Zeilen auseinanderlagen. Drei Streams wurden so mit `ownership_trespass` blockiert, obwohl git
 * exakt zwei triviale Konflikte hatte.
 *
 * Solche Kontexte liefern daher `undefined` → `detectCollisions` fällt auf `severity: "file"`
 * zurück (konservative Warnung „gleiche Datei, Symbole unklar") statt eine Kollision zu behaupten,
 * die es nicht gibt. Die eigentliche Abhilfe sind die Diff-Driver (siehe `sidecar/src/gitAttributes.ts`);
 * dieser Filter ist die zweite Verteidigungslinie für Sprachen ohne Driver.
 */
const CONTAINER_CONTEXT = /^\s*(?:namespace|using|import|package|from|module|#include|#import)\b/;

function extractSymbol(ctx: string): string | undefined {
  if (!ctx) return undefined;
  const m =
    ctx.match(/(?:def|fn|function|class|interface|struct|impl|const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)/) ??
    ctx.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  if (m) return m[1];
  // Kein erkanntes Symbol: der Roh-Kontext ist nur dann ein brauchbarer Anker, wenn er nicht
  // ohnehin die ganze Datei umspannt.
  return CONTAINER_CONTEXT.test(ctx) ? undefined : ctx.slice(0, 40);
}

export interface AgentRegions {
  agentId: string;
  label: string;
  regions: ChangedRegion[];
}

export interface Collision {
  agentIdA: string;
  agentIdB: string;
  labelA: string;
  labelB: string;
  path: string;
  symbols?: string[]; // bei severity "region": die gemeinsamen Symbole
  severity: "region" | "file"; // region = gleiches Symbol; file = gleiche Datei, Symbole unklar
}

export function detectCollisions(agents: AgentRegions[]): Collision[] {
  const out: Collision[] = [];
  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      const A = agents[i];
      const B = agents[j];
      const mapB = new Map(B.regions.map((r) => [r.path, r.symbols]));
      for (const ra of A.regions) {
        const sb = mapB.get(ra.path);
        if (!sb) continue; // andere berührt diese Datei nicht
        const sa = ra.symbols;
        if (sa.length && sb.length) {
          const inter = sa.filter((s) => sb.includes(s));
          if (inter.length) {
            out.push({ agentIdA: A.agentId, agentIdB: B.agentId, labelA: A.label, labelB: B.label, path: ra.path, symbols: inter, severity: "region" });
          }
          // gleiche Datei, disjunkte Symbole → erlaubt, keine Warnung
        } else {
          out.push({ agentIdA: A.agentId, agentIdB: B.agentId, labelA: A.label, labelB: B.label, path: ra.path, severity: "file" });
        }
      }
    }
  }
  return out;
}
