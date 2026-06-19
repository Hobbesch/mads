mod sidecar;

use sidecar::{sidecar_send, start_sidecar, stop_sidecar, SidecarState};
use tauri::menu::{AboutMetadataBuilder, MenuBuilder, SubmenuBuilder};

/// Wird im macOS-About-Panel als „credits" gezeigt (das einzige längere Textfeld,
/// das macOS im About unterstützt — comments/authors/website sind dort ohne Wirkung).
const ABOUT_CREDITS: &str = "mads — multi-agent development surface\n\
\n\
Eine native macOS-App, um parallel mit vielen Claude-Code-Agenten zu entwickeln: \
ein Main-Agent (Integrator) plus Sub-Agents, jeder in eigenem git-Worktree und Branch, \
mit voller GitHub-Nutzung — mit Live-Status, Rückfrage-/Eskalations-Übersicht und \
Terminal-Ausgabe pro Agent.\n\
\n\
Invarianten: nur der Integrator merged nach main · main bleibt immer lauffähig · \
Sub-Agents mergen nie selbst.\n\
\n\
Tauri 2 · React · Claude Agent SDK\n\
https://github.com/Hobbesch/mads";

/// Baut das macOS-Menü (App-Menü mit „Über mads" + Standard-Items, Bearbeiten, Fenster).
fn build_app_menu(app: &tauri::App) -> tauri::Result<()> {
    let about = AboutMetadataBuilder::new()
        .name(Some("mads"))
        .version(Some(env!("CARGO_PKG_VERSION")))
        .copyright(Some("© 2026 Alessandro Medici · MIT-Lizenz"))
        .authors(Some(vec!["Hobbesch".to_string()]))
        .comments(Some(
            "Multi-agent development surface — viele Claude-Code-Agenten parallel.",
        ))
        .license(Some("MIT"))
        .website(Some("https://github.com/Hobbesch/mads"))
        .website_label(Some("github.com/Hobbesch/mads"))
        .credits(Some(ABOUT_CREDITS))
        .build();

    let app_menu = SubmenuBuilder::new(app, "mads")
        .about(Some(about))
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
        .manage(SidecarState::default())
        .setup(|app| {
            build_app_menu(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_sidecar,
            sidecar_send,
            stop_sidecar
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
