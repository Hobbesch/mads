//! Claude-Anmeldung **pro Konto** (Mehrkonten-Betrieb, docs/account-failover.md).
//!
//! Claude Code trennt Konten über `CLAUDE_CONFIG_DIR`: pro Verzeichnis ein eigener
//! Schlüsselbund-Eintrag. Ein Re-Login ohne diese Variable meldet daher IMMER nur das
//! Standardkonto an — nach einem Kontowechsel lief der „Bei Claude neu anmelden"-Knopf
//! also ins Leere und der Stream blieb auf `authentication_failed` stehen. Beide Kommandos
//! hier wählen deshalb dasselbe Konto, unter dem der Agenten-Prozess wirklich läuft.
//!
//! SICHERHEIT: Das Frontend (und damit auch die Remote-Bridge) übergibt nur eine Profil-**ID**,
//! nie einen Pfad. Das Verzeichnis kommt ausschließlich aus der Registry `~/.mads/accounts.json`
//! und wird vor der Verwendung im AppleScript gegen eine strikte Zeichen-Allowlist geprüft
//! (`shell_safe_path`) — es gibt keinen Weg, aus einer ID ein beliebiges Kommando zu bauen.
//!
//! mads sieht den Token nie: die CLI führt den OAuth-Flow selbst und schreibt in den Keychain.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

/// Auth-Variablen, die den Schlüsselbund-Login übersteuern. Spiegelt `ACCOUNT_OVERRIDE_ENV`
/// in `sidecar/src/agentEnv.ts` — sonst meldete man sich in einem Konto an, unter dem der
/// Agent später gar nicht läuft.
const ACCOUNT_OVERRIDE_ENV: [&str; 3] = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"];

/// Das Konto, für das ein Login/Status gilt — geht ans Frontend zurück, damit die Oberfläche
/// nie ein anderes Konto behaupten kann als das tatsächlich verwendete.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAccountTarget {
    pub id: String,
    pub label: String,
    pub config_dir: String,
    /// true = Claude Codes eigenes Standardverzeichnis; dann darf `CLAUDE_CONFIG_DIR` NICHT
    /// gesetzt werden (siehe `is_default_dir`).
    pub is_default: bool,
    /// Nur informativ, aus `<configDir>/.claude.json` gelesen (nie zum Anmelden benutzt).
    pub email: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAuthStatus {
    pub account: ClaudeAccountTarget,
    /// Roher Text von `claude auth status` (kein Secret — nur der Anmeldezustand).
    pub text: String,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from).filter(|p| !p.as_os_str().is_empty())
}

/// `~` am Anfang auflösen — die Registry darf `~/...` enthalten (wie `expandHome` im Sidecar).
fn expand_home(raw: &str, home: &Path) -> String {
    if raw == "~" {
        return home.to_string_lossy().into_owned();
    }
    match raw.strip_prefix("~/") {
        Some(rest) => home.join(rest).to_string_lossy().into_owned(),
        None => raw.to_string(),
    }
}

/// Claude Codes Standardverzeichnis (= Verhalten ohne gesetztes `CLAUDE_CONFIG_DIR`).
fn default_config_dir(home: &Path) -> String {
    home.join(".claude").to_string_lossy().into_owned()
}

/// Trailing Slashes kappen, damit `~/.claude/` und `~/.claude` dasselbe Konto sind.
fn normalize_dir(dir: &str) -> String {
    let trimmed = dir.trim_end_matches('/');
    if trimmed.is_empty() {
        dir.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Ist das Verzeichnis Claude Codes Standard? Dann muss die Variable **abwesend** sein —
/// `CLAUDE_CONFIG_DIR=~/.claude` zu SETZEN ergibt einen anderen Schlüsselbund-Eintrag und
/// meldet „Not logged in" (verifiziert, docs/account-failover.md §„Falle").
fn is_default_dir(dir: &str, home: &Path) -> bool {
    normalize_dir(dir) == normalize_dir(&default_config_dir(home))
}

/// Strikte Allowlist für einen Pfad, der in ein AppleScript-`do script` interpoliert wird:
/// absolut, keine Quotes/Backslashes/`$`/Backticks/Zeilenumbrüche, kein `..`-Segment. Alles,
/// was hier durchfällt, wird abgelehnt statt escaped — eine Registry-Zeile, die eine
/// Kommando-Grenze enthält, ist ohnehin kaputt.
fn shell_safe_path(p: &str) -> bool {
    !p.is_empty()
        && p.starts_with('/')
        && p.len() <= 1024
        && !p.split('/').any(|seg| seg == "..")
        && p.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '-' | '_' | '+' | '@' | ' '))
}

