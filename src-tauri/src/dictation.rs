//! Spracheingabe (Diktat) — lokal, ohne Netz nach dem Modell-Download.
//!
//! Aufnahme via **cpal** (CoreAudio) auf einem EIGENEN Thread, weil der macOS-Stream
//! `!Send` ist und daher nicht im Tauri-State liegen darf: der Thread baut den Stream,
//! nimmt auf und legt ihn beim Stop-Signal (mpsc) wieder ab. Transkription via
//! **whisper-rs** (whisper.cpp, Metal-GPU). Modell-Download via `curl` (kein HTTP-Crate).
//!
//! Kommandos: whisper_model_status, whisper_download_model, dictation_start,
//! dictation_stop, dictation_cancel. Auto-Sprache (multilingual, large-v3-turbo).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

const MODEL_FILE: &str = "ggml-large-v3-turbo.bin";
const MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin";
const MODEL_TOTAL_BYTES: u64 = 1_624_555_275; // ~1,62 GB (f16)
const TARGET_RATE: u32 = 16_000;

/// Laufzeit-Zustand des Diktats. Der cpal-Stream selbst lebt NUR auf dem Aufnahme-Thread.
#[derive(Default)]
pub struct DictationState {
    samples: Arc<Mutex<Vec<f32>>>,                       // gesammelte Mono-Samples
    active: Mutex<Option<(Sender<()>, JoinHandle<()>)>>, // Stop-Signal + Thread der laufenden Aufnahme
    input_rate: Mutex<u32>,                              // Sample-Rate des Geräts
    ctx: Arc<Mutex<Option<WhisperContext>>>,             // gecachtes Modell (teurer Load; im Hintergrund vorgeladen)
}

fn model_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("models").join(MODEL_FILE))
}

#[derive(Serialize)]
pub struct ModelStatus {
    installed: bool,
    path: String,
    total_bytes: u64,
}

#[tauri::command]
pub fn whisper_model_status(app: AppHandle) -> Result<ModelStatus, String> {
    let p = model_path(&app)?;
    Ok(ModelStatus {
        installed: p.exists(),
        path: p.to_string_lossy().into_owned(),
        total_bytes: MODEL_TOTAL_BYTES,
    })
}

#[derive(Clone, Serialize)]
struct DownloadProgress {
    downloaded: u64,
    total: u64,
}

