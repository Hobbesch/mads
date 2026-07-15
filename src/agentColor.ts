/**
 * Deterministische Akzentfarbe je Agent/Branch — damit man Kachel UND Detail-Header
 * auf einen Blick demselben Stream zuordnet (Wunsch: „in welchem Branch/Agent bin ich").
 * Stabil über Renders und App-Neustarts (reiner Hash der Identität, kein State).
 */

// Gut unterscheidbare Farbtöne, funktionieren in Light & Dark (mittlere Sättigung/Helligkeit).
const PALETTE = [
  "#3b82f6", // blau
  "#10b981", // grün
  "#f59e0b", // amber
  "#ef4444", // rot
  "#8b5cf6", // violett
  "#ec4899", // pink
  "#14b8a6", // teal
  "#f97316", // orange
  "#06b6d4", // cyan
  "#a855f7", // purple
  "#84cc16", // lime
  "#e11d48", // rose
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Stabile Farbe für einen Stream. Schlüssel = Branch (falls vorhanden, damit die Farbe
 * dem Branch folgt), sonst die Agent-ID (z. B. Integrator ohne Branch).
 */
export function agentColor(branchOrId: string): string {
  return PALETTE[hash(branchOrId) % PALETTE.length];
}
