//! Remote-Bridge: WSS-Server (TLS 1.3) + mDNS-Advertise, teet den Sidecar-stdout an gekoppelte
//! iOS-Clients (docs/design/remote-companion-app.md §4; Schnittstellen-Vertrag:
//! mads-remote/docs/mads-bridge.md).
//!
//! **Stand P0.2 (Skelett):** TLS 1.3 (self-signed, TOFU-Pinning) + mDNS-Advertise
//! `_mads-remote._tcp` + WSS-Accept + roher stdout-Tee an einen (noch UNauthentifizierten)
//! Client. Bewusst NOCH NICHT enthalten und deshalb hinter der Env-Var `MADS_REMOTE_BRIDGE=1`
//! gegated (siehe lib.rs), damit nie versehentlich ein auth-loser Server läuft:
//!   - Pairing/Auth (P1.2), per-Verbindungs-`FsScope` + file-rpc (P1.1),
//!   - Command-Forward mit `HostMessage`-Validierung (P0.3).
//!
//! Der Rust-Core bleibt protokoll-dünn: die Bridge PARST das NDJSON nicht, sie reicht Zeilen
//! roh durch — exakt wie das Frontend-Relay (ein Tee, zwei Konsumenten).

use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use crate::auth::AuthState;
use crate::files;
use futures_util::{SinkExt, StreamExt};
use rcgen::{CertifiedKey, PublicKeyData};
use rustls::version::TLS13;
use rustls::ServerConfig;
use rustls_pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use sha2::{Digest, Sha256};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::accept_hdr_async;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::{http, Message};

/// mDNS-Service-Typ (ein Service = eine Instanz).
const SERVICE_TYPE: &str = "_mads-remote._tcp.local.";
/// Muss `PROTOCOL_VERSION` in shared/protocol.ts spiegeln.
const PROTOCOL_VERSION: &str = "1";
/// Heartbeat-Ping-Intervall (hält NAT/Idle-Sockets offen, erkennt tote Peers).
const HEARTBEAT: Duration = Duration::from_secs(15);

type BridgeResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

/// Senke, die eine validierte HostMessage (kanonisches JSON) an den Sidecar-stdin schreibt.
/// Injiziert von lib.rs (kapselt `SidecarState::send_line`), damit `bridge.rs` NICHT von Tauri
/// abhängt und testbar bleibt.
pub type CommandSink = Arc<dyn Fn(&str) -> Result<(), String> + Send + Sync>;

/// Allowlist der bekannten HostMessage-`type`-Werte (shared/protocol.ts, HostMessage-Union). NUR
/// diese werden an den Sidecar-stdin weitergereicht — ein unbekannter Typ wird verworfen. Der
/// Rust-Core bleibt protokoll-dünn: er kennt nur die Typ-NAMEN (Allowlist), nicht deren Semantik.
const HOST_MESSAGE_TYPES: &[&str] = &[
    "open_project", "set_project", "poll_project", "start_agent", "send_input",
    "answer_permission", "interrupt_agent", "set_permission_mode", "stop_agent",
    "cleanup_worktree", "create_pr", "sync_branch", "gate_task", "integrate_pr",
    "set_autonomy", "set_autopilot", "set_model_effort", "outsource_main", "update_main",
    "start_devserver", "stop_devserver", "shutdown", "request_snapshot",
];

/// Permission-Modi, die ein Remote-Client NICHT setzen darf: sie würden Agent-Tool-Calls
/// automatisch freigeben — RCE-äquivalent. Höchste Sicherheitspriorität
/// (mads-remote/docs/architecture.md §6 P0 #1).
const FORBIDDEN_PERMISSION_MODES: &[&str] = &["bypassPermissions", "dontAsk"];

/// Validiert ein rohes WS-Text-Frame (Envelope) und gibt die KANONISCH re-serialisierte
/// HostMessage (nur `msg`, ohne Envelope) zurück, die an den Sidecar-stdin geht. Fehler = Grund
/// (der Frame wird verworfen). Kontrollen: (1) Kanal muss `command` sein; (2) `msg.type` in der
/// Allowlist; (3) `permissionMode`/`mode` nicht in der Deny-Liste. Die Re-Serialisierung
/// normalisiert das JSON — u. a. keine eingebetteten rohen Newlines → keine NDJSON-Injection
/// (ein Frame == genau eine stdin-Zeile).
/// Test-Convenience (parst + validiert). Der Laufzeit-Pfad nutzt `validate_command_value` auf dem
/// bereits geparsten Envelope (siehe `process_client_frame`).
#[cfg(test)]
fn validate_command(frame: &str) -> Result<String, String> {
    let env: serde_json::Value = serde_json::from_str(frame).map_err(|_| "kein gültiges JSON".to_string())?;
    validate_command_value(&env)
}

