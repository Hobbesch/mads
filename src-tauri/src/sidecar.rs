//! Sidecar-Supervisor: spawnt den Node-Sidecar als Child-Prozess, forwarded dessen
//! stdout/stderr zeilenweise über einen `tauri::ipc::Channel` ans Frontend und
//! schreibt HostMessages auf dessen stdin.
//!
//! Der Rust-Core bleibt bewusst "dünn": er parst das NDJSON-Protokoll NICHT, sondern
//! reicht rohe Zeilen durch. Die Protokoll-Semantik lebt in TS (shared/protocol.ts).
//!
//! Prototyp-Strategie (dev): wir starten `node <repo>/sidecar/dist/index.js` direkt
//! via std::process — das umgeht das @yao-pkg/pkg-Bundling (siehe
//! docs/design/01-architecture.md §9.2, OFFENE FRAGE Sidecar-Bundling) und ist für
//! `npm run tauri dev` der pragmatische Weg. Produktion: externalBin + Hardened Runtime.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::Channel;

#[derive(Default)]
pub struct SidecarState {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
}

/// Channel-Payload Core -> Frontend. Spiegelt shared/protocol.ts `SidecarChannelEvent`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum SidecarChannelEvent {
    /// Eine NDJSON-Zeile vom Sidecar-stdout (zu SidecarMessage zu parsen).
    Line { line: String },
    /// Diagnose-Ausgabe vom Sidecar-stderr.
    Stderr { line: String },
    /// Sidecar-Prozess beendet.
    Exit { code: Option<i32> },
}

fn resolve_sidecar_js() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("MADS_SIDECAR_JS") {
        return Ok(PathBuf::from(p));
    }
    // dev: relativ zum Cargo-Manifest (src-tauri/) -> ../sidecar/dist/index.js
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sidecar/dist/index.js");
    if p.exists() {
        Ok(p)
    } else {
        Err(format!(
            "Sidecar-Script nicht gefunden: {}. Baue es mit `npm --prefix sidecar run build` \
             oder setze die Env-Var MADS_SIDECAR_JS.",
            p.display()
        ))
    }
}

#[tauri::command]
pub fn start_sidecar(
    state: tauri::State<'_, SidecarState>,
    on_event: Channel<SidecarChannelEvent>,
) -> Result<(), String> {
    if state.child.lock().unwrap().is_some() {
        return Ok(()); // läuft bereits
    }

    let node = std::env::var("MADS_NODE").unwrap_or_else(|_| "node".to_string());
    let script = resolve_sidecar_js()?;

    let mut child = Command::new(&node)
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Sidecar-Spawn fehlgeschlagen ({node} {script:?}): {e}"))?;

    let stdout = child.stdout.take().ok_or("kein stdout-Handle")?;
    let stderr = child.stderr.take().ok_or("kein stderr-Handle")?;
    let stdin = child.stdin.take().ok_or("kein stdin-Handle")?;

    // stdout-Reader: NDJSON-Zeilen -> Line-Events; bei EOF -> Exit.
    let ch_out = on_event.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    let _ = ch_out.send(SidecarChannelEvent::Line { line: l });
                }
                Err(_) => break,
            }
        }
        let _ = ch_out.send(SidecarChannelEvent::Exit { code: None });
    });

    // stderr-Reader: Diagnose -> Stderr-Events.
    let ch_err = on_event.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            let _ = ch_err.send(SidecarChannelEvent::Stderr { line });
        }
    });

    *state.stdin.lock().unwrap() = Some(stdin);
    *state.child.lock().unwrap() = Some(child);
    Ok(())
}

/// Schreibt eine HostMessage (bereits als JSON-String) auf den Sidecar-stdin.
#[tauri::command]
pub fn sidecar_send(state: tauri::State<'_, SidecarState>, line: String) -> Result<(), String> {
    let mut guard = state.stdin.lock().unwrap();
    let stdin = guard.as_mut().ok_or("Sidecar läuft nicht")?;
    stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    stdin.write_all(b"\n").map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn stop_sidecar(state: tauri::State<'_, SidecarState>) -> Result<(), String> {
    if let Some(mut child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    *state.stdin.lock().unwrap() = None;
    Ok(())
}
