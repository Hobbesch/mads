import { preMergeGate } from "../shared/merge";
import type { MergeGate } from "../shared/merge";
import type { Collision } from "../shared/collision";
import type { AgentVM } from "./store";

export type BadgeTone = "ok" | "warn" | "err" | "info";
export interface Badge {
  label: string;
  tone: BadgeTone;
}

/** Leitet die git-/PR-Badges eines Agenten ab (Spiegel der gepollten Felder). */
export function agentBadges(a: AgentVM): Badge[] {
  const out: Badge[] = [];
  const merged = a.pr?.state === "MERGED";
  if (a.gate && !merged) out.push({ label: a.gate.ok ? "Gate grün" : "Gate rot", tone: a.gate.ok ? "ok" : "err" });
  if (a.behind > 0 && !merged) out.push({ label: `stale base · ${a.behind} behind`, tone: "warn" });
  if (a.dirty && !merged) out.push({ label: "uncommitted", tone: "info" });
  const pr = a.pr;
  if (pr) {
    if (merged) {
      out.push({ label: `PR #${pr.number} gemerged`, tone: "ok" });
    } else {
      out.push({ label: `PR #${pr.number}`, tone: "info" });
      if (pr.checksState === "FAILURE") out.push({ label: "CI rot", tone: "err" });
      else if (pr.checksState === "PENDING") out.push({ label: "CI läuft", tone: "warn" });
      else if (pr.checksState === "SUCCESS") out.push({ label: "CI grün", tone: "ok" });
      if (pr.mergeable === "CONFLICTING") out.push({ label: "Merge-Konflikt", tone: "err" });
      if (pr.reviewDecision === "REVIEW_REQUIRED") out.push({ label: "Review nötig", tone: "warn" });
      else if (pr.reviewDecision === "CHANGES_REQUESTED") out.push({ label: "Änderungen gefordert", tone: "warn" });
      else if (pr.reviewDecision === "APPROVED") out.push({ label: "approved", tone: "ok" });
    }
  }
  return out;
}

export function hasGitEscalation(a: AgentVM): boolean {
  if (isMergedDone(a)) return false; // wirklich fertig → keine Eskalation; merged-und-weitergelaufen aber schon
  return a.behind > 0 || a.pr?.checksState === "FAILURE" || a.pr?.mergeable === "CONFLICTING";
}

/**
 * Ungesicherte Arbeit: uncommitted/untracked ODER committet-aber-kein-PR. Solche Arbeit
 * geht beim Stop/Aufräumen verloren → auf der Kachel laut markieren und vor Stop bestätigen.
 */
export function unsavedWork(a: AgentVM): boolean {
  if (a.role === "integrator") return a.dirty; // dirty Main-Checkout → in Sub-Stream auslagern
  if (a.role !== "sub") return false;
  // Ungesichert = uncommittet/untracked ODER neue Commits über main, die (noch) KEIN offener PR
  // abdeckt. Ein bereits gemergter ALTER PR (A2: „Mergen & weiterarbeiten" + weitergelaufen)
  // rettet die neuen Commits NICHT — sonst würde Stop/Aufräumen sie ohne Warnung verwerfen.
  return a.dirty || (a.ahead > 0 && a.pr?.state !== "OPEN");
}

/** Grund, warum „Gate" gerade nicht sinnvoll ist (sonst null = erlaubt). */
export function gateDisabledReason(a: AgentVM): string | null {
  return a.dirty ? "Erst committen — das Gate prüft den committeten Stand." : null;
}

/** Grund, warum „Sync" gerade gesperrt ist (sonst null = erlaubt). */
export function syncDisabledReason(a: AgentVM): string | null {
  return a.dirty ? "Erst committen — der Rebase braucht einen sauberen Arbeitsbaum." : null;
}

/** Ist der PR dieses Agenten merge-reif? (Gleiche Logik wie der Sidecar-Gate.) */
export function mergeReadiness(a: AgentVM): MergeGate {
  return preMergeGate(a.pr, a.behind);
}

