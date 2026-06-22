mod files;
mod sidecar;

use files::{
    mads_read_dir, mads_read_file, mads_register_root, mads_write_file, mads_write_file_bytes,
    FsScope,
};
use sidecar::{sidecar_send, start_sidecar, stop_sidecar, SidecarState};
use tauri::menu::{MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::Emitter;

/// Baut das macOS-Menü. „Über mads" öffnet einen eigenen, gestalteten About-Dialog
/// im Frontend (Event `show-about`) statt des starren nativen About-Panels.
fn build_app_menu(app: &tauri::App) -> tauri::Result<()> {
    let about_item = MenuItem::with_id(app, "about", "Über mads", true, None::<&str>)?;

    let app_menu = SubmenuBuilder::new(app, "mads")
        .item(&about_item)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
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
        .setup(|app| {
            build_app_menu(app)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "about" {
                let _ = app.emit("show-about", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_sidecar,
            sidecar_send,
            stop_sidecar,
            mads_read_dir,
            mads_read_file,
            mads_write_file,
            mads_write_file_bytes,
            mads_register_root
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