/// Wie `validate_command`, aber auf einem BEREITS geparsten Envelope (spart den Doppel-Parse im
/// Client-Frame-Dispatch).
fn validate_command_value(env: &serde_json::Value) -> Result<String, String> {
    let channel = env.get("channel").and_then(|c| c.as_str()).unwrap_or("");
    if channel != "command" {
        return Err(format!("Kanal '{channel}' nicht erlaubt (nur 'command' geht an stdin)"));
    }

    let msg = env.get("msg").ok_or("Envelope ohne 'msg'")?;
    let ty = msg.get("type").and_then(|t| t.as_str()).ok_or("msg ohne 'type'")?;
    if !HOST_MESSAGE_TYPES.contains(&ty) {
        return Err(format!("unbekannter HostMessage-Typ '{ty}'"));
    }

    // permissionMode (start_agent) bzw. mode (set_permission_mode) gegen die Deny-Liste prüfen.
    for field in ["permissionMode", "mode"] {
        if let Some(v) = msg.get(field).and_then(|v| v.as_str()) {
            if FORBIDDEN_PERMISSION_MODES.contains(&v) {
                return Err(format!("permissionMode '{v}' von Remote nicht erlaubt (RCE-Schutz)"));
            }
        }
    }

    // Kanonisch re-serialisieren (nur die HostMessage) → normalisiert, kein Newline-Smuggling.
    serde_json::to_string(msg).map_err(|e| e.to_string())
}

/// Ein rohes Client-Text-Frame verarbeiten. Die Verbindung ist erst nach `pair` (PIN einlösen) oder
/// `auth` (Token) authentifiziert (`authed` = deviceId). Vorher werden `command`/`file-rpc`
/// abgelehnt und der Event-Tee NICHT ausgeliefert (siehe `handle_conn`). Gibt die optionale
/// Antwort zurück, die der Aufrufer über den WS-Sink schickt.
fn process_client_frame(
    frame: &str,
    authed: &mut Option<String>,
    conn_fs: &files::FsScope,
    forward: &CommandSink,
    auth: &AuthState,
) -> Option<String> {
    let env: serde_json::Value = match serde_json::from_str(frame) {
        Ok(v) => v,
        Err(_) => {
            eprintln!("[mads:bridge] Frame kein JSON — verworfen");
            return None;
        }
    };
    match env.get("channel").and_then(|c| c.as_str()).unwrap_or("") {
        // ── Pairing: einmaligen PIN einlösen → Geräte-Token (nur hier im Klartext) ──
        "pair" => {
            let pin = env.get("pin").and_then(|v| v.as_str()).unwrap_or("");
            let name = env.get("name").and_then(|v| v.as_str()).unwrap_or("Unbenanntes Gerät");
            match auth.redeem_pin(pin, name) {
                Ok(token) => {
                    let device_id = token.split_once('.').map(|(a, _)| a.to_string()).unwrap_or_default();
                    eprintln!("[mads:bridge] Gerät gekoppelt: {name} ({device_id})");
                    *authed = Some(device_id.clone());
                    Some(serde_json::json!({ "channel": "pair-reply", "ok": true, "token": token, "deviceId": device_id }).to_string())
                }
                Err(e) => Some(serde_json::json!({ "channel": "pair-reply", "ok": false, "error": e }).to_string()),
            }
        }
        // ── Re-Auth mit bestehendem Token ──
        "auth" => {
            let token = env.get("token").and_then(|v| v.as_str()).unwrap_or("");
            match auth.verify_token(token) {
                Ok(device_id) => {
                    *authed = Some(device_id.clone());
                    Some(serde_json::json!({ "channel": "auth-reply", "ok": true, "deviceId": device_id }).to_string())
                }
                Err(e) => Some(serde_json::json!({ "channel": "auth-reply", "ok": false, "error": e }).to_string()),
            }
        }
        // ── Privilegierte Kanäle: erst nach Auth ──
        ch @ ("command" | "file-rpc") if authed.is_none() => {
            eprintln!("[mads:bridge] '{ch}' vor Auth abgelehnt");
            Some(serde_json::json!({ "channel": "error", "error": "nicht authentifiziert" }).to_string())
        }
        "command" => {
            match validate_command_value(&env) {
                Ok(line) => {
                    if let Err(e) = forward(&line) {
                        eprintln!("[mads:bridge] Forward an Sidecar fehlgeschlagen: {e}");
                    }
                }
                Err(reason) => eprintln!("[mads:bridge] Command abgelehnt: {reason}"),
            }
            None
        }
        "file-rpc" => Some(file_rpc_reply(&env, conn_fs)),
        other => {
            eprintln!("[mads:bridge] unbekannter Kanal '{other}' — verworfen");
            None
        }
    }
}

/// File-RPC gegen den PRO-VERBINDUNGS-Scope ausführen und die `file-rpc-reply`-Hülle bauen
/// (korreliert über `id`). Der Scope startet LEER — ein Client muss erst `register_root`.
fn file_rpc_reply(env: &serde_json::Value, conn_fs: &files::FsScope) -> String {
    let id = env.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let op = env.get("op").and_then(|v| v.as_str()).unwrap_or("");
    let args = env.get("args").cloned().unwrap_or(serde_json::Value::Null);
    match dispatch_file_rpc(op, &args, conn_fs) {
        Ok(result) => serde_json::json!({ "v": 1, "id": id, "channel": "file-rpc-reply", "ok": true, "result": result }).to_string(),
        Err(error) => serde_json::json!({ "v": 1, "id": id, "channel": "file-rpc-reply", "ok": false, "error": error }).to_string(),
    }
}

