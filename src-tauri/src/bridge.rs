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
fn validate_command(frame: &str) -> Result<String, String> {
    let env: serde_json::Value = serde_json::from_str(frame).map_err(|_| "kein gültiges JSON".to_string())?;

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

/// Bridge starten: Zert laden/erzeugen (persistiert → stabiler Pin über Neustarts), TCP auf einem
/// ephemeren Port binden (Multi-Instanz-freundlich), mDNS advertisen, Accept-Loop spawnen.
/// `tee` = Sender des Sidecar-stdout-Broadcasts; pro Client wird `tee.subscribe()` aufgerufen.
pub async fn start(tee: broadcast::Sender<String>, forward: CommandSink, cert_dir: PathBuf, project: String) -> BridgeResult<Bridge> {
    let cert = load_or_generate_cert(&cert_dir)?;
    let spki_fp_hex = hex_lower(&cert.spki_fp);
    let tls_config = make_server_config(cert.cert_der, cert.key_der)?;

    let (port, accept) = bind_and_serve(tls_config, tee, forward).await?;
    let mdns = advertise(port, &spki_fp_hex, &project)?;

    Ok(Bridge { port, spki_fp_hex, accept, mdns })
}

/// Testbarer Kern OHNE mDNS: auf allen Interfaces binden (der iPad im LAN muss uns erreichen;
/// ephemerer Port = Multi-Instanz-freundlich), Accept-Loop spawnen. Gibt (Port, Accept-Handle)
/// zurück.
async fn bind_and_serve(tls_config: Arc<ServerConfig>, tee: broadcast::Sender<String>, forward: CommandSink) -> BridgeResult<(u16, tokio::task::JoinHandle<()>)> {
    let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).await?;
    let port = listener.local_addr()?.port();
    let acceptor = TlsAcceptor::from(tls_config);
    let accept = tokio::spawn(accept_loop(listener, acceptor, tee, forward));
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

async fn accept_loop(listener: TcpListener, acceptor: TlsAcceptor, tee: broadcast::Sender<String>, forward: CommandSink) {
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
        tokio::spawn(async move {
            if let Err(e) = handle_conn(tcp, acceptor, rx, forward).await {
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
async fn handle_conn(tcp: TcpStream, acceptor: TlsAcceptor, mut rx: broadcast::Receiver<String>, forward: CommandSink) -> BridgeResult<()> {
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

    let mut heartbeat = tokio::time::interval(HEARTBEAT);
    heartbeat.tick().await; // erster Tick feuert sofort — überspringen

    loop {
        tokio::select! {
            tee_line = rx.recv() => match tee_line {
                Ok(line) => sink.send(Message::text(line)).await?,
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    // Client zu langsam → n Zeilen verworfen; der Client re-synct später via request_snapshot.
                    eprintln!("[mads:bridge] Client hinkt {n} Zeilen hinterher (verworfen)");
                }
                Err(broadcast::error::RecvError::Closed) => break, // Sidecar-stdout endete
            },
            _ = heartbeat.tick() => sink.send(Message::Ping(Vec::<u8>::new().into())).await?,
            incoming = source.next() => match incoming {
                Some(Ok(Message::Text(t))) => match validate_command(t.as_str()) {
                    Ok(line) => {
                        if let Err(e) = forward(&line) {
                            eprintln!("[mads:bridge] Forward an Sidecar fehlgeschlagen: {e}");
                        }
                    }
                    Err(reason) => eprintln!("[mads:bridge] Command abgelehnt: {reason}"),
                },
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => { /* Ping/Pong/Binary: in P0.3 ignorieren (Binär-Frames erst OE-R6) */ }
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

    /// P0.2: der stdout-Tee erreicht einen TLS-WSS-Client end-to-end (Zert + Handshake + Broadcast).
    #[tokio::test]
    async fn tee_reaches_tls_ws_client() {
        let (tee, _keep) = broadcast::channel::<String>(64);
        let (port, accept) = bind_and_serve(test_config(), tee.clone(), noop_sink()).await.expect("bind_and_serve");

        let ws = connect_ws_client(port).await;
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
        let (tee, _keep) = broadcast::channel::<String>(64);
        let (fwd_tx, mut fwd_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let forward: CommandSink = Arc::new(move |line: &str| fwd_tx.send(line.to_string()).map_err(|e| e.to_string()));
        let (port, accept) = bind_and_serve(test_config(), tee, forward).await.expect("bind_and_serve");

        let ws = connect_ws_client(port).await;
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
