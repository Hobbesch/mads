import type { EffortMode } from "../../shared/protocol";
import { useStore } from "../store";
import { EFFORT_LABEL, EFFORT_HINT, effortLevelsFor, modelLabel } from "../modelCatalog";
import type { ModelInfo } from "../../shared/models";

/**
 * Modell- + Effort-Wähler. Wiederverwendet für den GLOBALEN Default (linke Navigation) und die
 * PRO-STREAM-Umschaltung (Inspector).
 *
 * Die Modell-Liste kommt aus dem geprüften Katalog im Store (`model_catalog`, erhoben beim Start
 * vom Sidecar) — nicht mehr aus einer hartcodierten Liste. Zwei Gruppen:
 *
 *  • „Immer das neuste" — Claude-Code-Aliase (`opus`, `sonnet`, …). Sie lösen bei jedem
 *    Stream-Start selbst auf die neuste Generation auf und veralten deshalb nie.
 *  • „Feste Generationen" — exakte Model-IDs, wenn man bewusst auf einer Generation bleiben will.
 *
 * Der Effort-Regler passt sich dem Modell an: Modelle ohne Effort (Haiku) zeigen keinen Regler,
 * ältere Generationen ohne xhigh nur bis „High".
 */
export function ModelEffortPicker({
  model,
  effort,
  onModel,
  onEffort,
  disabled = false,
  variant,
}: {
  model: string;
  effort?: EffortMode;
  onModel: (m: string) => void;
  onEffort: (e: EffortMode) => void;
  disabled?: boolean;
  /**
   * Layout-Variante. Wird bewusst als `me-<variant>` gesetzt statt einen rohen Klassennamen
   * durchzureichen: „inspector" landete sonst direkt neben `model-effort` und erbte die
   * gleichnamige PANEL-Regel `.inspector` (flex-direction: column + flex: 1 1 0%) — Modell und
   * Effort stapelten sich, der Picker wuchs auf volle Breite und riss den Inspector-Kopf auf.
   */
  variant?: "inspector" | "rail" | "dialog";
}) {
  // Über den Store lesen (nicht über currentCatalog()), damit die Auswahl neu rendert, sobald die
  // Prüfung beim Start durch ist.
  const catalog = useStore((s) => s.modelCatalog);
  const levels = effortLevelsFor(model);
  const effVal = effort && levels.includes(effort) ? effort : levels[levels.length - 1];
  const aliases = catalog.models.filter((m) => m.kind === "alias");
  const exact = catalog.models.filter((m) => m.kind !== "alias");
  // Ein gewähltes Modell, das der Katalog nicht (mehr) führt, bekommt eine eigene Zeile — sonst
  // zeigte das Dropdown stumm den ersten Eintrag und der Stream liefe auf etwas anderem als angezeigt.
  const orphan = catalog.models.some((m) => m.id === model) ? undefined : model;

  return (
    <div className={`model-effort${variant ? ` me-${variant}` : ""}`}>
      <select
        className="me-model"
        value={model}
        disabled={disabled}
        title={`Modell: ${modelLabel(model)}${catalog.note ? `\n${catalog.note}` : ""}`}
        onChange={(e) => onModel(e.target.value)}
      >
        {orphan && (
          <option value={orphan} title="Nicht im geprüften Katalog — bleibt wählbar, solange dieser Stream darauf läuft.">
            {modelLabel(orphan)} (nicht geprüft)
          </option>
        )}
        <optgroup label="Immer das neuste">
          {aliases.map((m) => (
            <option key={m.id} value={m.id} title={m.hint}>
              {m.label}
            </option>
          ))}
        </optgroup>
        <optgroup label="Feste Generationen">
          {exact.map((m) => (
            <option key={m.id} value={m.id} title={tooltip(m)} disabled={m.cliKnown === false}>
              {m.label}
              {m.cliKnown === false ? " — Update nötig" : ""}
            </option>
          ))}
        </optgroup>
      </select>
      {levels.length > 0 ? (
        <select
          className="me-effort"
          value={effVal}
          disabled={disabled}
          title="Reasoning-Effort — wie viel der Agent nachdenkt"
          onChange={(e) => onEffort(e.target.value as EffortMode)}
        >
          {levels.map((lv) => (
            <option key={lv} value={lv} title={EFFORT_HINT[lv]}>
              {EFFORT_LABEL[lv]}
            </option>
          ))}
        </select>
      ) : (
        <span className="me-effort-na" title="Dieses Modell hat keinen Effort-Regler">
          kein Effort
        </span>
      )}
    </div>
  );
}

/** Tooltip inkl. der beiden Befunde aus der Start-Prüfung (Anthropic bzw. lokale CLI). */
function tooltip(m: ModelInfo): string {
  const lines = [m.hint];
  if (m.cliKnown === false) {
    lines.push(
      "Die gebündelte Claude-Code-Version kennt dieses Modell nicht — die API weist es ab. " +
        "Agent-SDK aktualisieren (npm --prefix sidecar install), dann erneut prüfen.",
    );
  }
  if (m.contextWindow) lines.push(`Kontextfenster: ${Math.round(m.contextWindow / 1000)}k Tokens.`);
  return lines.join("\n");
}