/// Die (read-only) file-rpc-Ops von P1.1 gegen den übergebenen Scope. Schreib-Ops kommen mit dem
/// Editor (P3.2). Jeder Pfad läuft durch `ensure_in_scope` (Deny-First/Canonicalize/Prefix) im
/// PRO-VERBINDUNGS-Scope — ein Client kann den Scope eines anderen nicht sehen (§9.5).
fn dispatch_file_rpc(op: &str, args: &serde_json::Value, conn_fs: &files::FsScope) -> Result<serde_json::Value, String> {
    let arg = |key: &str| args.get(key).and_then(|v| v.as_str()).ok_or_else(|| format!("arg '{key}' fehlt"));
    match op {
        "register_root" => {
            files::register_root_inner(conn_fs, arg("path")?)?;
            Ok(serde_json::json!({ "registered": true }))
        }
        "read_dir" => {
            let nodes = files::read_dir_inner(conn_fs, arg("path")?)?;
            serde_json::to_value(nodes).map_err(|e| e.to_string())
        }
        "read_file" => {
            let fr = files::read_file_inner(conn_fs, arg("path")?)?;
            serde_json::to_value(fr).map_err(|e| e.to_string())
        }
        "write_file" => {
            // Optimistic-Concurrency: base{MtimeMs,Size,Hash} werden mitgeschickt; write_file_inner
            // liefert `saved{…}` oder `conflict`, wenn die Datei sich seit dem Laden geändert hat.
            let content = args.get("content").and_then(|v| v.as_str()).ok_or("arg 'content' fehlt")?;
            let base_mtime = args.get("baseMtimeMs").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let base_size = args.get("baseSize").and_then(|v| v.as_u64()).unwrap_or(0);
            let base_hash = args.get("baseHash").and_then(|v| v.as_str()).unwrap_or("");
            let result = files::write_file_inner(conn_fs, arg("path")?, content, base_mtime, base_size, base_hash)?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "write_file_bytes" | "save_transcript" | "load_transcript" => {
            Err(format!("file-rpc op '{op}' noch nicht implementiert (P3/P4)"))
        }
        other => Err(format!("unbekannte file-rpc op '{other}'")),
    }
}

/// Ein laufender Bridge-Dienst. Solange dieser Handle lebt, laufen Accept-Loop und
/// mDNS-Registrierung; beim Drop werden der Accept-Task abgebrochen und der mDNS-Daemon
/// heruntergefahren (best effort).
pub struct Bridge {
    pub port: u16,
    /// SHA-256 des SubjectPublicKeyInfo (hex, lowercase) — der Wert, den iOS pinnt (TOFU).
    pub spki_fp_hex: String,
    accept: tokio::task::JoinHandle<()>,
    mdns: mdns_sd::ServiceDaemon,
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.accept.abort();
        let _ = self.mdns.shutdown();
    }
}

/// Laufzeit-Info der gestarteten Bridge (für die Pairing-UI).
pub struct BridgeRuntimeInfo {
    pub port: u16,
    pub spki_fp_hex: String,
}

/// In Tauri gemanagter Zustand: Auth-DB + Laufzeit-Info. Die Pairing-Commands (lib.rs) lesen ihn;
/// der Bridge-Thread setzt die Info beim Start. Auth-DB existiert auch, wenn die Bridge (WSS/mDNS)
/// per `MADS_REMOTE_BRIDGE` gegated ist.
pub struct RemoteBridgeState {
    pub auth: Arc<AuthState>,
    pub info: std::sync::Mutex<Option<BridgeRuntimeInfo>>,
}

impl RemoteBridgeState {
    pub fn new(auth: Arc<AuthState>) -> Self {
        Self { auth, info: std::sync::Mutex::new(None) }
    }
    pub fn set_info(&self, port: u16, spki_fp_hex: String) {
        *self.info.lock().unwrap() = Some(BridgeRuntimeInfo { port, spki_fp_hex });
    }
}

/// QR-Payload fürs Pairing als SVG. Trägt `fp` (SPKI-Pin) + einmaligen `pin` — Host/Port kommen über
/// mDNS (Bonjour), müssen also nicht im QR stehen. Die iOS-App scannt das, matcht den mDNS-Service
/// per fp und löst den PIN ein.
pub fn pairing_qr_svg(fp: &str, pin: &str) -> Result<String, String> {
    use qrcode::render::svg;
    use qrcode::QrCode;
    let payload = format!("mads-remote://pair?pv={PROTOCOL_VERSION}&fp={fp}&pin={pin}");
    let code = QrCode::new(payload.as_bytes()).map_err(|e| e.to_string())?;
    Ok(code
        .render::<svg::Color>()
        .min_dimensions(220, 220)
        .quiet_zone(true)
        .build())
}

/// Bridge starten: Zert laden/erzeugen (persistiert → stabiler Pin über Neustarts), TCP auf einem
/// ephemeren Port binden (Multi-Instanz-freundlich), mDNS advertisen, Accept-Loop spawnen.
/// `tee` = Sender des Sidecar-stdout-Broadcasts; pro Client wird `tee.subscribe()` aufgerufen.
pub async fn start(tee: broadcast::Sender<String>, forward: CommandSink, auth: Arc<AuthState>, cert_dir: PathBuf, project: String) -> BridgeResult<Bridge> {
    let cert = load_or_generate_cert(&cert_dir)?;
    let spki_fp_hex = hex_lower(&cert.spki_fp);
    let tls_config = make_server_config(cert.cert_der, cert.key_der)?;

    let (port, accept) = bind_and_serve(tls_config, tee, forward, auth).await?;
    let mdns = advertise(port, &spki_fp_hex, &project)?;

    Ok(Bridge { port, spki_fp_hex, accept, mdns })
}

