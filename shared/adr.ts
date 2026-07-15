/**
 * ADR-Nummern-Logik (REIN — kein git/fs) — testbar und vom Sidecar genutzt.
 *
 * Zwei sich ergänzende Mechanismen gegen Nummern-Kollisionen über parallele Branches:
 *
 *  1. DRAFT-Convention (opt-in im Zielprojekt): Agenten schreiben `ADR-DRAFT-<slug>.md`
 *     OHNE Nummer; `finalizeAdrDrafts` (git.ts) vergibt die Nummer erst beim PR-Erstellen.
 *
 *  2. Robuster Backstop (UNABHÄNGIG vom Agentenverhalten): hat ein Branch eine bereits
 *     NUMMERIERTE ADR neu hinzugefügt (z.B. weil der Agent selbst eine Nummer geraten hat),
 *     deren Nummer auf der Basis (origin/<default>) schon für eine ANDERE Datei vergeben ist,
 *     wird sie auf die nächste freie Nummer umnummeriert (`planAdrCollisionRenames`).
 *     An den serialisierten Rebase-auf-main-Stellen aufgerufen → deterministisch, kein
 *     wechselseitiges Hochzählen: nach dem ersten Merge trägt main die Nummer, jeder weitere
 *     Branch zieht (seriell) nach und weicht aus.
 *
 * GENERISCH: ohne nummerierte/kollidierende ADR-Dateien ein No-Op (Nicht-ADR-Projekte unberührt).
 */

/** Nummerierte ADR-Datei (KEIN `ADR-DRAFT-…`): erfasst führende Nummer + Slug. */
const ADR_NUMBERED = /^ADR-(\d+)-(.+)\.md$/;

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

/** Führende ADR-Dateinummern aus einer Pfadliste (DRAFT-Dateien zählen nicht mit). */
export function adrNumbersIn(files: string[]): number[] {
  const out: number[] = [];
  for (const f of files) {
    const m = basename(f).match(ADR_NUMBERED);
    if (m) out.push(parseInt(m[1], 10));
  }
  return out;
}

export interface AdrRename {
  /** Pfad wie in `ownFiles` (relativ zum Worktree). */
  from: string;
  /** Zielpfad mit neuer Nummer. */
  to: string;
  /** Slug-qualifizierter Alt-Token für eindeutigen Referenz-Rewrite (`ADR-0074-slug`). */
  oldStem: string;
  /** Slug-qualifizierter Neu-Token (`ADR-0075-slug`). */
  newStem: string;
  /** Alte Nummer als Zahl (für die bare Eigen-Nummer in der Datei selbst). */
  oldNum: number;
  /** Neue Nummer, 4-stellig (`"0075"`). */
  num: string;
}

/**
 * Plant Umnummerierungen für ADRs, die DIESER Branch NEU hinzugefügt hat (Pfad nicht in
 * `baseFiles`) und deren Nummer auf der Basis bereits für eine ANDERE Datei vergeben ist.
 * Geerbte/unveränderte ADRs (gleicher Pfad wie Basis) werden NIE umnummeriert. Reihenfolge
 * deterministisch (Pfad-sortiert), neue Nummern fortlaufend ab max(base, own)+1.
 */
export function planAdrCollisionRenames(baseFiles: string[], ownFiles: string[]): AdrRename[] {
  const baseByNum = new Map<number, Set<string>>();
  for (const f of baseFiles) {
    const m = basename(f).match(ADR_NUMBERED);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    let names = baseByNum.get(n);
    if (!names) baseByNum.set(n, (names = new Set()));
    names.add(basename(f));
  }
  const baseSet = new Set(baseFiles);

  const collisions = ownFiles
    .filter((f) => !baseSet.has(f)) // nur vom Branch hinzugefügte Dateien
    .map((f) => ({ f, m: basename(f).match(ADR_NUMBERED) }))
    .filter((x): x is { f: string; m: RegExpMatchArray } => x.m !== null)
    .filter(({ f, m }) => {
      const names = baseByNum.get(parseInt(m[1], 10));
      return names !== undefined && !names.has(basename(f)); // Nummer auf Basis für ANDERE Datei
    })
    .sort((a, b) => a.f.localeCompare(b.f));

  if (collisions.length === 0) return [];

  let next = Math.max(0, ...adrNumbersIn(baseFiles), ...adrNumbersIn(ownFiles)) + 1;
  const out: AdrRename[] = [];
  for (const { f, m } of collisions) {
    const slug = m[2];
    const num = String(next).padStart(4, "0");
    const dir = f.slice(0, f.length - basename(f).length); // inkl. abschließendem "/" (oder "")
    out.push({
      from: f,
      to: `${dir}ADR-${num}-${slug}.md`,
      oldStem: `ADR-${m[1]}-${slug}`,
      newStem: `ADR-${num}-${slug}`,
      oldNum: parseInt(m[1], 10),
      num,
    });
    next++;
  }
  return out;
}
