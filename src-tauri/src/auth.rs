//! Pairing + Geräte-Token für die Remote-Bridge (docs/design/remote-companion-app.md §9).
//!
//! Modell: mads zeigt einen einmaligen **PIN** (60 s TTL, ≤5 Versuche). Der Client löst ihn ein und
//! erhält ein langlebiges, widerrufbares **Geräte-Token** im Format `"<deviceId>.<secret>"`:
//!   - `deviceId` (Klartext) = Lookup-Key in der SQLite-Tabelle,
//!   - `secret` (≥256-bit CSPRNG) wird **Argon2id**-gehasht gespeichert und beim Verify gegen den
//!     Hash geprüft (Argon2-Verify ist constant-time; kein manueller Vergleich nötig).
//! Nur der Hash liegt in der DB — das Klartext-Token existiert nur einmal beim Pairing.

use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use rand::rngs::OsRng;
use rand::{Rng, RngCore, TryRngCore};
use rusqlite::Connection;
use serde::Serialize;

const PIN_TTL: Duration = Duration::from_secs(60);
const PIN_MAX_ATTEMPTS: u32 = 5;

/// Ein gekoppeltes Gerät (für die mads-Geräteliste / Widerruf-UI). Ohne Secret/Hash.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub last_seen: Option<i64>,
}

struct PendingPin {
    pin: String,
    expires_at: SystemTime,
    attempts: u32,
}

/// Auth-Zustand: SQLite-Geräte-Tabelle + der aktuell gültige (einmalige) Pairing-PIN.
pub struct AuthState {
    db: Mutex<Connection>,
    pin: Mutex<Option<PendingPin>>,
}