export type NextStepKind = "commit" | "pr" | "integrate" | "cleanup" | "outsource" | "none";
export interface NextStep {
  kind: NextStepKind;
  label: string;
  disabled: boolean;
  /** Tooltip: was passiert bzw. warum (de)aktiviert. */
  hint: string;
}

/**
 * Der EINE nächste Schritt im Sub-Agent-Workflow — fürs geführte UI:
 * uncommitted → Committen, Commits aber kein PR → PR erstellen, PR offen → Integrieren.
 * Sync läuft automatisch im Hintergrund und ist hier bewusst kein eigener Schritt.
 */
/** Wirklich „erledigt/gemergt": PR ist MERGED UND es gibt keine ungemergte Arbeit mehr —
 *  keine Commits über main (`ahead === 0`) und nichts Uncommittetes. Ein „Mergen &
 *  weiterarbeiten"-Stream läuft nach dem Merge weiter (Branch auf main zurückgesetzt, dann neue
 *  Commits → ahead>0); der alte PR bleibt zwar MERGED, die Kachel MUSS aber aktiv bleiben, sonst
 *  verschwindet sie beim nächsten PR-Poll (der den alten MERGED-Zustand refresht), obwohl es
 *  ungemergte Arbeit gibt. Genutzt vom aktiven Grid (AgentGrid) UND vom geführten nextStep. */
export function isMergedDone(a: AgentVM): boolean {
  // Ein AKTIVER/fortgesetzter Stream (Nutzer hat ihn resumt oder eine Nachricht geschickt → live=true,
  // bleibt es über running/waiting_input hinweg; nur der passive Restore setzt false) ist NIE
  // „erledigt". Sonst rutscht er beim nächsten PR-Poll aus dem aktiven Grid in die zugeklappte
  // „Erledigt"-Sektion — genau der Bug, dass ein Stream nach dem Absenden eines Prompts „verschwindet",
  // obwohl er gerade arbeitet oder auf eine Rückfrage wartet. Nur ein passiver, gemergter Stream ohne
  // offene Arbeit ist wirklich erledigt.
  if (a.live === true) return false;
  return a.pr?.state === "MERGED" && a.ahead === 0 && !a.dirty;
}

export function nextStep(a: AgentVM): NextStep {
  const none: NextStep = { kind: "none", label: "", disabled: true, hint: "" };
  if (a.role === "integrator") {
    // Direkte Edits in main sind nicht vorgesehen (main nur via grünen PR-Merge). Hat der
    // Main-Checkout doch uncommittete Änderungen → in einen neuen Sub-Stream auslagern.
    if (a.dirty)
      return {
        kind: "outsource",
        label: "In Sub-Stream auslagern",
        disabled: false,
        hint: "Deine uncommitteten main-Änderungen in einen neuen Sub-Stream verschieben (main bleibt sauber; normaler Commit→PR→Integrate-Fluss).",
      };
    return none;
  }
  if (a.role !== "sub") return none;
  // NUR wirklich fertige (gemergt + nichts Ungemergtes) → aufräumen. Ein gemergter Stream mit
  // neuen Commits (A2: „Mergen & weiterarbeiten" + weitergelaufen) fällt hier durch und bekommt
  // unten „PR erstellen" für die neue Arbeit — statt fälschlich „Aufräumen".
  if (isMergedDone(a))
    return { kind: "cleanup", label: "Aufräumen ✓", disabled: false, hint: "Stream beenden, Worktree/Branch entfernen (Arbeit ist bereits in main)" };
  if (a.dirty) return { kind: "commit", label: "Committen", disabled: false, hint: "Der Agent committet seine Arbeit (Projektkonvention)" };
  if (a.pr && a.pr.state === "OPEN") {
    const r = mergeReadiness(a);
    // Default = der NICHT-destruktive Merge: nach main mergen, aber Branch + Stream behalten
    // (auf frisches main zurückgesetzt) → man arbeitet direkt weiter. Das endgültige
    // „Integrieren & beenden" (Stream/Worktree/Branch aufräumen) ist die sekundäre Aktion
    // im Inspector — so löscht ein versehentlicher Default-Klick nie einen Stream.
    return {
      kind: "integrate",
      label: "Mergen & weiterarbeiten",
      disabled: !r.ok,
      hint: r.ok
        ? "PR nach main mergen — Branch + Stream bleiben erhalten (auf main zurückgesetzt), du arbeitest direkt weiter"
        : `Noch nicht bereit: ${r.reasons.join(" · ")}`,
    };
  }
  // ahead>0 nach der OPEN-Prüfung: kein OFFENER PR (mehr) für diese Commits → (neuen) PR öffnen.
  // Deckt auch „alter PR gemergt + neue Commits" ab (A2): mads erstellt einen frischen PR.
  if (a.ahead > 0) return { kind: "pr", label: "PR erstellen", disabled: false, hint: "Gate prüfen → auf main syncen → pushen → PR öffnen" };
  return none;
}

