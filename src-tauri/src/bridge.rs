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
pub async fn start(tee: broadcast::Sender<String>, cert_dir: PathBuf, project: String) -> BridgeResult<Bridge> {
    let cert = load_or_generate_cert(&cert_dir)?;
    let spki_fp_hex = hex_lower(&cert.spki_fp);
    let tls_config = make_server_config(cert.cert_der, cert.key_der)?;

    let (port, accept) = bind_and_serve(tls_config, tee).await?;
    let mdns = advertise(port, &spki_fp_hex, &project)?;

    Ok(Bridge { port, spki_fp_hex, accept, mdns })
}

/// Testbarer Kern OHNE mDNS: auf allen Interfaces binden (der iPad im LAN muss uns erreichen;
/// ephemerer Port = Multi-Instanz-freundlich), Accept-Loop spawnen. Gibt (Port, Accept-Handle)
/// zurück.
async fn bind_and_serve(tls_config: Arc<ServerConfig>, tee: broadcast::Sender<String>) -> BridgeResult<(u16, tokio::task::JoinHandle<()>)> {
    let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).await?;
    let port = listener.local_addr()?.port();
    let acceptor = TlsAcceptor::from(tls_config);
    let accept = tokio::spawn(accept_loop(listener, acceptor, tee));
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

async fn accept_loop(listener: TcpListener, acceptor: TlsAcceptor, tee: broadcast::Sender<String>) {
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
        tokio::spawn(async move {
            if let Err(e) = handle_conn(tcp, acceptor, rx).await {
                eprintln!("[mads:bridge] Verbindung {peer} beendet: {e}");
            }
        });
    }
}

/// Eine Client-Verbindung: TLS-Accept → WSS-Handshake (mit Anti-CSWSH-Origin-Check) → roher
/// stdout-Tee an den Client + Heartbeat. P0.2 ist read-only: Client→Server-Frames werden verworfen
/// (Command-Forward kommt in P0.3), Close/Fehler beenden die Schleife.
async fn handle_conn(tcp: TcpStream, acceptor: TlsAcceptor, mut rx: broadcast::Receiver<String>) -> BridgeResult<()> {
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
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => { /* P0.2 read-only: ignorieren (P0.3 forwarded HostMessages) */ }
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

    /// TEST-ONLY: akzeptiert jedes Server-Zert (wir testen den Transport, nicht das Pinning —
    /// das SPKI-Pinning lebt im iOS-Client). NIEMALS in Produktion.
    #[derive(Debug)]
    struct AcceptAnyServerCert(Arc<rustls::crypto::CryptoProvider>);

    impl ServerCertVerifier for AcceptAnyServerCert {
        fn verify_server_cert(
            &self,
            _end_entity: &CertificateDer<'_>,
            _intermediates: &[CertificateDer<'_>],
            _server_name: &ServerName<'_>,
            _ocsp: &[u8],
            _now: UnixTime,
        ) -> Result<ServerCertVerified, rustls::Error> {
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

    #[tokio::test]
    async fn tee_reaches_tls_ws_client() {
        // Hermetisch: frisches Zert erzeugen + bind_and_serve (KEIN mDNS — Multicast ist in
        // Sandboxes oft gesperrt und für diesen Transport-Test irrelevant).
        let (cert_der_bytes, key_pkcs8, fp) = generate_cert().expect("cert gen");
        assert_eq!(fp.len(), 32);
        let cfg = make_server_config(
            CertificateDer::from(cert_der_bytes),
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_pkcs8)),
        )
        .expect("server config");

        let (tee, _keep) = broadcast::channel::<String>(64);
        let (port, accept) = bind_and_serve(cfg, tee.clone()).await.expect("bind_and_serve");

        // --- TLS-1.3-WSS-Client (skip-verify, test-only) ---
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
        let (mut _sink, mut source) = ws.split();

        // Eine Zeile in den Tee schieben — muss roh beim Client ankommen.
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

    // Alias, um den Client-Connector klar vom Server-`TlsAcceptor` zu trennen.
    use tokio_rustls::TlsConnector as TlsConnectorClient;

    /// mDNS-Advertise startet ohne Fehler und registriert den Service. Multicast ist in manchen
    /// CI-/Sandbox-Umgebungen gesperrt → toleriert einen `ServiceDaemon`-Fehler, statt hart zu failen.
    #[tokio::test]
    async fn advertise_starts_or_is_sandboxed() {
        match advertise(12345, "deadbeef".repeat(8).as_str(), "test") {
            Ok(daemon) => {
                let _ = daemon.shutdown();
            }
            Err(e) => {
                eprintln!("[test] mDNS in dieser Umgebung nicht verfügbar (ok in Sandbox): {e}");
            }
        }
    }
}
