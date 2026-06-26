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
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "about" => {
                let _ = app.emit("show-about", ());
            }
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