/// E-Mail des Kontos rein informativ lesen. Fundort unterscheidet sich: bei gesetztem
/// `CLAUDE_CONFIG_DIR` liegt `.claude.json` IM Verzeichnis, im Standardfall DANEBEN.
/// Es wird nichts außer der E-Mail gelesen und nie etwas geschrieben.
fn read_account_email(config_dir: &str) -> Option<String> {
    let candidates = [PathBuf::from(config_dir).join(".claude.json"), PathBuf::from(format!("{config_dir}.json"))];
    for path in candidates {
        let Ok(raw) = std::fs::read_to_string(&path) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else { continue };
        if let Some(mail) = v.get("oauthAccount").and_then(|o| o.get("emailAddress")).and_then(|m| m.as_str()) {
            if !mail.is_empty() {
                return Some(mail.to_string());
            }
        }
    }
    None
}

/// Ein Profil aus der Registry (vor der E-Mail-Anreicherung).
struct Profile {
    id: String,
    label: String,
    config_dir: String,
}

fn default_profile(home: &Path) -> Profile {
    Profile { id: "default".into(), label: "Standard".into(), config_dir: default_config_dir(home) }
}

/// Registry `~/.mads/accounts.json` lesen → (Profile, activeId). Bewusst defensiv, exakt wie
/// `loadAccounts()` im Sidecar: kaputte/fehlende Datei → Standardkonto, nie ein harter Fehler.
fn load_profiles(home: &Path) -> (Vec<Profile>, String) {
    let fallback = || (vec![default_profile(home)], "default".to_string());
    let path = home.join(".mads").join("accounts.json");
    let Ok(raw) = std::fs::read_to_string(&path) else { return fallback() };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else { return fallback() };

    let mut profiles: Vec<Profile> = Vec::new();
    for p in v.get("profiles").and_then(|p| p.as_array()).map(|a| a.as_slice()).unwrap_or(&[]) {
        let id = p.get("id").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
        let dir_raw = p.get("configDir").and_then(|x| x.as_str()).unwrap_or("").trim();
        if id.is_empty() || dir_raw.is_empty() || profiles.iter().any(|e| e.id == id) {
            continue;
        }
        let label = p.get("label").and_then(|x| x.as_str()).map(str::trim).filter(|s| !s.is_empty()).unwrap_or(&id).to_string();
        profiles.push(Profile { id, label, config_dir: expand_home(dir_raw, home) });
    }
    if profiles.is_empty() {
        return fallback();
    }
    let active_raw = v.get("activeId").and_then(|x| x.as_str()).unwrap_or("default");
    let active = if profiles.iter().any(|p| p.id == active_raw) { active_raw.to_string() } else { profiles[0].id.clone() };
    (profiles, active)
}

/// Konto auflösen: explizite ID → aktives Profil → erstes Profil → Standardkonto (nie undefined).
/// Eine unbekannte ID fällt bewusst auf das aktive Konto zurück statt zu scheitern: der Knopf
/// soll auch dann anmelden, wenn die Oberfläche eine veraltete ID mitschickt.
pub fn resolve_account(account_id: Option<&str>) -> Result<ClaudeAccountTarget, String> {
    let home = home_dir().ok_or_else(|| "HOME ist nicht gesetzt — Konto nicht auflösbar.".to_string())?;
    let (profiles, active) = load_profiles(&home);
    let wanted = account_id.map(str::trim).filter(|s| !s.is_empty());
    let p = wanted
        .and_then(|id| profiles.iter().find(|p| p.id == id))
        .or_else(|| profiles.iter().find(|p| p.id == active))
        .unwrap_or(&profiles[0]);
    let config_dir = normalize_dir(&p.config_dir);
    Ok(ClaudeAccountTarget {
        id: p.id.clone(),
        label: p.label.clone(),
        is_default: is_default_dir(&config_dir, &home),
        email: read_account_email(&config_dir),
        config_dir,
    })
}

/// Das Shell-Kommando fürs Terminal. Für das Standardkonto bewusst OHNE `CLAUDE_CONFIG_DIR`
/// (Setzen ≠ Weglassen); für jedes andere Konto zusätzlich die Auth-Übersteuerer entfernen,
/// damit ein gesetzter API-Key den Login nicht ins falsche Konto lenkt.
fn relogin_command(target: &ClaudeAccountTarget) -> Result<String, String> {
    if target.is_default {
        return Ok("claude auth login".into());
    }
    if !shell_safe_path(&target.config_dir) {
        return Err(format!(
            "Config-Verzeichnis des Kontos „{}\" enthält unerwartete Zeichen ({}) — bitte den Pfad in ~/.mads/accounts.json korrigieren.",
            target.label, target.config_dir
        ));
    }
    Ok(format!(
        "unset {}; CLAUDE_CONFIG_DIR='{}' claude auth login",
        ACCOUNT_OVERRIDE_ENV.join(" "),
        target.config_dir
    ))
}

