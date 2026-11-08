//! Content-free local bridge events. No remote exporter or credentials.
use serde::Serialize;
use std::io::Write;
use std::sync::{
    OnceLock,
    atomic::{AtomicU64, Ordering},
    mpsc,
};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[derive(Serialize)]
struct Record {
    service: &'static str,
    session: String,
    operation: &'static str,
    outcome: &'static str,
    elapsed_us: u128,
}

#[derive(Clone)]
pub struct Trace {
    id: String,
    started: Instant,
}

impl Trace {
    pub fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let epoch = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        Self {
            id: format!("{epoch:x}-{:x}", NEXT.fetch_add(1, Ordering::Relaxed)),
            started: Instant::now(),
        }
    }

    // Call sites supply code-owned categories only; no model/protocol data enters records.
    pub fn event(&self, operation: &'static str, outcome: &'static str) {
        static SINK: OnceLock<Option<mpsc::SyncSender<Record>>> = OnceLock::new();
        let sink = SINK.get_or_init(|| {
            let home = std::env::var_os("HOME")?;
            let folder = std::path::PathBuf::from(home).join(if cfg!(target_os = "macos") {
                "Library/Application Support/Computah"
            } else {
                ".local/share/computah"
            });
            let (sender, records) = mpsc::sync_channel::<Record>(128);
            std::thread::Builder::new()
                .name("computah-events".into())
                .spawn(move || {
                    let path = folder.join("events.jsonl");
                    for record in records {
                        let _ = (|| -> std::io::Result<()> {
                            std::fs::create_dir_all(&folder)?;
                            let mut lock_options = std::fs::OpenOptions::new();
                            lock_options
                                .create(true)
                                .truncate(false)
                                .read(true)
                                .write(true);
                            #[cfg(unix)]
                            {
                                use std::os::unix::fs::OpenOptionsExt;
                                lock_options.mode(0o600);
                            }
                            let lock = lock_options.open(folder.join("events.lock"))?;
                            // A stable cross-process lock covers rotation and the whole record.
                            // Contention drops this event rather than blocking any writer.
                            lock.try_lock().map_err(std::io::Error::other)?;
                            if std::fs::metadata(&path).is_ok_and(|m| m.len() >= 512 * 1024) {
                                std::fs::rename(&path, folder.join("events.previous.jsonl"))?;
                            }
                            let mut options = std::fs::OpenOptions::new();
                            options.create(true).append(true);
                            #[cfg(unix)]
                            {
                                use std::os::unix::fs::OpenOptionsExt;
                                options.mode(0o600);
                            }
                            let mut file = options.open(&path)?;
                            serde_json::to_writer(&mut file, &record)?;
                            file.write_all(b"\n")
                        })(); // Fail-open: a full/damaged log never prevents chat or cancellation.
                    }
                })
                .ok()?;
            Some(sender)
        });
        if let Some(sink) = sink {
            let _ = sink.try_send(Record {
                service: "rune-pi",
                session: self.id.clone(),
                operation,
                outcome,
                elapsed_us: self.started.elapsed().as_micros(),
            });
        }
    }
}
