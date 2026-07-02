import type { EffortMode } from "../../shared/protocol";
import { MODELS, EFFORT_LABEL, EFFORT_HINT, effortLevelsFor, modelLabel } from "../modelCatalog";

/**
 * Modell- + Effort-Wähler. Wiederverwendet für den GLOBALEN Default (linke Navigation) und die
 * PRO-STREAM-Umschaltung (Inspector). Der Effort-Regler passt sich dem Modell an: Modelle ohne
 * Effort (Haiku) zeigen keinen Regler; Sonnet 4.6 nur bis „High"; Fable 5 / Opus 4.8 / Sonnet 5
 * bis „Ultracode" (= xhigh + Workflow-Orchestrierung).
 */
export function ModelEffortPicker({
  model,
  effort,
  onModel,
  onEffort,
  disabled = false,
  className = "",
}: {
  model: string;
  effort?: EffortMode;
  onModel: (m: string) => void;
  onEffort: (e: EffortMode) => void;
  disabled?: boolean;
  className?: string;
}) {
  const levels = effortLevelsFor(model);
  const effVal = effort && levels.includes(effort) ? effort : levels[levels.length - 1];
  return (
    <div className={`model-effort ${className}`}>
      <select
        className="me-model"
        value={model}
        disabled={disabled}
        title={`Modell: ${modelLabel(model)}`}
        onChange={(e) => onModel(e.target.value)}
      >
        {MODELS.map((m) => (
          <option key={m.id} value={m.id} title={m.hint}>
            {m.label}
          </option>
        ))}
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