// ---------------------------------------------------------------- Integrations-Plan (3.5)
export type IntegrationState = "ready" | "blocked" | "conflicting" | "unsaved" | "needs_pr" | "working";
export interface IntegrationItem {
  id: string;
  label: string;
  state: IntegrationState;
  detail: string;
  prNumber?: number;
}
export interface IntegrationPlan {
  ready: IntegrationItem[]; // merge-bereit, in empfohlener Reihenfolge
  waiting: IntegrationItem[]; // alles, was noch nicht integriert werden kann (mit Grund)
  overlaps: { a: string; b: string; what: string }[]; // sich überschneidende aktive Streams (Region)
}

/**
 * Quer-über-alle-Streams-Übersicht fürs Integrations-Panel: was ist merge-BEREIT (mit
 * empfohlener Reihenfolge), was WARTET (mit Grund) und welche aktiven Streams ÜBERSCHNEIDEN
 * sich (Region) — damit man sie bewusst nacheinander mergt. Reiner Spiegel der Stream-Felder.
 */
export function integrationPlan(agents: AgentVM[], collisions: Collision[]): IntegrationPlan {
  const ready: IntegrationItem[] = [];
  const waiting: IntegrationItem[] = [];
  for (const a of agents) {
    if (a.role !== "sub" || isMergedDone(a) || a.live === false) continue; // merged-und-weitergelaufen bleibt im Plan (kein PR → PR erstellen)
    const base = { id: a.id, label: a.label, prNumber: a.pr?.number };
    if (a.status === "running" || a.status === "starting") {
      waiting.push({ ...base, state: "working", detail: "arbeitet gerade" });
    } else if (a.syncBlocked) {
      waiting.push({ ...base, state: "conflicting", detail: "Sync-Konflikt → Konflikt lösen" });
    } else if (a.dirty) {
      waiting.push({ ...base, state: "unsaved", detail: "ungesicherte Arbeit → committen" });
    } else if (a.pr && a.pr.state === "OPEN") {
      const r = mergeReadiness(a);
      if (r.ok) ready.push({ ...base, state: "ready", detail: "merge-bereit" });
      else waiting.push({ ...base, state: "blocked", detail: r.reasons.join(" · ") });
    } else if (a.ahead > 0) {
      // Kein OFFENER PR (kein PR, oder alter PR gemergt/geschlossen) + neue Commits → (neuen) PR.
      waiting.push({ ...base, state: "needs_pr", detail: "PR erstellen" });
    }
    // sonst (idle, nichts ahead) → nicht gelistet
  }
  const active = new Set([...ready, ...waiting].map((i) => i.id));
  const overlaps = (collisions ?? [])
    .filter((c) => c.severity === "region" && active.has(c.agentIdA) && active.has(c.agentIdB))
    .map((c) => ({ a: c.labelA, b: c.labelB, what: c.symbols?.join(", ") || c.path }));
  return { ready, waiting, overlaps };
}