/// Testbarer Kern OHNE mDNS: auf allen Interfaces binden (der iPad im LAN muss uns erreichen;
/// ephemerer Port = Multi-Instanz-freundlich), Accept-Loop spawnen. Gibt (Port, Accept-Handle)
/// zurück.
async fn bind_and_serve(tls_config: Arc<ServerConfig>, tee: broadcast::Sender<String>, forward: CommandSink, auth: Arc<AuthState>) -> BridgeResult<(u16, tokio::task::JoinHandle<()>)> {
    let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).await?;
    let port = listener.local_addr()?.port();
    let acceptor = TlsAcceptor::from(tls_config);
    let accept = tokio::spawn(accept_loop(listener, acceptor, tee, forward, auth));
    Ok((port, accept))
}

// ─────────────────────────────────────────────────────────────── TLS / Zertifikat

struct CertBundle {
    cert_der: CertificateDer<'static>,
    key_der: PrivateKeyDer<'static>,
    /// SHA-256 des SPKI (für den TOFU-Pin).
    spki_fp: [u8; 32],
}

/// Zert + Key aus `cert_dir` laden; existieren sie nicht, ein frisches self-signed Leaf erzeugen
/// und mit Mode 0600 persistieren. DER-Dateien (keine PEM-Parsing-Fläche); der SPKI-Fingerprint
/// wird beim Erzeugen berechnet und mitpersistiert, damit der Pin über Neustarts stabil bleibt.
fn load_or_generate_cert(dir: &Path) -> BridgeResult<CertBundle> {
    let cert_path = dir.join("cert.der");
    let key_path = dir.join("key.pk8.der");
    let fp_path = dir.join("spki-fp.hex");

    if cert_path.exists() && key_path.exists() && fp_path.exists() {
        let cert_der = CertificateDer::from(std::fs::read(&cert_path)?);
        let key_der = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(std::fs::read(&key_path)?));
        let spki_fp = hex_to_32(std::fs::read_to_string(&fp_path)?.trim())
            .ok_or("spki-fp.hex korrupt")?;
        return Ok(CertBundle { cert_der, key_der, spki_fp });
    }

    let (cert_der_bytes, key_pkcs8, spki_fp) = generate_cert()?;
    std::fs::create_dir_all(dir)?;
    write_600(&cert_path, &cert_der_bytes)?;
    write_600(&key_path, &key_pkcs8)?; // privater Schlüssel — nur Owner lesbar
    std::fs::write(&fp_path, hex_lower(&spki_fp))?;

    Ok(CertBundle {
        cert_der: CertificateDer::from(cert_der_bytes),
        key_der: PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_pkcs8)),
        spki_fp,
    })
}

/// Frisches self-signed Leaf. Gibt (cert-DER, PKCS#8-key-DER, SPKI-SHA256) zurück. SANs sind
/// bewusst minimal (localhost/.local/127.0.0.1): der iOS-Client verifiziert per SPKI-Pin
/// (Custom-Verifier), nicht per Hostname/SAN-Match — der echte LAN-Host muss also nicht im SAN
/// stehen. `generate_simple_self_signed` baut die SAN-Liste intern (DNS vs. IP automatisch).
fn generate_cert() -> BridgeResult<(Vec<u8>, Vec<u8>, [u8; 32])> {
    let sans = vec![
        "localhost".to_string(),
        "mads-remote.local".to_string(),
        "127.0.0.1".to_string(),
    ];
    let CertifiedKey { cert, signing_key } = rcgen::generate_simple_self_signed(sans)?;

    let cert_der = cert.der().to_vec();
    let key_pkcs8 = signing_key.serialize_der(); // PKCS#8 DER
    // SPKI = vollständiges SubjectPublicKeyInfo (RFC 5280), NICHT der rohe Key → das pinnt iOS.
    let spki_fp: [u8; 32] = Sha256::digest(signing_key.subject_public_key_info()).into();

    Ok((cert_der, key_pkcs8, spki_fp))
}

/// TLS-1.3-only ServerConfig (Default-Provider aws-lc-rs). Kein 0-RTT (Command-Plane ist nicht
/// idempotent → `max_early_data_size = 0`).
fn make_server_config(cert_der: CertificateDer<'static>, key_der: PrivateKeyDer<'static>) -> BridgeResult<Arc<ServerConfig>> {
    let mut config = ServerConfig::builder_with_protocol_versions(&[&TLS13])
        .with_no_client_auth()
        .with_single_cert(vec![cert_der], key_der)?;
    config.max_early_data_size = 0;
    Ok(Arc::new(config))
}

// ─────────────────────────────────────────────────────────────── mDNS-Advertise

/// `_mads-remote._tcp` advertisen; TXT trägt name/host/pid/project/pv/fp (fp = SPKI-Pin, nur Hinweis
/// — autoritativ ist der beim Pairing gepinnte fp). IPs werden per `enable_addr_auto()` automatisch
/// erkannt und aktuell gehalten.
/// Primäre LAN-IPv4 (die des Default-Route-Interfaces) — die IP, die ein LAN-Client tatsächlich
/// erreicht. Der UDP-„connect" sendet KEIN Paket, setzt nur die Route; `local_addr()` liefert dann
/// die Quell-IP. Link-local/Loopback werden verworfen.
fn primary_lan_ip() -> Option<String> {
    let sock = std::net::UdpSocket::bind(("0.0.0.0", 0)).ok()?;
    sock.connect(("8.8.8.8", 80)).ok()?;
    match sock.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_link_local() => Some(v4.to_string()),
        _ => None,
    }
}

