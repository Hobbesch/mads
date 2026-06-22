#!/usr/bin/env bash
# Signierter (Developer ID) und — falls Apple-Credentials vorhanden — notarisierter
# + gestapelter macOS-Build von mads.
#
# Lädt die Credentials aus .env.notarize (gitignored) und ruft `tauri build`.
# Tauri notarisiert/stapelt automatisch die .app; das .dmg notarisiert/stapelt
# dieses Skript danach nach (Tauri tut das für das DMG nicht).
#
# Härtung gegen Apples flatterhaften Secure-Timestamp-/Notary-Server:
#   * codesign wird bei transienten Timestamp-/Netzwerk-Fehlern mit Backoff
#     wiederholt ("A timestamp was expected but was not found").
#   * Bricht `tauri build` NUR am DMG-Signieren ab (die .app ist dann bereits
#     signiert+notarisiert+gestapelt), signiert dieses Skript das DMG selbst
#     nach — kein teurer Komplett-Rebuild/Re-Notarisierung der .app.
#   * Andere transiente Signing-Fehler → kompletter Build-Retry.
#   * Definitives ✅/❌-Schlussbanner + echter Exit-Code (auch durch `| tail`
#     sichtbar — nichts wird mehr verschluckt).
#
# Nutzung:
#   npm run release:mac                 # alle macOS-Targets (app + dmg)
#   npm run release:mac -- --bundles app
set -euo pipefail
cd "$(dirname "$0")/.."

LOG="$(mktemp -t mads-tauri-build.XXXXXX)"
trap 'rm -f "$LOG"' EXIT

# Muster für transiente (= wiederholbare) Apple-Server-/Netzwerk-Fehler.
TRANSIENT_RE='timestamp|timed out|service is not available|network|connection reset|connection refused|could not connect|temporar|503|service unavailable|try again'

if [ -f .env.notarize ]; then
  set -a
  # shellcheck disable=SC1091
  source .env.notarize
  set +a
  if [ -n "${APPLE_API_KEY:-}" ] || [ -n "${APPLE_ID:-}" ]; then
    echo "[release] .env.notarize geladen → Build wird signiert UND notarisiert."
  else
    echo "[release] .env.notarize geladen, aber keine Apple-Credentials gesetzt → nur signiert."
  fi
else
  echo "[release] HINWEIS: .env.notarize fehlt → Build wird signiert, aber NICHT notarisiert."
  echo "[release]          Kopiere .env.notarize.example → .env.notarize und trage die Credentials ein."
fi

# Signing-Identity aus tauri.conf.json (Single Source of Truth) — damit das Skript
# das DMG mit exakt derselben Identität nachsigniert, die Tauri verwendet.
SIGN_IDENTITY="$(sed -nE 's/.*"signingIdentity"[[:space:]]*:[[:space:]]*"(.+)".*/\1/p' src-tauri/tauri.conf.json | head -n1)"

# codesign mit Backoff-Retry bei transienten Fehlern. $1 = Ziel, Rest = codesign-Flags.
codesign_retry() {
  local target="$1"; shift
  local attempt=1 max=5 delay=4 out rc
  while :; do
    out="$(codesign "$@" "$target" 2>&1)"; rc=$?
    if [ "$rc" -eq 0 ]; then
      [ "$attempt" -gt 1 ] && echo "[release] codesign ok (Versuch $attempt): $(basename "$target")"
      return 0
    fi
    if [ "$attempt" -lt "$max" ] && printf '%s' "$out" | grep -qiE "$TRANSIENT_RE"; then
      echo "[release] codesign transienter Fehler (Versuch $attempt/$max) — retry in ${delay}s…" >&2
      printf '%s\n' "$out" | sed 's/^/[release]   /' >&2
      sleep "$delay"; attempt=$((attempt + 1)); delay=$((delay * 2))
    else
      echo "[release] codesign endgültig fehlgeschlagen: $(basename "$target")" >&2
      printf '%s\n' "$out" >&2
      return 1
    fi
  done
}

# Ein einzelner `tauri build`-Lauf; teet die Ausgabe nach $LOG, liefert tauris Exit.
run_tauri_build() {
  local rc
  set +e
  if [ "${#TAURI_ARGS[@]}" -gt 0 ]; then
    npm run tauri build -- "${TAURI_ARGS[@]}" 2>&1 | tee "$LOG"
  else
    npm run tauri build 2>&1 | tee "$LOG"
  fi
  rc=${PIPESTATUS[0]}
  set -e
  return "$rc"
}

# Sidecar bauen (tauri build baut nur das Frontend, nicht den Node-Sidecar).
echo "[release] baue Sidecar (esbuild)…"
npm run sidecar:build

TAURI_ARGS=("$@")

