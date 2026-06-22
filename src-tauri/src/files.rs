//! Datei-Explorer-/Editor-Core (docs/design/07-file-explorer.md §4.2/§5).
//!
//! Bewusst dünn: Scope-Policy + `std::fs`, KEINE git-/LLM-Logik. Der Webview ruft
//! NIE direkt an die Platte — aller FS-Zugriff läuft durch diese Commands
//! (CLAUDE.md §Schichten: der Core ist Owner von I/O). Read/Write/Dir-Walk sind
//! mads-eigene Commands (OE-32), damit die Confinement-Policy IM CORE sitzt; der
//! `tauri-plugin-fs`-`watch` (Capability `fs:allow-watch`) ist nur für Live-Reload.

use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use base64::Engine;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};
use tauri_plugin_fs::FsExt;

/// Read-Caps (docs/design/07-file-explorer.md §6, OE-34 — empirisch kalibrierbar).
const TEXT_CAP_BYTES: u64 = 2 * 1024 * 1024; // 2 MB Text
const IMAGE_CAP_BYTES: u64 = 5 * 1024 * 1024; // 5 MB Bild → sonst Binär-Fallback
const DIR_ENTRY_CAP: usize = 2000; // Verzeichnis-Cap

/// Verzeichnisse, die im Baum gar nicht erst gelistet werden (§6).
const SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", ".next"];

/// Laufzeit-Allow-Liste der kanonisierten Roots (repoRoot + Sub-Agent-Worktrees).
/// Der *autoritative* Gate (§5.1) — nicht der literale Capability-Glob.
#[derive(Default)]
pub struct FsScope {
    roots: Mutex<Vec<PathBuf>>,
}

impl FsScope {
    fn add_root(&self, root: PathBuf) {
        let mut roots = self.roots.lock().unwrap();
        if !roots.contains(&root) {
            roots.push(root);
        }
    }
    fn roots(&self) -> Vec<PathBuf> {
        self.roots.lock().unwrap().clone()
    }
}

#[derive(Serialize)]
pub struct DirNode {
    name: String,
    path: String,
    is_dir: bool,
    is_symlink: bool,
}

/// Diskriminiertes Lese-Resultat: DER CORE entscheidet text-vs-binary (§4.2/§7).
/// UTF-8-Decode-Versuch gelingt ⇒ Text; schlägt fehl ⇒ Binär (base64). Der Webview
/// bekommt nie einen rohen Byte-Head zu interpretieren.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum FileRead {
    Text {
        text: String,
        mtime_ms: f64,
        size: u64,
        hash: String,
        truncated: bool,
    },
    Binary {
        bytes_base64: String,
        mtime_ms: f64,
        size: u64,
        hash: String,
        truncated: bool,
    },
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum WriteResult {
    Saved { mtime_ms: f64, size: u64, hash: String },
    Conflict,
}

struct Stat {
    mtime_ms: f64,
    size: u64,
}

fn stat(p: &Path) -> Result<Stat, String> {
    let md = std::fs::metadata(p).map_err(|e| e.to_string())?;
    let mtime_ms = md
        .modified()
        .ok()
        .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);
    Ok(Stat {
        mtime_ms,
        size: md.len(),
    })
}

fn content_hash(p: &Path) -> Result<String, String> {
    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    Ok(hash_bytes(&bytes))
}

