use serde_json::Value;
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
};

pub struct Host {
    child: Child,
    input: ChildStdin,
    pub events: Receiver<Value>,
}

pub fn app_root() -> std::path::PathBuf {
    std::env::var_os("COMPUTAH_APP_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

impl Host {
    pub fn start(demo: bool, state: &std::path::Path) -> std::io::Result<Self> {
        // The installed bundle supplies its own assets/dependencies; it must not
        // depend on the machine or checkout where this binary was compiled.
        let root = app_root();
        let mut command = Command::new("node");
        command
            .current_dir(&root)
            .args(["--import", "tsx"])
            .arg(root.join("scripts/host.mjs"));
        if demo {
            command.arg("--demo");
        }
        command.env("COMPUTAH_OUTBOX", state.with_extension("outbox.json"));
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let (send, events) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                if line.len() > 8 * 1024 * 1024 {
                    break;
                }
                if let Ok(event) = serde_json::from_str(&line)
                    && send.send(event).is_err()
                {
                    break;
                }
            }
            let _=send.send(serde_json::json!({"type":"error","text":"Connection closed · remote work may continue; restart and Retry"}));
        });
        Ok(Self {
            child,
            input,
            events,
        })
    }
    pub fn send(&mut self, command: Value) -> std::io::Result<()> {
        writeln!(self.input, "{command}")?;
        self.input.flush()
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