# --- Build mit Recovery gegen transiente Signing-Fehler ---
build_attempt=1; build_max=3
while :; do
  if run_tauri_build; then
    break
  fi

  # Fall A: Nur das DMG-Signieren scheiterte transient (die .app ist bereits
  # signiert+notarisiert+gestapelt). DMG selbst nachsignieren — viel günstiger.
  if grep -qiE 'A timestamp was expected|failed codesign application|failed to sign app' "$LOG" \
     && [ -n "$SIGN_IDENTITY" ] \
     && compgen -G "src-tauri/target/release/bundle/dmg/*.dmg" >/dev/null; then
    echo "[release] tauri build brach beim DMG-Signieren ab → signiere DMG selbst nach…"
    recovered=1
    shopt -s nullglob
    for dmg in src-tauri/target/release/bundle/dmg/*.dmg; do
      codesign_retry "$dmg" --force --timestamp --sign "$SIGN_IDENTITY" || recovered=0
    done
    shopt -u nullglob
    [ "$recovered" -eq 1 ] && { echo "[release] DMG-Recovery erfolgreich."; break; }
  fi

  # Fall B: Anderer transienter Fehler → kompletter Build-Retry (cargo cached).
  if [ "$build_attempt" -lt "$build_max" ] && grep -qiE "$TRANSIENT_RE" "$LOG"; then
    echo "[release] tauri build transient fehlgeschlagen (Versuch $build_attempt/$build_max) — kompletter Retry in 8s…" >&2
    sleep 8; build_attempt=$((build_attempt + 1)); continue
  fi

  echo "[release] ❌ tauri build fehlgeschlagen (nicht erholbar). Siehe Log oben." >&2
  exit 1
done

# --- DMG nachträglich notarisieren + stapeln (Tauri notarisiert nur die .app) ---
notarize_args=()
if [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ] && [ -n "${APPLE_API_KEY_PATH:-}" ]; then
  notarize_args=(--key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER")
elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  notarize_args=(--apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID")
fi

# notarytool submit mit Retry bei transientem Submit-Fehler (Netz). Echte Ablehnung
# (status: Invalid) wird NICHT wiederholt — das wäre sinnlos.
notarize_dmg() {
  local dmg="$1" attempt=1 max=3 delay=10 out rc
  while :; do
    out="$(xcrun notarytool submit "$dmg" "${notarize_args[@]}" --wait 2>&1)"; rc=$?
    printf '%s\n' "$out" | grep -iE 'id:|status:|message:' | tail -4
    if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -qi 'status: *Accepted'; then
      return 0
    fi
    if printf '%s' "$out" | grep -qi 'status: *Invalid'; then
      echo "[release] Notarisierung abgelehnt (Invalid) — kein Retry: $(basename "$dmg")" >&2
      return 1
    fi
    if [ "$attempt" -lt "$max" ]; then
      echo "[release] notarytool transient fehlgeschlagen (Versuch $attempt/$max) — retry in ${delay}s…" >&2
      sleep "$delay"; attempt=$((attempt + 1)); delay=$((delay * 2))
    else
      echo "[release] notarytool endgültig fehlgeschlagen: $(basename "$dmg")" >&2
      return 1
    fi
  done
}

if [ "${#notarize_args[@]}" -gt 0 ]; then
  shopt -s nullglob
  for dmg in src-tauri/target/release/bundle/dmg/*.dmg; do
    if xcrun stapler validate "$dmg" >/dev/null 2>&1; then
      echo "[release] DMG bereits gestapelt: $dmg"
    else
      echo "[release] notarisiere + stapele DMG: $dmg"
      notarize_dmg "$dmg"
      xcrun stapler staple "$dmg"
      xcrun stapler validate "$dmg"
    fi
  done
  shopt -u nullglob
fi

# --- Definitives Schlussbanner (überlebt `| tail`) ---
echo ""
shopt -s nullglob
if [ "${#notarize_args[@]}" -gt 0 ]; then
  # Notarisierter Build → Gatekeeper muss jedes Artefakt akzeptieren.
  ok=1
  for art in src-tauri/target/release/bundle/macos/*.app src-tauri/target/release/bundle/dmg/*.dmg; do
    case "$art" in
      *.app) type=execute ;;
      *)     type=install ;;
    esac
    if spctl -a -vvv --type "$type" "$art" >/dev/null 2>&1; then
      echo "[release] ✅ $(basename "$art") — akzeptiert (Notarized Developer ID)"
    else
      echo "[release] ⚠️  $(basename "$art") — Gatekeeper akzeptiert NICHT" >&2
      ok=0
    fi
  done
  shopt -u nullglob
  if [ "$ok" -eq 1 ]; then
    echo "[release] ✅ FERTIG — alle Artefakte signiert, notarisiert & gestapelt."
  else
    echo "[release] ❌ FERTIG MIT WARNUNGEN — mindestens ein Artefakt wurde nicht akzeptiert." >&2
    exit 1
  fi
else
  # Nur-signierter Dev-Build (keine Apple-Credentials) — spctl würde hier ablehnen.
  for art in src-tauri/target/release/bundle/macos/*.app src-tauri/target/release/bundle/dmg/*.dmg; do
    echo "[release] ✅ $(basename "$art") — signiert (nicht notarisiert)"
  done
  shopt -u nullglob
  echo "[release] ✅ FERTIG — signiert (Dev-Build ohne Notarisierung)."
fi