impl AuthState {
    /// Öffnet/erstellt die Datei-DB (Eltern-Verzeichnis wird angelegt).
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        Self::init(Connection::open(path).map_err(|e| e.to_string())?)
    }

    fn init(conn: Connection) -> Result<Self, String> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS devices (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                secret_hash TEXT NOT NULL,
                created_at  INTEGER NOT NULL,
                last_seen   INTEGER,
                revoked     INTEGER NOT NULL DEFAULT 0
            );",
        )
        .map_err(|e| e.to_string())?;
        Ok(Self { db: Mutex::new(conn), pin: Mutex::new(None) })
    }

    /// In-Memory-DB (Tests, auch aus Nachbarmodulen wie `bridge`).
    #[cfg(test)]
    pub(crate) fn in_memory() -> Self {
        Self::init(Connection::open_in_memory().unwrap()).unwrap()
    }

    /// Einen 6-stelligen PIN ausgeben (überschreibt einen evtl. offenen), 60 s gültig, ≤5 Versuche.
    pub fn issue_pin(&self) -> String {
        let pin = format!("{:06}", OsRng.unwrap_err().random_range(0u32..1_000_000));
        *self.pin.lock().unwrap() = Some(PendingPin {
            pin: pin.clone(),
            expires_at: SystemTime::now() + PIN_TTL,
            attempts: 0,
        });
        pin
    }

    /// PIN einlösen → neues Geräte-Token (nur hier im Klartext). Verbraucht den PIN bei Erfolg.
    pub fn redeem_pin(&self, pin: &str, device_name: &str) -> Result<String, String> {
        {
            let mut guard = self.pin.lock().unwrap();
            let pending = guard.as_mut().ok_or("Kein aktiver Pairing-Code")?;
            if SystemTime::now() > pending.expires_at {
                *guard = None;
                return Err("Pairing-Code abgelaufen".into());
            }
            if pending.attempts >= PIN_MAX_ATTEMPTS {
                *guard = None;
                return Err("Zu viele Fehlversuche — neuen Code anfordern".into());
            }
            if pending.pin.as_bytes() != pin.as_bytes() {
                pending.attempts += 1;
                return Err("Falscher Pairing-Code".into());
            }
            *guard = None; // Erfolg → PIN ist verbraucht
        }

        let device_id = hex_rand(16);
        let secret = hex_rand(32); // ≥256-bit
        let hash = hash_secret(&secret)?;
        let now = now_ms();
        self.db
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO devices (id, name, secret_hash, created_at, revoked) VALUES (?1, ?2, ?3, ?4, 0)",
                rusqlite::params![device_id, device_name, hash, now],
            )
            .map_err(|e| e.to_string())?;
        Ok(format!("{device_id}.{secret}"))
    }

    /// Token verifizieren → gibt bei Erfolg die `deviceId` zurück (und aktualisiert `last_seen`).
    /// Fehlermeldungen bleiben generisch (kein Existenz-Orakel über den Hash hinaus).
    pub fn verify_token(&self, token: &str) -> Result<String, String> {
        let (device_id, secret) = token.split_once('.').ok_or("Token-Format ungültig")?;

        // Hash + revoked kurz unter dem Lock holen, teures Argon2-Verify AUSSERHALB des Locks.
        let (secret_hash, revoked): (String, i64) = {
            let conn = self.db.lock().unwrap();
            conn.query_row(
                "SELECT secret_hash, revoked FROM devices WHERE id = ?1",
                rusqlite::params![device_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|_| "Token ungültig".to_string())?
        };
        if revoked != 0 {
            return Err("Gerät widerrufen".into());
        }
        let parsed = PasswordHash::new(&secret_hash).map_err(|e| e.to_string())?;
        Argon2::default()
            .verify_password(secret.as_bytes(), &parsed)
            .map_err(|_| "Token ungültig".to_string())?;

        let _ = self
            .db
            .lock()
            .unwrap()
            .execute("UPDATE devices SET last_seen = ?1 WHERE id = ?2", rusqlite::params![now_ms(), device_id]);
        Ok(device_id.to_string())
    }

    /// Ist das Gerät widerrufen (oder unbekannt)? Fail-closed: unbekannt ⇒ als widerrufen behandeln.
    /// Genutzt für den periodischen In-Flight-Check (Widerruf trennt laufende Verbindungen).
    pub fn is_revoked(&self, device_id: &str) -> bool {
        let conn = self.db.lock().unwrap();
        conn.query_row("SELECT revoked FROM devices WHERE id = ?1", rusqlite::params![device_id], |r| {
            r.get::<_, i64>(0)
        })
        .map(|v| v != 0)
        .unwrap_or(true)
    }

    pub fn list_devices(&self) -> Result<Vec<DeviceInfo>, String> {
        let conn = self.db.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, name, created_at, last_seen FROM devices WHERE revoked = 0 ORDER BY created_at DESC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(DeviceInfo { id: r.get(0)?, name: r.get(1)?, created_at: r.get(2)?, last_seen: r.get(3)? })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn revoke_device(&self, id: &str) -> Result<(), String> {
        let n = self
            .db
            .lock()
            .unwrap()
            .execute("UPDATE devices SET revoked = 1 WHERE id = ?1", rusqlite::params![id])
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("Gerät nicht gefunden".into());
        }
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────── Helpers

fn hash_secret(secret: &str) -> Result<String, String> {
    let mut salt_bytes = [0u8; 16];
    OsRng.unwrap_err().fill_bytes(&mut salt_bytes);
    let salt = SaltString::encode_b64(&salt_bytes).map_err(|e| e.to_string())?;
    Ok(Argon2::default()
        .hash_password(secret.as_bytes(), &salt)
        .map_err(|e| e.to_string())?
        .to_string())
}

fn hex_rand(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    OsRng.unwrap_err().fill_bytes(&mut buf);
    use std::fmt::Write;
    let mut s = String::with_capacity(bytes * 2);
    for b in buf {
        let _ = write!(s, "{b:02x}");
    }
    s
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> AuthState {
        AuthState::init(Connection::open_in_memory().unwrap()).unwrap()
    }

    #[test]
    fn pin_roundtrip_yields_verifiable_token() {
        let auth = mem();
        let pin = auth.issue_pin();
        assert_eq!(pin.len(), 6);
        let token = auth.redeem_pin(&pin, "iPad").expect("redeem");
        let device_id = auth.verify_token(&token).expect("verify");
        assert!(token.starts_with(&device_id));
        // Gerät erscheint in der Liste.
        assert_eq!(auth.list_devices().unwrap().len(), 1);
    }

    #[test]
    fn wrong_pin_is_rejected_and_counts_attempts() {
        let auth = mem();
        let _pin = auth.issue_pin();
        for _ in 0..5 {
            assert!(auth.redeem_pin("000000", "x").is_err());
        }
        // Nach 5 Fehlversuchen ist der PIN gesperrt — auch der korrekte greift nicht mehr.
        assert!(auth.redeem_pin(&_pin, "x").is_err());
    }

    #[test]
    fn pin_is_single_use() {
        let auth = mem();
        let pin = auth.issue_pin();
        assert!(auth.redeem_pin(&pin, "a").is_ok());
        assert!(auth.redeem_pin(&pin, "b").is_err()); // schon verbraucht
    }

    #[test]
    fn revoked_device_fails_verify() {
        let auth = mem();
        let pin = auth.issue_pin();
        let token = auth.redeem_pin(&pin, "iPhone").unwrap();
        let device_id = auth.verify_token(&token).unwrap();
        auth.revoke_device(&device_id).unwrap();
        assert!(auth.is_revoked(&device_id));
        assert!(auth.verify_token(&token).is_err());
        assert!(auth.list_devices().unwrap().is_empty()); // widerrufene sind ausgeblendet
    }

    #[test]
    fn bogus_and_malformed_tokens_fail() {
        let auth = mem();
        assert!(auth.verify_token("kein-punkt").is_err());
        assert!(auth.verify_token("deadbeef.secret").is_err()); // unbekannte deviceId
        assert!(auth.is_revoked("deadbeef")); // unbekannt ⇒ fail-closed
    }
}