fn hash_bytes(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

/// Untrennbares Confinement (§5.1/§5.2). Reihenfolge:
///  1. Deny-Vorrang: `.git`/`.env`/`.env.*`/`.ssh`/`.aws`/`node_modules`/`target`
///     in IRGENDEINER Pfad-Komponente → hart abgelehnt (vor jeder Allow-Prüfung).
///  2. Canonicalize (Symlinks/`.`/`..` aufgelöst) — existiert die Datei noch nicht
///     (Neu-Anlegen im Scope, §7), wird der Parent kanonisiert und der Name angehängt.
///  3. Prefix-Assertion gegen die — ebenfalls kanonisierten — registrierten Roots.
/// Weil beide Seiten kanonisiert werden, entscheidet DIESER Check (nicht der literale
/// Glob) über jeden Symlink-/`..`-Fall.
fn ensure_in_scope(scope: &FsScope, raw: &str) -> Result<PathBuf, String> {
    let requested = Path::new(raw);
    if is_denied(requested) {
        return Err("Zugriff verweigert (geschützter Pfad)".into());
    }

    let canonical = canonicalize_allowing_missing(requested)?;
    // Auch nach canonicalize prüfen (ein Symlink könnte in einen Deny-Pfad zeigen).
    if is_denied(&canonical) {
        return Err("Zugriff verweigert (geschützter Pfad)".into());
    }

    let roots = scope.roots();
    if roots.is_empty() {
        return Err("Kein Root registriert (Projekt/Worktree zuerst wählen)".into());
    }
    let in_scope = roots.iter().any(|root| canonical.starts_with(root));
    if !in_scope {
        return Err("Pfad außerhalb des erlaubten Bereichs".into());
    }
    Ok(canonical)
}

/// Deny-Prüfung über alle Pfad-Komponenten (Vorrang vor Allow).
fn is_denied(p: &Path) -> bool {
    for comp in p.components() {
        if let Component::Normal(os) = comp {
            let name = os.to_string_lossy();
            if name == ".git"
                || name == ".ssh"
                || name == ".aws"
                || name == "node_modules"
                || name == "target"
                || name == ".env"
                || name.starts_with(".env.")
            {
                return true;
            }
        }
    }
    false
}

/// `canonicalize`, das auch noch-nicht-existierende Dateien zulässt (§7 „neu anlegen"):
/// existiert der Pfad → direkt kanonisieren; sonst Parent kanonisieren + Dateiname anhängen.
fn canonicalize_allowing_missing(p: &Path) -> Result<PathBuf, String> {
    if p.exists() {
        return std::fs::canonicalize(p).map_err(|e| e.to_string());
    }
    let parent = p
        .parent()
        .ok_or_else(|| "Ungültiger Pfad".to_string())?;
    let name = p
        .file_name()
        .ok_or_else(|| "Ungültiger Pfad".to_string())?;
    let canon_parent = std::fs::canonicalize(parent).map_err(|e| e.to_string())?;
    Ok(canon_parent.join(name))
}

fn ext_lower(p: &Path) -> String {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default()
}

fn is_image_ext(ext: &str) -> bool {
    matches!(ext, "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico")
}

#[tauri::command]
pub fn mads_read_dir(scope: State<'_, FsScope>, path: String) -> Result<Vec<DirNode>, String> {
    let dir = ensure_in_scope(&scope, &path)?;
    let mut out: Vec<DirNode> = Vec::new();
    let mut count = 0usize;

    let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        // Server-seitiger Ignore-Walk (§6): bekannte Build-/VCS-/Secret-Ordner überspringen.
        if SKIP_DIRS.contains(&name.as_str()) || name == ".env" || name.starts_with(".env.") {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        let is_symlink = file_type.is_symlink();
        let is_dir = if is_symlink {
            // Symlink: nur als Verzeichnis behandeln, wenn das Ziel in-scope ist (§7).
            entry.path().is_dir() && ensure_in_scope(&scope, &entry.path().to_string_lossy()).is_ok()
        } else {
            file_type.is_dir()
        };
        out.push(DirNode {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir,
            is_symlink,
        });

        count += 1;
        if count >= DIR_ENTRY_CAP {
            // Cap anzeigen, nicht verschweigen (§6) — sichtbarer Marker-Knoten + stderr-log.
            eprintln!("[mads:files] dir cap {} reached in {}", DIR_ENTRY_CAP, dir.display());
            out.push(DirNode {
                name: "… weitere ausgeblendet".into(),
                path: format!("{}::__capped__", dir.display()),
                is_dir: false,
                is_symlink: false,
            });
            break;
        }
    }

    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

#[tauri::command]
pub fn mads_read_file(scope: State<'_, FsScope>, path: String) -> Result<FileRead, String> {
    let p = ensure_in_scope(&scope, &path)?;
    let st = stat(&p)?;
    let ext = ext_lower(&p);

    // Bild-Cap (§6): über der Schwelle KEIN Data-URL → Binär-Fallback (Webview-Speicher schützen).
    if is_image_ext(&ext) && st.size > IMAGE_CAP_BYTES {
        return Ok(FileRead::Binary {
            bytes_base64: String::new(),
            mtime_ms: st.mtime_ms,
            size: st.size,
            hash: String::new(),
            truncated: true,
        });
    }

    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    let hash = hash_bytes(&bytes);

    // UTF-8-Versuch entscheidet text-vs-binary IM CORE (§4.2/§7).
    match std::str::from_utf8(&bytes) {
        Ok(text) if !is_image_ext(&ext) => {
            // Text-Cap (§6): sehr große Text-Dateien kürzen, Cap sichtbar machen (truncated).
            let truncated = st.size > TEXT_CAP_BYTES;
            let body = if truncated {
                let cut = TEXT_CAP_BYTES as usize;
                // an gültiger UTF-8-Grenze schneiden
                let mut end = cut.min(text.len());
                while end > 0 && !text.is_char_boundary(end) {
                    end -= 1;
                }
                text[..end].to_string()
            } else {
                text.to_string()
            };
            Ok(FileRead::Text {
                text: body,
                mtime_ms: st.mtime_ms,
                size: st.size,
                hash,
                truncated,
            })
        }
        _ => Ok(FileRead::Binary {
            bytes_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
            mtime_ms: st.mtime_ms,
            size: st.size,
            hash,
            truncated: false,
        }),
    }
}

#[tauri::command]
pub fn mads_write_file(
    scope: State<'_, FsScope>,
    path: String,
    content: String,
    base_mtime_ms: f64,
    base_size: u64,
    base_hash: String,
) -> Result<WriteResult, String> {
    write_file_inner(&scope, &path, &content, base_mtime_ms, base_size, &base_hash)
}

/// Innere Schreib-Logik (free fn, ohne Tauri-`State`) — direkt unit-testbar (§9).
fn write_file_inner(
    scope: &FsScope,
    path: &str,
    content: &str,
    base_mtime_ms: f64,
    base_size: u64,
    base_hash: &str,
) -> Result<WriteResult, String> {
    let p = ensure_in_scope(scope, path)?;

    // Kein silent clobber (§4.2/§7): Datei gilt als „auf Disk geändert", wenn
    // (mtime, size) abweicht ODER der content-hash abweicht (Hash autoritativ).
    // Existiert die Datei nicht (Neu-Anlegen, §7) → kein Conflict, direkt schreiben.
    if p.exists() {
        let cur = stat(&p)?;
        let changed = cur.mtime_ms != base_mtime_ms
            || cur.size != base_size
            || content_hash(&p)? != base_hash;
        if changed {
            return Ok(WriteResult::Conflict);
        }
    }

    std::fs::write(&p, content.as_bytes()).map_err(|e| e.to_string())?;
    let after = stat(&p)?;
    Ok(WriteResult::Saved {
        mtime_ms: after.mtime_ms,
        size: after.size,
        hash: hash_bytes(content.as_bytes()),
    })
}

/// Laufzeit-Scope erweitern, sobald der Mensch ein Projekt/Worktree wählt (§4.2).
/// Ein Sub-Agent-Worktree wird EXAKT wie repoRoot registriert → lesbar UND schreibbar
/// (OE-35). `allow_directory(.., true)` deckt Lesen+Schreiben; der autoritative Gate
/// (`ensure_in_scope`) entscheidet pro Pfad.
#[tauri::command]
pub fn mads_register_root(
    app: AppHandle,
    scope: State<'_, FsScope>,
    path: String,
) -> Result<(), String> {
    let root = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    let _ = app.fs_scope().allow_directory(&root, true); // tauri-plugin-fs FsExt (für watch)
    scope.add_root(root); // mads-eigene Allow-Liste (der eigentliche Gate)
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp_scope(root: &Path) -> FsScope {
        let scope = FsScope::default();
        scope.add_root(std::fs::canonicalize(root).unwrap());
        scope
    }

    #[test]
    fn rejects_out_of_scope() {
        let dir = std::env::temp_dir().join(format!("mads-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let scope = tmp_scope(&dir);
        // Ein Pfad außerhalb des Roots wird abgelehnt.
        let outside = std::env::temp_dir().join("definitely-not-in-scope-xyz.txt");
        assert!(ensure_in_scope(&scope, &outside.to_string_lossy()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_parent_traversal() {
        let dir = std::env::temp_dir().join(format!("mads-trav-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let scope = tmp_scope(&dir);
        let escape = format!("{}/../../etc/passwd", dir.display());
        assert!(ensure_in_scope(&scope, &escape).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn deny_takes_precedence_over_allow() {
        let dir = std::env::temp_dir().join(format!("mads-deny-{}", std::process::id()));
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join(".env"), "SECRET=1").unwrap();
        let scope = tmp_scope(&dir);
        // .git und .env liegen IM Root, sind aber per Deny gesperrt.
        assert!(ensure_in_scope(&scope, &dir.join(".git/config").to_string_lossy()).is_err());
        assert!(ensure_in_scope(&scope, &dir.join(".env").to_string_lossy()).is_err());
        // Eine normale Datei im selben Root ist erlaubt.
        fs::write(dir.join("ok.txt"), "hi").unwrap();
        assert!(ensure_in_scope(&scope, &dir.join("ok.txt").to_string_lossy()).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_conflict_on_hash_drift() {
        let dir = std::env::temp_dir().join(format!("mads-wr-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("doc.md");
        fs::write(&f, "v1").unwrap();
        let scope = tmp_scope(&dir);
        let st = stat(&f).unwrap();
        // Disk ändert sich nach dem „Laden" (gleiche size, anderer Inhalt → Hash-Drift).
        fs::write(&f, "v2").unwrap();
        let res = write_file_inner(
            &scope,
            &f.to_string_lossy(),
            "mine",
            st.mtime_ms,
            st.size,
            &hash_bytes(b"v1"),
        );
        assert!(matches!(res, Ok(WriteResult::Conflict)));
        let _ = fs::remove_dir_all(&dir);
    }
}
