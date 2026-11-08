//! Local Pi RPC transport. Raw protocol, stderr, and credentials are never persisted.
#[path = "telemetry.rs"]
mod telemetry;

use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, mpsc};

pub enum Event {
    Text(String),
    Tool(String),
    Render(String),
    Built,
    AttemptStart,
    AttemptEnd { text: String, failed: bool },
    Done,
    Failed,
    Unknown,
}

pub struct Bridge {
    child: std::process::Child,
    commands: mpsc::SyncSender<Value>,
    pub events: mpsc::Receiver<Event>,
    sequence: u64,
    trace: telemetry::Trace,
}

impl Bridge {
    pub fn start() -> Result<Self, ()> {
        let trace = telemetry::Trace::new();
        trace.event("pi.session", "starting");
        let root = crate::relaunch::root();
        let prompt = std::fs::read_to_string(root.join("prompt.txt"))
            .unwrap_or_else(|_| include_str!("../prompt.txt").into());
        let mut child = Command::new("pi")
            .current_dir(&root)
            .env("COMPUTAH_PROJECT_ROOT", &root)
            .arg("--extension")
            .arg(root.join("scripts/self-tools.ts"))
            .args([
                "--mode",
                "rpc",
                "--no-session",
                "--no-builtin-tools",
                "--no-extensions",
                "--no-skills",
                "--no-prompt-templates",
                "--no-themes",
                "--no-mcp",
                "--no-context-files",
                "--thinking",
                "low",
                "--system-prompt",
                &prompt,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| trace.event("pi.session", "spawn_failed"))?;
        let mut input = child.stdin.take().ok_or(())?;
        let output = child.stdout.take().ok_or(())?;
        let (tx, events) = mpsc::channel();
        let (commands, pending) = mpsc::sync_channel::<Value>(8);
        let write_events = tx.clone();
        let write_trace = trace.clone();
        // A stalled Pi must never block a UI callback. Killing the child closes its pipe
        // and releases this worker even if an OS write was blocked.
        std::thread::spawn(move || {
            while let Ok(record) = pending.recv() {
                if writeln!(input, "{record}")
                    .and_then(|_| input.flush())
                    .is_err()
                {
                    write_trace.event("pi.write", "failed");
                    let _ = write_events.send(Event::Unknown);
                    break;
                }
            }
        });
        let read_trace = trace.clone();
        std::thread::spawn(move || {
            // read_until uses LF only, unlike generic Unicode line splitting.
            let mut reader = BufReader::new(output);
            let mut bytes = Vec::new();
            loop {
                bytes.clear();
                match reader.read_until(b'\n', &mut bytes) {
                    Ok(0) | Err(_) => break,
                    _ => {}
                }
                if let Ok(v) = serde_json::from_slice::<Value>(&bytes)
                    && let Some(e) = decode(&v)
                {
                    match &e {
                        Event::AttemptStart => read_trace.event("pi.attempt", "started"),
                        Event::AttemptEnd { failed, .. } => {
                            read_trace.event("pi.attempt", if *failed { "failed" } else { "ended" })
                        }
                        Event::Done => read_trace.event("pi.turn", "settled"),
                        Event::Failed => read_trace.event("pi.response", "failed"),
                        Event::Built => read_trace.event("pi.build", "verified"),
                        Event::Render(_) => read_trace.event("pi.render", "materialized"),
                        _ => {}
                    }
                    let _ = tx.send(e);
                }
            }
            read_trace.event("pi.read", "closed");
            let _ = tx.send(Event::Unknown);
        });
        trace.event("pi.session", "ready");
        Ok(Self {
            child,
            commands,
            events,
            sequence: 0,
            trace,
        })
    }

    pub fn prompt(&mut self, prompt: &str) -> Result<(), ()> {
        self.sequence += 1;
        let result = self.write(
            json!({"id":format!("turn-{}", self.sequence), "type":"prompt", "message":prompt}),
        );
        self.trace.event(
            "pi.prompt",
            if result.is_ok() { "queued" } else { "rejected" },
        );
        result
    }
    pub fn cancel(&mut self) -> Result<(), ()> {
        self.sequence += 1;
        let result = self.write(json!({"id":format!("cancel-{}", self.sequence), "type":"abort"}));
        self.trace.event(
            "pi.cancel",
            if result.is_ok() { "queued" } else { "rejected" },
        );
        result
    }
    fn write(&mut self, record: Value) -> Result<(), ()> {
        self.commands.try_send(record).map_err(|_| ())
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        let _ = self.child.kill();
        self.trace.event(
            "pi.session",
            if self.child.wait().is_ok() {
                "reaped"
            } else {
                "reap_failed"
            },
        );
    }
}

pub fn decode(v: &Value) -> Option<Event> {
    match v["type"].as_str()? {
        "tool_execution_start" | "tool_execution_update" => {
            v["toolName"].as_str().map(|name| Event::Tool(name.into()))
        }
        "tool_execution_end" if v["isError"] != true => {
            let details = &v["result"]["details"];
            if details["computah_build"] == true {
                Some(Event::Built)
            } else {
                details
                    .get("computah_reply")
                    .map(|reply| Event::Render(reply.to_string()))
            }
        }
        "message_start" if v["message"]["role"] == "assistant" => Some(Event::AttemptStart),
        "message_end" if v["message"]["role"] == "assistant" => {
            let text = v["message"]["content"]
                .as_array()
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter(|b| b["type"] == "text")
                        .filter_map(|b| b["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("")
                })
                .unwrap_or_default();
            Some(Event::AttemptEnd {
                text,
                failed: v["message"]["stopReason"] == "error",
            })
        }
        "message_update" if v["assistantMessageEvent"]["type"] == "text_delta" => {
            v["assistantMessageEvent"]["delta"]
                .as_str()
                .map(|s| Event::Text(s.into()))
        }
        "agent_settled" => Some(Event::Done),
        "response" if v["success"] == false => Some(Event::Failed),
        _ => None,
    }
}

pub type Shared = Arc<Mutex<Option<Bridge>>>;