fn advertise(port: u16, fp_hex: &str, project: &str) -> BridgeResult<mdns_sd::ServiceDaemon> {
    use mdns_sd::{ServiceDaemon, ServiceInfo};

    let daemon = ServiceDaemon::new()?;
    let pid = std::process::id();

    let mut props: HashMap<String, String> = HashMap::new();
    props.insert("name".into(), format!("mads Remote ({project})"));
    props.insert("pid".into(), pid.to_string());
    props.insert("project".into(), project.to_string());
    props.insert("pv".into(), PROTOCOL_VERSION.into());
    props.insert("fp".into(), fp_hex.to_string());
    // LAN-IP + Port direkt annoncieren, damit der Client OHNE fragile Bonjour-Auflösung verbindet
    // (die auf einem USB-verbundenen iPad die unbrauchbare link-local Adresse liefert).
    props.insert("port".into(), port.to_string());
    if let Some(ip) = primary_lan_ip() {
        props.insert("addr".into(), ip);
    }

    let instance = format!("mads-{pid}");
    let service = ServiceInfo::new(
        SERVICE_TYPE,
        &instance,
        "mads-remote.local.", // host_name (Trailing-Dot Pflicht)
        "",                    // IP-Platzhalter → von enable_addr_auto() gefüllt
        port,
        props,
    )?
    .enable_addr_auto();

    daemon.register(service)?;
    Ok(daemon)
}

// ─────────────────────────────────────────────────────────────── Accept-Loop

async fn accept_loop(listener: TcpListener, acceptor: TlsAcceptor, tee: broadcast::Sender<String>, forward: CommandSink, auth: Arc<AuthState>) {
    loop {
        let (tcp, peer) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[mads:bridge] accept-Fehler: {e}");
                continue;
            }
        };
        // Subscription VOR dem Handshake ziehen: gepufferte Zeilen gehen dem Client so nicht verloren.
        let rx = tee.subscribe();
        let acceptor = acceptor.clone();
        let forward = forward.clone();
        let auth = auth.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_conn(tcp, acceptor, rx, forward, auth).await {
                eprintln!("[mads:bridge] Verbindung {peer} beendet: {e}");
            }
        });
    }
}