/// Öffnet ein Terminal und startet den interaktiven Claude-OAuth-Login für `account_id`
/// (fehlt sie: aktives Konto). Das erneuert den Keychain-Eintrag GENAU des Kontos, unter dem
/// der Stream läuft — die nächste Agent-Anfrage nutzt ihn automatisch (kein Neustart nötig).
#[tauri::command]
pub fn claude_relogin(account_id: Option<String>) -> Result<ClaudeAccountTarget, String> {
    let target = resolve_account(account_id.as_deref())?;
    #[cfg(target_os = "macos")]
    {
        // Terminal.app, weil der OAuth-Flow ein echtes TTY braucht (Browser öffnen + Code
        // zurück-pasten). Das Kommando ist aus festen Teilen + einem gegen `shell_safe_path`
        // geprüften Pfad gebaut — keine Zeichen, die die AppleScript- oder Shell-Grenze brechen.
        let script = format!("tell application \"Terminal\" to do script \"{}\"", relogin_command(&target)?);
        Command::new("osascript")
            .args(["-e", "tell application \"Terminal\" to activate", "-e", &script])
            .spawn()
            .map_err(|e| format!("Terminal konnte nicht geöffnet werden: {e}"))?;
        Ok(target)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = &target;
        Err("Claude-Re-Login wird derzeit nur unter macOS unterstützt.".into())
    }
}

/// Führt `claude auth status` für `account_id` aus (fehlt sie: aktives Konto) und gibt den
/// reinen Status-Text zurück (KEIN Secret). Login-Shell (`$SHELL -lc`), damit `claude` über den
/// vollen Nutzer-PATH gefunden wird (der GUI-Prozess erbt nur einen minimalen PATH). Das Konto
/// steuert hier die **Prozess-Env**, nicht der Kommando-String — also gar keine Interpolation.
#[tauri::command]
pub fn claude_auth_status(account_id: Option<String>) -> Result<ClaudeAuthStatus, String> {
    let account = resolve_account(account_id.as_deref())?;
    #[cfg(target_os = "macos")]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut cmd = Command::new(shell);
        cmd.args(["-lc", "claude auth status"]);
        if account.is_default {
            cmd.env_remove("CLAUDE_CONFIG_DIR");
        } else {
            cmd.env("CLAUDE_CONFIG_DIR", &account.config_dir);
            for k in ACCOUNT_OVERRIDE_ENV {
                cmd.env_remove(k);
            }
        }
        let out = cmd.output().map_err(|e| format!("Status konnte nicht ermittelt werden: {e}"))?;
        let mut text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if text.is_empty() {
            text = String::from_utf8_lossy(&out.stderr).trim().to_string();
        }
        if text.is_empty() {
            text = "Kein Status-Text von der Claude-CLI erhalten.".to_string();
        }
        Ok(ClaudeAuthStatus { account, text })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = &account;
        Err("Claude-Status wird derzeit nur unter macOS unterstützt.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(dir: &str, is_default: bool) -> ClaudeAccountTarget {
        ClaudeAccountTarget {
            id: "zweit".into(),
            label: "Konto B".into(),
            config_dir: dir.into(),
            is_default,
            email: None,
        }
    }

    #[test]
    fn default_account_gets_no_config_dir() {
        // Setzen ≠ Weglassen: mit CLAUDE_CONFIG_DIR=~/.claude meldet die CLI „Not logged in".
        let cmd = relogin_command(&target("/Users/x/.claude", true)).unwrap();
        assert_eq!(cmd, "claude auth login");
        assert!(!cmd.contains("CLAUDE_CONFIG_DIR"));
    }

    #[test]
    fn second_account_sets_dir_and_drops_overrides() {
        let cmd = relogin_command(&target("/Users/x/.claude-medici", false)).unwrap();
        assert_eq!(
            cmd,
            "unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN; CLAUDE_CONFIG_DIR='/Users/x/.claude-medici' claude auth login"
        );
    }

    #[test]
    fn rejects_paths_that_could_break_out_of_the_command() {
        for bad in [
            "/Users/x/.claude'; rm -rf ~; echo '",
            "/Users/x/$(whoami)",
            "/Users/x/`id`",
            "/Users/x/a\"b",
            "/Users/x/a\\b",
            "/Users/x/a\nb",
            "relativ/.claude",
            "/Users/x/../../etc",
            "",
        ] {
            assert!(!shell_safe_path(bad), "hätte abgelehnt werden müssen: {bad}");
            assert!(relogin_command(&target(bad, false)).is_err(), "Kommando gebaut für: {bad}");
        }
        // Leerzeichen sind in macOS-Pfaden normal und durch die Single-Quotes gedeckt.
        assert!(shell_safe_path("/Users/x/Library/Application Support/.claude-zweit"));
    }

    #[test]
    fn default_dir_detection_ignores_trailing_slash() {
        let home = Path::new("/Users/x");
        assert!(is_default_dir("/Users/x/.claude", home));
        assert!(is_default_dir("/Users/x/.claude/", home));
        assert!(!is_default_dir("/Users/x/.claude-medici", home));
    }

    #[test]
    fn expand_home_resolves_tilde_only_at_the_start() {
        let home = Path::new("/Users/x");
        assert_eq!(expand_home("~/.claude-medici", home), "/Users/x/.claude-medici");
        assert_eq!(expand_home("~", home), "/Users/x");
        assert_eq!(expand_home("/abs/~/dir", home), "/abs/~/dir");
    }
}
