mod bridge;
mod dictation;
mod files;
mod sidecar;

use dictation::{
    dictation_cancel, dictation_start, dictation_stop, whisper_download_model, whisper_model_status,
    DictationState,
};
use files::{
    mads_load_transcript, mads_read_dir, mads_read_file, mads_register_root, mads_save_transcript,
    mads_write_file, mads_write_file_bytes, FsScope,
};
use sidecar::{sidecar_send, start_sidecar, stop_sidecar, SidecarState};
use tauri::menu::{MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::Emitter;

/// Baut das macOS-Menü. „Über mads" öffnet einen eigenen, gestalteten About-Dialog
/// im Frontend (Event `show-about`) statt des starren nativen About-Panels.
fn build_app_menu(app: &tauri::App) -> tauri::Result<()> {
    let about_item = MenuItem::with_id(app, "about", "Über mads", true, None::<&str>)?;
    // Eigener „Beenden"-Punkt statt des Standard-.quit(): der Standard ruft AppKit
    // `terminate:` → libc `exit()` → C++-Static-Destruktoren, und ggml-metal (whisper)
    // bricht dort mit `ggml_abort` ab. Wir beenden stattdessen über graceful_exit (_exit).
    let quit_item = MenuItem::with_id(app, "quit", "mads beenden", true, Some("CmdOrCtrl+Q"))?;
    // Zweite mads-Instanz öffnen (eigener Prozess + eigener Sidecar) → in einem anderen Projekt
    // arbeiten, ohne dass sich die beiden Umgebungen ins Gehege kommen (Projekt-Lock schützt).
    let new_instance_item = MenuItem::with_id(app, "new_instance", "Neue Instanz", true, Some("CmdOrCtrl+Shift+N"))?;

    let app_menu = SubmenuBuilder::new(app, "mads")
        .item(&about_item)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&quit_item)
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "Ablage").item(&new_instance_item).build()?;

    let edit_menu = SubmenuBuilder::new(app, "Bearbeiten")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Fenster")
        .minimize()
        .separator()
        .close_window()
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&window_menu)
        .build()?;

    app.set_menu(menu)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init()) // doc 07 §4.2 — für watch + Plugin-Scope
        .manage(SidecarState::default())
        .manage(FsScope::default()) // doc 07 §4.2 — Laufzeit-Allow-Liste
        .manage(DictationState::default()) // Spracheingabe (Whisper)
        .setup(|app| {
            build_app_menu(app)?;
            start_remote_bridge(app);
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "about" => {
                let _ = app.emit("show-about", ());
            }
            "new_instance" => open_new_instance(),
            "quit" => graceful_exit(app),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            start_sidecar,
            sidecar_send,
            stop_sidecar,
            mads_read_dir,
            mads_read_file,
            mads_write_file,
            mads_write_file_bytes,
            mads_register_root,
            mads_save_transcript,
            mads_load_transcript,
            whisper_model_status,
            whisper_download_model,
            dictation_start,
            dictation_stop,
            dictation_cancel
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Jeder reguläre Exit-Pfad (Dock-Beenden, letztes Fenster zu …) wird abgefangen
            // und über graceful_exit beendet — sonst crasht der ggml-metal-Teardown.
            if let tauri::RunEvent::Exit = event {
                graceful_exit(app_handle);
            }
        });
}

/// Remote-Bridge (docs/design/remote-companion-app.md) auf einem EIGENEN Thread mit eigener
/// tokio-Runtime starten — entkoppelt vom Tauri-Runtime, garantiert den IO-Reactor für den
/// WSS-Server. Gegated hinter `MADS_REMOTE_BRIDGE=1`: Stand P0.2 ist noch AUTH-LOS (Pairing kommt
/// in P1.2), darf also nicht versehentlich laufen. Der stdout-Tee ist immer aktiv, aber ohne
/// laufende Bridge ohne Empfänger (kein Overhead).
fn start_remote_bridge(app: &tauri::App) {
    use tauri::Manager;
    if std::env::var("MADS_REMOTE_BRIDGE").as_deref() != Ok("1") {
        return;
    }
    let tee = app.state::<SidecarState>().tee();
    // Command-Forward-Senke: eine validierte HostMessage roh auf den Sidecar-stdin schreiben.
    // Kapselt SidecarState::send_line über einen (Send+Sync) AppHandle, damit bridge.rs
    // Tauri-frei und testbar bleibt.
    let app_handle = app.handle().clone();
    let forward: bridge::CommandSink = std::sync::Arc::new(move |line: &str| {
        app_handle.state::<SidecarState>().send_line(line)
    });
    let cert_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("mads")
        .join("remote-bridge");

    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
            Ok(rt) => rt,
            Err(e) => {
                eprintln!("[mads:bridge] Runtime-Build fehlgeschlagen: {e}");
                return;
            }
        };
        rt.block_on(async move {
            match bridge::start(tee, forward, cert_dir, "mads".to_string()).await {
                Ok(b) => {
                    eprintln!("[mads:bridge] läuft auf Port {} (SPKI-fp {})", b.port, b.spki_fp_hex);
                    let _keep = b; // Handle im Scope halten → Accept-Task + mDNS bleiben aktiv
                    futures_util::future::pending::<()>().await; // Thread/Runtime am Leben halten
                }
                Err(e) => eprintln!("[mads:bridge] Start fehlgeschlagen: {e}"),
            }
        });
    });
}

/// Startet eine ZWEITE mads-Instanz (eigener Prozess → eigener Sidecar) via `open -n`, damit man
/// in einem zweiten Fenster an einem ANDEREN Projekt arbeiten kann. macOS bietet kein natives
/// „Rechtsklick auf die App → neue Instanz"; dies ist das Äquivalent (auch als Ablage → Neue Instanz
/// / Cmd+Shift+N). Nur aus dem installierten .app-Bundle sinnvoll — im Dev-Build ein No-Op.
fn open_new_instance() {
    if let Ok(exe) = std::env::current_exe() {
        // exe = …/mads.app/Contents/MacOS/mads → das .app-Bundle liegt 3 Ebenen höher.
        if let Some(bundle) = exe.ancestors().nth(3) {
            if bundle.extension().and_then(|s| s.to_str()) == Some("app") {
                let _ = std::process::Command::new("open").arg("-n").arg(bundle).spawn();
            }
        }
    }
}

/// Sauberer, harter Prozess-Exit: erst den Sidecar-Child beenden (sonst verwaist er),
/// dann via `_exit()` raus — das UMGEHT die C++-Static-Destruktoren (`__cxa_finalize`).
/// Nötig, weil ggml-metal (whisper) in seinem Device-Destructor `ggml_abort` aufruft und
/// die App sonst beim Beenden mit „unerwartet beendet" (SIGABRT) abstürzt.
fn graceful_exit(app: &tauri::AppHandle) -> ! {
    use tauri::Manager;
    if let Some(state) = app.try_state::<SidecarState>() {
        state.kill_child();
    }
    unsafe { libc::_exit(0) }
}