/// Eine Client-Verbindung: TLS-Accept → WSS-Handshake (mit Anti-CSWSH-Origin-Check) → roher
/// stdout-Tee an den Client + Heartbeat, und (P0.3) Command-Forward: Text-Frames werden gegen
/// `validate_command` geprüft und die kanonische HostMessage an den Sidecar-stdin gereicht.
/// Abgelehnte/ungültige Frames werden verworfen (stderr-Log) — NICHT weitergereicht.
///
/// P0.3 hat NOCH keine Auth (kommt P1.2, hinter dem MADS_REMOTE_BRIDGE-Gate); ein verbundener
/// Client darf also bereits Befehle senden — außer den per Deny-Liste gesperrten permissionMode.
async fn handle_conn(tcp: TcpStream, acceptor: TlsAcceptor, mut rx: broadcast::Receiver<String>, forward: CommandSink, auth: Arc<AuthState>) -> BridgeResult<()> {
    let tls = acceptor.accept(tcp).await?;

    // Anti-CSWSH: ein nativer Client sendet KEINEN Origin-Header; ein Browser schon → ablehnen.
    let origin_guard = |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
        if req.headers().contains_key("origin") {
            let err = http::Response::builder()
                .status(http::StatusCode::FORBIDDEN)
                .body(Some("origin header not allowed".to_string()))
                .unwrap();
            return Err(err);
        }
        Ok(resp)
    };
    let ws = accept_hdr_async(tls, origin_guard).await?;
    let (mut sink, mut source) = ws.split();

    // PRO-VERBINDUNGS-Scope (§9.5): startet leer, wird nur durch `register_root` dieser Verbindung
    // gefüllt und verschwindet beim Disconnect. Kein anderer Socket sieht diese Roots.
    let conn_fs = files::FsScope::default();
    // Auth-Zustand DIESER Verbindung: None bis `pair`/`auth` erfolgreich (dann die deviceId).
    // Vor Auth wird der Event-Tee NICHT ausgeliefert und command/file-rpc abgelehnt.
    let mut authed: Option<String> = None;

    let mut heartbeat = tokio::time::interval(HEARTBEAT);
    heartbeat.tick().await; // erster Tick feuert sofort — überspringen

    loop {
        tokio::select! {
            tee_line = rx.recv() => match tee_line {
                // Tee NUR an authentifizierte Clients (Events sind sensibel). Vor Auth: verwerfen
                // (recv leert den Puffer → kein Lag; der Client re-synct nach Auth via request_snapshot).
                Ok(line) => {
                    if authed.is_some() {
                        sink.send(Message::text(line)).await?;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    eprintln!("[mads:bridge] Client hinkt {n} Zeilen hinterher (verworfen)");
                }
                Err(broadcast::error::RecvError::Closed) => break, // Sidecar-stdout endete
            },
            _ = heartbeat.tick() => {
                // Widerruf trennt laufende Verbindungen (spätestens beim nächsten Tick, ~15 s).
                if let Some(dev) = &authed {
                    if auth.is_revoked(dev) {
                        eprintln!("[mads:bridge] Gerät {dev} widerrufen → trenne");
                        break;
                    }
                }
                sink.send(Message::Ping(Vec::<u8>::new().into())).await?;
            }
            incoming = source.next() => match incoming {
                Some(Ok(Message::Text(t))) => {
                    if let Some(reply) = process_client_frame(t.as_str(), &mut authed, &conn_fs, &forward, &auth) {
                        sink.send(Message::text(reply)).await?;
                    }
                }
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => { /* Ping/Pong/Binary: ignorieren (Binär-Frames erst OE-R6) */ }
                Some(Err(e)) => return Err(e.into()),
            },
        }
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────── Helpers

fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

fn hex_to_32(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

/// Datei mit Mode 0600 schreiben (privater Schlüssel: nur Owner lesbar/schreibbar).
fn write_600(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(bytes)
}

// ─────────────────────────────────────────────────────────────── Tests
//
// Verifiziert den Kern von P0.2 END-TO-END OHNE GUI: ein TLS-1.3-WSS-Client verbindet sich zur
// gestarteten Bridge, eine in den Tee gesendete Zeile kommt roh beim Client an. Deckt
// Zert-Erzeugung + rustls-Handshake + tokio-tungstenite + Broadcast-Tee ab.

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
    use rustls::{DigitallySignedStruct, SignatureScheme};
    use rustls_pki_types::{ServerName, UnixTime};
    use tokio_rustls::TlsConnector as TlsConnectorClient;

    /// TEST-ONLY: akzeptiert jedes Server-Zert (wir testen den Transport, nicht das Pinning —
    /// das SPKI-Pinning lebt im iOS-Client). NIEMALS in Produktion.
    #[derive(Debug)]
    struct AcceptAnyServerCert(Arc<rustls::crypto::CryptoProvider>);

    impl ServerCertVerifier for AcceptAnyServerCert {
        fn verify_server_cert(&self, _e: &CertificateDer<'_>, _i: &[CertificateDer<'_>], _s: &ServerName<'_>, _o: &[u8], _n: UnixTime) -> Result<ServerCertVerified, rustls::Error> {
            Ok(ServerCertVerified::assertion())
        }
        fn verify_tls12_signature(&self, _m: &[u8], _c: &CertificateDer<'_>, _d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
            Ok(HandshakeSignatureValid::assertion())
        }
        fn verify_tls13_signature(&self, _m: &[u8], _c: &CertificateDer<'_>, _d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
            Ok(HandshakeSignatureValid::assertion())
        }
        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            self.0.signature_verification_algorithms.supported_schemes()
        }
    }

    /// Hermetische Test-Server-Config aus einem frischen Zert (kein mDNS — Multicast ist in
    /// Sandboxes oft gesperrt und für die Transport-/Command-Tests irrelevant).
    fn test_config() -> Arc<ServerConfig> {
        let (cert_der_bytes, key_pkcs8, _fp) = generate_cert().expect("cert gen");
        make_server_config(
            CertificateDer::from(cert_der_bytes),
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_pkcs8)),
        )
        .expect("server config")
    }

    /// Command-Senke, die Forwards verwirft.
    fn noop_sink() -> CommandSink {
        Arc::new(|_line: &str| Ok(()))
    }

    /// TLS-1.3-WSS-Client zur Bridge (skip-verify, test-only).
    async fn connect_ws_client(port: u16) -> tokio_tungstenite::WebSocketStream<tokio_rustls::client::TlsStream<TcpStream>> {
        let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        let client_config = rustls::ClientConfig::builder_with_protocol_versions(&[&TLS13])
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAnyServerCert(provider)))
            .with_no_client_auth();
        let connector = TlsConnectorClient::from(Arc::new(client_config));
        let tcp = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.expect("tcp connect");
        let server_name = ServerName::try_from("localhost").unwrap();
        let tls = connector.connect(server_name, tcp).await.expect("tls handshake");
        let (ws, _resp) = tokio_tungstenite::client_async("wss://localhost/", tls).await.expect("ws handshake");
        ws
    }

    /// In-Memory-Auth für Tests.
    fn test_auth() -> Arc<AuthState> {
        Arc::new(AuthState::in_memory())
    }

    /// Verbinden UND koppeln (PIN aus `auth` ziehen, `pair` senden, `pair-reply` ok abwarten).
    async fn connect_and_pair(
        port: u16,
        auth: &AuthState,
    ) -> tokio_tungstenite::WebSocketStream<tokio_rustls::client::TlsStream<TcpStream>> {
        let mut ws = connect_ws_client(port).await;
        let pin = auth.issue_pin();
        ws.send(Message::text(serde_json::json!({"channel":"pair","pin":pin,"name":"test"}).to_string()))
            .await
            .unwrap();
        let reply = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("timeout")
            .expect("stream")
            .expect("ws");
        match reply {
            Message::Text(t) => assert!(t.as_str().contains(r#""ok":true"#), "pair fehlgeschlagen: {t}"),
            other => panic!("unerwartete pair-Antwort: {other:?}"),
        }
        ws
    }

    /// P0.2: der stdout-Tee erreicht einen (gepaarten) TLS-WSS-Client end-to-end.
    #[tokio::test]
    async fn tee_reaches_tls_ws_client() {
        let auth = test_auth();
        let (tee, _keep) = broadcast::channel::<String>(64);
        let (port, accept) = bind_and_serve(test_config(), tee.clone(), noop_sink(), auth.clone()).await.expect("bind_and_serve");

        let ws = connect_and_pair(port, &auth).await;
        let (mut _sink, mut source) = ws.split();

        let payload = r#"{"v":1,"type":"agent_event","hello":42}"#;
        tee.send(payload.to_string()).expect("tee send");

        let got = tokio::time::timeout(Duration::from_secs(5), source.next())
            .await
            .expect("kein Timeout")
            .expect("Stream nicht beendet")
            .expect("kein WS-Fehler");
        match got {
            Message::Text(t) => assert_eq!(t.as_str(), payload),
            other => panic!("unerwartete Nachricht: {other:?}"),
        }
        accept.abort();
    }

    /// P0.3: ein gültiges `command` wird an die stdin-Senke geforwardet; ein `bypassPermissions`-
    /// start_agent wird ÜBERSPRUNGEN (RCE-Schutz). Deterministisch: Frames werden in Reihenfolge
    /// verarbeitet, also muss der nächste Forward NACH dem bypass das FOLGENDE gültige Command sein.
    #[tokio::test]
    async fn command_forwards_but_bypass_permissions_is_blocked() {
        let auth = test_auth();
        let (tee, _keep) = broadcast::channel::<String>(64);
        let (fwd_tx, mut fwd_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let forward: CommandSink = Arc::new(move |line: &str| fwd_tx.send(line.to_string()).map_err(|e| e.to_string()));
        let (port, accept) = bind_and_serve(test_config(), tee, forward, auth.clone()).await.expect("bind_and_serve");

        let ws = connect_and_pair(port, &auth).await;
        let (mut sink, mut _source) = ws.split();

        // (1) gültiges Command → wird geforwardet, kanonisch, OHNE Envelope.
        sink.send(Message::text(r#"{"v":1,"id":"a","ts":0,"channel":"command","msg":{"type":"poll_project"}}"#)).await.unwrap();
        let first = tokio::time::timeout(Duration::from_secs(5), fwd_rx.recv()).await.expect("timeout").expect("sender offen");
        assert!(first.contains(r#""type":"poll_project""#), "geforwardet: {first}");
        assert!(!first.contains("channel"), "nur die HostMessage, nicht der Envelope: {first}");

        // (2) bypassPermissions (muss übersprungen werden) gefolgt von (3) gültigem Command.
        sink.send(Message::text(r#"{"channel":"command","msg":{"type":"start_agent","agentId":"x","prompt":"p","permissionMode":"bypassPermissions"}}"#)).await.unwrap();
        sink.send(Message::text(r#"{"channel":"command","msg":{"type":"interrupt_agent","agentId":"z9"}}"#)).await.unwrap();

        // Der nächste (und einzige) Forward MUSS (3) sein — (2) wurde verworfen.
        let next = tokio::time::timeout(Duration::from_secs(5), fwd_rx.recv()).await.expect("timeout").expect("sender offen");
        assert!(next.contains("interrupt_agent") && next.contains("z9"), "nächster Forward ist (3): {next}");
        assert!(!next.contains("bypassPermissions"), "bypassPermissions durfte nicht an stdin");

        accept.abort();
    }

    /// P1.2: eine NICHT gepaarte Verbindung darf keine Commands absetzen (Auth-Gate).
    #[tokio::test]
    async fn unauthenticated_command_is_rejected() {
        let auth = test_auth();
        let (tee, _keep) = broadcast::channel::<String>(64);
        let (fwd_tx, mut fwd_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let forward: CommandSink = Arc::new(move |line: &str| fwd_tx.send(line.to_string()).map_err(|e| e.to_string()));
        let (port, accept) = bind_and_serve(test_config(), tee, forward, auth).await.expect("bind_and_serve");

        let mut ws = connect_ws_client(port).await; // NICHT gepaart
        ws.send(Message::text(r#"{"channel":"command","msg":{"type":"poll_project"}}"#)).await.unwrap();

        let reply = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("timeout")
            .expect("stream")
            .expect("ws");
        match reply {
            Message::Text(t) => assert!(t.as_str().contains("nicht authentifiziert"), "{t}"),
            other => panic!("erwartete Fehler-Reply, bekam {other:?}"),
        }
        // Nichts durfte an die stdin-Senke gehen.
        assert!(
            tokio::time::timeout(Duration::from_millis(300), fwd_rx.recv()).await.is_err(),
            "vor Auth durfte nichts geforwardet werden"
        );
        accept.abort();
    }

    #[test]
    fn validate_accepts_known_command() {
        let f = r#"{"v":1,"id":"x","ts":0,"channel":"command","msg":{"type":"poll_project"}}"#;
        let out = validate_command(f).expect("gültig");
        assert!(out.contains(r#""type":"poll_project""#));
        assert!(!out.contains("channel")); // Envelope entfernt
    }

    #[test]
    fn validate_rejects_unknown_type() {
        assert!(validate_command(r#"{"channel":"command","msg":{"type":"rm_rf"}}"#).is_err());
    }

    #[test]
    fn validate_rejects_non_command_channel() {
        // Ein Client darf keine `event`/`snapshot`-Frames an den stdin schmuggeln.
        assert!(validate_command(r#"{"channel":"event","msg":{"type":"poll_project"}}"#).is_err());
    }

    #[test]
    fn validate_rejects_bypass_permissions() {
        let f = r#"{"channel":"command","msg":{"type":"start_agent","agentId":"a","prompt":"p","permissionMode":"bypassPermissions"}}"#;
        assert!(validate_command(f).is_err());
    }

    #[test]
    fn validate_rejects_dont_ask_mode() {
        let f = r#"{"channel":"command","msg":{"type":"set_permission_mode","agentId":"a","mode":"dontAsk"}}"#;
        assert!(validate_command(f).is_err());
    }

    #[test]
    fn validate_allows_safe_permission_mode() {
        let f = r#"{"channel":"command","msg":{"type":"start_agent","agentId":"a","prompt":"p","permissionMode":"default"}}"#;
        assert!(validate_command(f).is_ok());
    }

    #[test]
    fn validate_normalizes_away_raw_newline() {
        // Eingebettetes Newline in einem String-Feld darf NICHT als rohe Zeile in stdin landen
        // (NDJSON-Injection) — kanonisches JSON escaped es zu \n.
        let f = "{\"channel\":\"command\",\"msg\":{\"type\":\"send_input\",\"agentId\":\"a\",\"text\":\"a\\nb\"}}";
        let out = validate_command(f).expect("gültig");
        assert!(!out.contains('\n'), "kanonisch: kein rohes Newline");
    }

    #[test]
    fn validate_rejects_malformed_json() {
        assert!(validate_command("nicht json").is_err());
    }

    // ── file-rpc (P1.1) ──────────────────────────────────────────────────────────────────────

    #[test]
    fn file_rpc_read_dir_without_root_is_error_reply() {
        let fs = files::FsScope::default();
        let reply = file_rpc_reply(
            &serde_json::json!({"id":"r1","channel":"file-rpc","op":"read_dir","args":{"path":"/tmp"}}),
            &fs,
        );
        assert!(reply.contains(r#""ok":false"#), "{reply}");
        assert!(reply.contains(r#""id":"r1""#));
        assert!(reply.contains(r#""channel":"file-rpc-reply""#));
    }

    #[test]
    fn file_rpc_unknown_op_is_error_reply() {
        let fs = files::FsScope::default();
        let reply = file_rpc_reply(&serde_json::json!({"id":"r2","op":"delete_everything","args":{}}), &fs);
        assert!(reply.contains(r#""ok":false"#), "{reply}");
    }

    #[test]
    fn file_rpc_register_then_read_dir_in_scope() {
        // Das Crate-Verzeichnis ist ein echter, valider, registrierbarer Root (kein Deny/System).
        let root = env!("CARGO_MANIFEST_DIR");
        let fs = files::FsScope::default();

        // (1) read_dir VOR register_root → Fehler (leerer Scope = §9.5-Default).
        let pre = file_rpc_reply(&serde_json::json!({"id":"0","op":"read_dir","args":{"path":root}}), &fs);
        assert!(pre.contains(r#""ok":false"#), "{pre}");

        // (2) register_root → ok.
        let reg = file_rpc_reply(&serde_json::json!({"id":"1","op":"register_root","args":{"path":root}}), &fs);
        assert!(reg.contains(r#""ok":true"#), "{reg}");

        // (3) read_dir → jetzt in-scope, sieht Cargo.toml.
        let ls = file_rpc_reply(&serde_json::json!({"id":"2","op":"read_dir","args":{"path":root}}), &fs);
        assert!(ls.contains(r#""ok":true"#) && ls.contains("Cargo.toml"), "{ls}");
    }

    #[test]
    fn file_rpc_write_file_saves_and_detects_conflict() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let fname = format!(".p32-test-{}.md", std::process::id());
        let path = dir.join(&fname);
        let _ = std::fs::remove_file(&path);

        let fs = files::FsScope::default();
        let reg = file_rpc_reply(&serde_json::json!({"id":"1","op":"register_root","args":{"path": dir.to_string_lossy()}}), &fs);
        assert!(reg.contains(r#""ok":true"#), "{reg}");

        // Neue Datei (keine base) → saved.
        let w = file_rpc_reply(&serde_json::json!({"id":"2","op":"write_file","args":{
            "path": path.to_string_lossy(), "content": "# hallo", "baseMtimeMs": 0, "baseSize": 0, "baseHash": ""
        }}), &fs);
        assert!(w.contains(r#""ok":true"#) && w.contains(r#""kind":"saved""#), "{w}");

        // Erneut mit FALSCHER base (Datei existiert jetzt) → conflict.
        let c = file_rpc_reply(&serde_json::json!({"id":"3","op":"write_file","args":{
            "path": path.to_string_lossy(), "content": "# anders", "baseMtimeMs": 1.0, "baseSize": 99, "baseHash": "wrong"
        }}), &fs);
        assert!(c.contains(r#""kind":"conflict""#), "{c}");

        let _ = std::fs::remove_file(&path);
    }

    /// mDNS-Advertise startet ohne Fehler und registriert den Service. Multicast ist in manchen
    /// CI-/Sandbox-Umgebungen gesperrt → toleriert einen `ServiceDaemon`-Fehler, statt hart zu failen.
    #[tokio::test]
    async fn advertise_starts_or_is_sandboxed() {
        match advertise(12345, "deadbeef".repeat(8).as_str(), "test") {
            Ok(daemon) => { let _ = daemon.shutdown(); }
            Err(e) => eprintln!("[test] mDNS in dieser Umgebung nicht verfügbar (ok in Sandbox): {e}"),
        }
    }
}