/// Lädt das Whisper-Modell einmalig per `curl` (folgt Redirects, streamt auf Platte) und
/// meldet Fortschritt über das Event `whisper-download-progress`.
#[tauri::command]
pub async fn whisper_download_model(app: AppHandle) -> Result<(), String> {
    let path = model_path(&app)?;
    if path.exists() {
        return Ok(());
    }
    let dir = path.parent().ok_or("kein Modell-Ordner")?.to_path_buf();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{MODEL_FILE}.download"));

    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let _ = std::fs::remove_file(&tmp);
        let mut child = Command::new("curl")
            .args(["-L", "--fail", "--silent", "--show-error", "-o"])
            .arg(&tmp)
            .arg(MODEL_URL)
            .spawn()
            .map_err(|e| format!("curl-Start fehlgeschlagen: {e}"))?;
        loop {
            match child.try_wait().map_err(|e| e.to_string())? {
                Some(status) => {
                    if status.success() {
                        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
                        let _ = app.emit(
                            "whisper-download-progress",
                            DownloadProgress { downloaded: MODEL_TOTAL_BYTES, total: MODEL_TOTAL_BYTES },
                        );
                        return Ok(());
                    }
                    let _ = std::fs::remove_file(&tmp);
                    return Err(format!("Download fehlgeschlagen (curl {:?})", status.code()));
                }
                None => {
                    let dl = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
                    let _ = app.emit(
                        "whisper-download-progress",
                        DownloadProgress { downloaded: dl, total: MODEL_TOTAL_BYTES },
                    );
                    std::thread::sleep(Duration::from_millis(400));
                }
            }
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(())
}

/// Lädt das Modell in den Cache (idempotent). Wird beim Aufnahme-Start im Hintergrund
/// vorgeladen, damit der Stop nicht erst Sekunden auf den ~1,5-GB-Load warten muss.
fn ensure_model(ctx: &Arc<Mutex<Option<WhisperContext>>>, path: &Path) -> Result<(), String> {
    let mut g = ctx.lock().unwrap();
    if g.is_none() {
        let mut cp = WhisperContextParameters::new();
        cp.use_gpu(true); // dank `metal`-Feature
        *g = Some(WhisperContext::new_with_params(path, cp).map_err(|e| format!("Modell laden: {e}"))?);
    }
    Ok(())
}

/// Startet die Aufnahme. Liefert einen Fehler (z. B. Mikrofon verweigert / kein Gerät) sofort.
#[tauri::command]
pub fn dictation_start(app: AppHandle, state: tauri::State<'_, DictationState>) -> Result<(), String> {
    if state.active.lock().unwrap().is_some() {
        return Ok(()); // läuft bereits
    }
    state.samples.lock().unwrap().clear();
    let samples = state.samples.clone();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();

    let handle = std::thread::spawn(move || match build_capture(samples) {
        Ok((stream, rate)) => {
            let _ = ready_tx.send(Ok(rate));
            let _ = stop_rx.recv(); // bis Stop blockieren
            drop(stream); // beendet die Aufnahme auf DIESEM Thread (Stream ist !Send)
        }
        Err(e) => {
            let _ = ready_tx.send(Err(e));
        }
    });

    match ready_rx.recv_timeout(Duration::from_secs(8)) {
        Ok(Ok(rate)) => {
            *state.input_rate.lock().unwrap() = rate;
            *state.active.lock().unwrap() = Some((stop_tx, handle));
            // Modell schon WÄHREND der Aufnahme im Hintergrund laden → Stop reagiert sofort.
            if let Ok(p) = model_path(&app) {
                if p.exists() {
                    let ctx = state.ctx.clone();
                    std::thread::spawn(move || {
                        let _ = ensure_model(&ctx, &p);
                    });
                }
            }
            Ok(())
        }
        Ok(Err(e)) => {
            let _ = handle.join();
            Err(e)
        }
        Err(_) => Err("Mikrofon konnte nicht gestartet werden (Timeout)".into()),
    }
}

/// Stoppt die Aufnahme, resampelt auf 16 kHz und transkribiert. Liefert den Text.
#[tauri::command]
pub fn dictation_stop(
    app: AppHandle,
    state: tauri::State<'_, DictationState>,
) -> Result<String, String> {
    let active = state.active.lock().unwrap().take();
    let Some((stop_tx, handle)) = active else {
        return Err("Keine Aufnahme aktiv".into());
    };
    let _ = stop_tx.send(());
    let _ = handle.join();

    let rate = *state.input_rate.lock().unwrap();
    let samples = std::mem::take(&mut *state.samples.lock().unwrap());
    if samples.len() < (rate as usize) / 20 {
        return Ok(String::new()); // < ~50 ms → nichts Verwertbares
    }
    let pcm = resample_to_16k(&samples, rate);

    let p = model_path(&app)?;
    if !p.exists() {
        return Err("Sprachmodell nicht installiert".into());
    }
    ensure_model(&state.ctx, &p)?; // wartet ggf. auf den Hintergrund-Preload
    let guard = state.ctx.lock().unwrap();
    transcribe(guard.as_ref().unwrap(), &pcm)
}

/// Bricht eine laufende Aufnahme ab (ohne Transkription).
#[tauri::command]
pub fn dictation_cancel(state: tauri::State<'_, DictationState>) -> Result<(), String> {
    if let Some((stop_tx, handle)) = state.active.lock().unwrap().take() {
        let _ = stop_tx.send(());
        let _ = handle.join();
    }
    state.samples.lock().unwrap().clear();
    Ok(())
}

/// Baut + startet den Eingabe-Stream. MUSS auf dem Aufnahme-Thread laufen (Stream `!Send`).
fn build_capture(samples: Arc<Mutex<Vec<f32>>>) -> Result<(cpal::Stream, u32), String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("Kein Mikrofon gefunden")?;
    let supported = device
        .default_input_config()
        .map_err(|e| format!("Audio-Konfiguration: {e}"))?;
    let rate = supported.sample_rate(); // cpal 0.18: SampleRate ist ein u32-Alias
    let channels = supported.channels() as usize;
    let fmt = supported.sample_format();
    let config = supported.config();
    let err_fn = |e| eprintln!("[dictation] stream error: {e}");

    macro_rules! build {
        ($t:ty, $conv:expr) => {{
            let buf = samples.clone();
            let conv: fn($t) -> f32 = $conv;
            device
                .build_input_stream(
                    config.clone(),
                    move |data: &[$t], _: &cpal::InputCallbackInfo| {
                        let mut v = buf.lock().unwrap();
                        if channels <= 1 {
                            v.extend(data.iter().map(|&s| conv(s)));
                        } else {
                            for frame in data.chunks_exact(channels) {
                                let sum: f32 = frame.iter().map(|&s| conv(s)).sum();
                                v.push(sum / channels as f32);
                            }
                        }
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| format!("Stream: {e}"))?
        }};
    }

    let stream = match fmt {
        SampleFormat::F32 => build!(f32, |s| s),
        SampleFormat::I16 => build!(i16, |s| s as f32 / 32768.0),
        SampleFormat::U16 => build!(u16, |s| (s as f32 - 32768.0) / 32768.0),
        other => return Err(format!("Audioformat nicht unterstützt: {other:?}")),
    };
    stream.play().map_err(|e| format!("play: {e}"))?;
    Ok((stream, rate))
}

/// Box-gemitteltes Downsampling auf 16 kHz mono (grobes Anti-Aliasing, für STT ausreichend).
fn resample_to_16k(input: &[f32], in_rate: u32) -> Vec<f32> {
    if in_rate == TARGET_RATE || input.is_empty() {
        return input.to_vec();
    }
    let ratio = in_rate as f64 / TARGET_RATE as f64; // Eingabe-Samples pro Ausgabe-Sample
    let out_len = ((input.len() as f64) / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len + 1);
    for i in 0..out_len {
        let start = (i as f64 * ratio) as usize;
        let mut end = (((i + 1) as f64) * ratio).ceil() as usize;
        if end > input.len() {
            end = input.len();
        }
        if end <= start {
            end = (start + 1).min(input.len());
        }
        let slice = &input[start..end];
        out.push(slice.iter().copied().sum::<f32>() / slice.len() as f32);
    }
    out
}

fn transcribe(ctx: &WhisperContext, pcm: &[f32]) -> Result<String, String> {
    let mut st = ctx.create_state().map_err(|e| e.to_string())?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("auto")); // Sprache automatisch erkennen
    params.set_translate(false);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    st.full(params, pcm).map_err(|e| e.to_string())?;
    let n = st.full_n_segments();
    let mut out = String::new();
    for i in 0..n {
        if let Some(seg) = st.get_segment(i) {
            out.push_str(&seg.to_str_lossy().map_err(|e| e.to_string())?);
        }
    }
    Ok(out.trim().to_string())
}
