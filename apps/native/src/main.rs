mod document;
mod host;

use document::{Document, Node};
use rune::{
    AppSpec, Color, Cx, El, ScrollSpec, TextEdit, TextStyle, Tx, col, el, row, text, text_input,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{path::PathBuf, time::Duration};

#[derive(Clone, Serialize, Deserialize)]
struct Message {
    id: String,
    role: String,
    content: String,
    #[serde(default)]
    cards: Vec<Node>,
    #[serde(default)]
    ingress: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Saved {
    version: u32,
    document: Document,
    previous: Option<Document>,
    draft: String,
    // Only synthetic demo messages are cached. Real history stays on the durable core.
    demo_messages: Vec<Message>,
}

struct State {
    document: Document,
    previous: Option<Document>,
    draft: TextEdit,
    messages: Vec<Message>,
    status: String,
    busy: bool,
    ready: bool,
    unsettled: bool,
    demo: bool,
    panels: bool,
    host: Option<host::Host>,
    storage: Option<PathBuf>,
    saved: String,
    sort: Option<(String, usize, bool)>,
}

fn demo_messages() -> Vec<Message> {
    vec![
        Message{id:"demo-user".into(),role:"user".into(),content:"Let’s keep Friday pretty relaxed.".into(),cards:vec![],ingress:None},
        Message{id:"demo-slack".into(),role:"user".into(),content:"@Computah could you find a quieter place for Friday? Somewhere we can actually talk.".into(),cards:vec![],ingress:Some("Laura via Slack · #friday-plans · 9:41".into())},
        Message{id:"demo-assistant".into(),role:"assistant".into(),content:"Laura’s looking for a quieter spot. I’m checking a few options.".into(),cards:vec![],ingress:None},
    ]
}

impl Default for State {
    fn default() -> Self {
        Self {
            document: document::default_document(),
            previous: None,
            draft: TextEdit::default(),
            messages: demo_messages(),
            status: "Demo · synthetic messages and panels".into(),
            busy: false,
            ready: true,
            unsettled: false,
            demo: true,
            panels: false,
            host: None,
            storage: None,
            saved: String::new(),
            sort: None,
        }
    }
}

fn state_path() -> PathBuf {
    let path = std::env::var_os("COMPUTAH_STATE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
            home.join(if cfg!(target_os = "macos") {
                "Library/Application Support/Computah Native"
            } else {
                ".local/share/computah-native"
            })
            .join(if std::env::args().any(|a| a == "--demo") {
                "demo.json"
            } else {
                "app.json"
            })
        });
    // The Node host changes cwd to its installed assets. Resolve once, without
    // canonicalizing a checkpoint that might not exist yet.
    std::path::absolute(path).expect("Cannot resolve the native state directory")
}

fn initial() -> State {
    let demo = std::env::args().any(|arg| arg == "--demo");
    let mut s = State {
        demo,
        ..State::default()
    };
    if !demo {
        s.ready = false;
        s.messages.clear();
        s.status = "Connecting to durable Computah…".into();
    }
    let capture =
        std::env::args().any(|arg| ["--snap", "--video", "--tree"].contains(&arg.as_str()));
    if !capture {
        s.storage = Some(state_path());
        if let Some(path) = &s.storage {
            match std::fs::read_to_string(path) {
                Ok(raw) => match serde_json::from_str::<Saved>(&raw) {
                    Ok(saved)
                        if saved.version == 1
                            && document::parse(
                                &serde_json::to_string(&saved.document).unwrap(),
                            )
                            .is_ok()
                            && saved.previous.as_ref().is_none_or(|p| {
                                document::parse(&serde_json::to_string(p).unwrap()).is_ok()
                            }) =>
                    {
                        s.document = saved.document;
                        s.previous = saved.previous;
                        s.draft = TextEdit::new(saved.draft);
                        if demo {
                            s.messages = saved.demo_messages;
                        }
                    }
                    _ => {
                        s.status =
                            "Saved composition invalid · file retained; using default".into();
                        s.storage = None;
                    }
                },
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => {
                    s.status = "Cannot read saved composition · file retained".into();
                    s.storage = None;
                }
            }
        }
        match host::Host::start(demo, &state_path()) {
            Ok(host) => s.host = Some(host),
            Err(_) => s.status = "Native host unavailable · check Node.js and dependencies".into(),
        }
    }
    s
}

fn persist(s: &mut State) -> bool {
    let Some(path) = s.storage.as_ref() else {
        return false;
    };
    let saved = Saved {
        version: 1,
        document: s.document.clone(),
        previous: s.previous.clone(),
        draft: s.draft.text.clone(),
        demo_messages: if s.demo { s.messages.clone() } else { vec![] },
    };
    let Ok(raw) = serde_json::to_string(&saved) else {
        return false;
    };
    if raw == s.saved {
        return true;
    }
    let result = (|| -> std::io::Result<()> {
        use std::io::Write;
        std::fs::create_dir_all(path.parent().unwrap())?;
        let temporary = path.with_extension("tmp");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(raw.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(temporary, path)
    })();
    if result.is_ok() {
        s.saved = raw;
    } else {
        s.status = "Could not save composition · changes remain in memory".into();
    }
    result.is_ok()
}

fn command(s: &mut State, value: Value) {
    if s.host.as_mut().is_none_or(|host| host.send(value).is_err()) {
        s.busy = false;
        s.status = "Host unavailable · remote work may continue; restart and Retry".into();
    }
}
fn submit(s: &mut State) {
    if !s.ready || s.busy || s.unsettled || s.draft.text.trim().is_empty() {
        return;
    }
    if s.draft.text.len() > 100000 {
        s.status = "Message too long · shorten it before sending".into();
        return;
    }
    let message = s.draft.text.clone();
    if s.demo {
        s.draft = TextEdit::default();
        s.messages.push(Message {
            id: format!("demo-{}", s.messages.len()),
            role: "user".into(),
            content: message.clone(),
            cards: vec![],
            ingress: None,
        });
    } else {
        s.unsettled = true;
    }
    s.busy = true;
    if s.demo && s.host.is_none() {
        let request = message.to_lowercase();
        fixture(
            s,
            if ["empty", "delete all", "remove everything"]
                .iter()
                .any(|word| request.contains(word))
            {
                "empty"
            } else if request.contains("table") || request.contains("compare") {
                "table"
            } else {
                "restaurant"
            },
        );
        return;
    }
    command(s, json!({"op":"send","text":message}));
}

fn activate(s: &mut State, input: &str) -> Result<(), &'static str> {
    let mut reply = document::parse_reply(input)?;
    fn scope(node: &mut Node, prefix: &str) {
        node.id = format!("{prefix}-{}", node.id);
        for child in &mut node.children {
            scope(child, prefix);
        }
    }
    for card in &mut reply.cards {
        scope(card, &format!("message-{}", s.messages.len()));
    }
    if let Some(app) = reply.app {
        s.previous = Some(std::mem::replace(&mut s.document, app));
    }
    s.messages.push(Message {
        id: format!("ui-{}", s.messages.len()),
        role: "assistant".into(),
        content: reply.message,
        cards: reply.cards,
        ingress: None,
    });
    if s.demo {
        s.busy = false;
    }
    s.status = if s.previous.is_some() {
        "Validated composition updated · Undo available"
    } else {
        "Validated inline UI added"
    }
    .into();
    Ok(())
}

fn projected(input: &Value) -> Vec<Message> {
    input
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let content = m["blocks"]
                .as_array()?
                .iter()
                .filter_map(|b| match b["kind"].as_str()? {
                    "text" => b["text"].as_str(),
                    "component" => b["fallback"].as_str(),
                    _ => Some("Unsupported content"),
                })
                .collect::<Vec<_>>()
                .join("\n");
            Some(Message {
                id: m["id"].as_str()?.into(),
                role: m["role"].as_str()?.into(),
                content,
                cards: vec![],
                ingress: None,
            })
        })
        .collect()
}

fn poll(s: &mut State, _: f64, tx: &mut Tx) -> bool {
    tx.wake_after(Duration::from_millis(100));
    let events = s
        .host
        .as_ref()
        .map(|h| h.events.try_iter().collect::<Vec<_>>())
        .unwrap_or_default();
    let mut changed = false;
    for event in events {
        changed = true;
        match event["type"].as_str().unwrap_or("") {
            "ui" => {
                if let Err(error) = activate(s, &event["reply"].to_string()) {
                    if s.demo {
                        s.busy = false;
                    }
                    s.status = error.into();
                }
            }
            "history" => s.messages = projected(&event["messages"]),
            "result" => {
                for message in projected(&event["messages"]) {
                    if let Some(existing) = s.messages.iter_mut().find(|m| m.id == message.id) {
                        *existing = message;
                    } else {
                        s.messages.push(message);
                    }
                }
                s.unsettled = false;
                s.status = format!("Request {}", event["outcome"].as_str().unwrap_or("settled"));
            }
            "pending" => {
                s.unsettled = true;
                if s.draft.text == event["text"].as_str().unwrap_or("") {
                    s.draft = TextEdit::default();
                }
                s.status = "Unsettled request recovered · Retry safely".into();
            }
            "ready" => s.ready = true,
            "busy" => s.busy = event["value"].as_bool().unwrap_or(false),
            "status" | "error" => {
                s.status = event["text"]
                    .as_str()
                    .unwrap_or("Connection unavailable")
                    .into();
                if event["type"] == "error" {
                    s.busy = false;
                    if event["pending"] == false {
                        s.unsettled = false;
                    }
                }
            }
            _ => {}
        }
    }
    let checkpointed = persist(s);
    if checkpointed && let Some(path) = s.storage.clone() {
        let marker = PathBuf::from(format!("{}.relaunch", path.display()));
        if marker.exists() {
            let verified = std::process::Command::new("node")
                .current_dir(host::app_root())
                .args(["--import", "tsx"])
                .arg(host::app_root().join("scripts/owner.mjs"))
                .arg("verify-candidate")
                .arg(&path)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|status| status.success());
            let _ = std::fs::remove_file(marker);
            if verified {
                let mut candidate = std::process::Command::new(
                    host::app_root().join("target/debug/computah-native"),
                );
                candidate.env("COMPUTAH_STATE", &path);
                if s.demo {
                    candidate.arg("--demo");
                }
                if candidate.spawn().is_ok() {
                    tx.quit();
                } else {
                    s.status = "Candidate could not launch · current app retained".into();
                }
            } else {
                s.status = "Candidate rejected checkpoint · current app retained".into();
            }
            changed = true;
        }
    }
    changed
}

fn hex(value: &str) -> Color {
    rune::color::hex(value).unwrap()
}
fn color(s: &State, which: &str) -> Color {
    hex(match which {
        "surface" => &s.document.theme.surface,
        "muted" => &s.document.theme.muted,
        "background" => &s.document.theme.background,
        _ => &s.document.theme.text,
    })
}
fn inherited_font(size: f32) -> TextStyle {
    let style = TEXT_STYLE.with(|current| current.borrow().clone());
    let mut font = TextStyle::new(
        style.font_size.unwrap_or(size),
        style.weight.unwrap_or(400.0),
    );
    if let Some(name) = &style.font_family {
        let family = FONT_NAMES.with(|names| {
            let mut names = names.borrow_mut();
            if let Some(name) = names.get(name) {
                return Some(*name);
            }
            if names.len() >= 128 {
                return None;
            }
            let family: &'static str = Box::leak(name.clone().into_boxed_str());
            names.insert(name.clone(), family);
            Some(family)
        });
        if let Some(name) = family {
            font = font.family(rune::tok::Family::Named(name));
        }
    }
    font
}
fn label(s: &State, value: impl Into<String>, size: f32) -> El {
    let style = TEXT_STYLE.with(|current| current.borrow().clone());
    text(value.into())
        .wrap_anywhere()
        .font(inherited_font(size))
        .color(
            style
                .color
                .as_deref()
                .map(hex)
                .unwrap_or_else(|| color(s, "text")),
        )
}

thread_local! {
    static TEXT_STYLE: std::cell::RefCell<document::Style> = Default::default();
    static FONT_NAMES: std::cell::RefCell<std::collections::HashMap<String, &'static str>> = Default::default();
}
fn button(s: &State, title: &str, key: &str, action: impl Fn(&mut State) + 'static) -> El {
    label(s, title, 13.0)
        .key(key)
        .role("button")
        .label(title)
        .focusable(true)
        .padding(12.0)
        .radius(24.0)
        .fill(color(s, "surface"))
        .on_press(action)
}

fn view(s: &State, cx: &mut Cx<State>) -> El {
    cx.foreground(color(s, "text"));
    cx.focus_ring(2.0, 2.0, hex("#80B8FF"));
    let narrow = cx
        .layout_with("native-root", |rect| rect[2] < 760.0)
        .unwrap_or(false);
    let recovery = row()
        .gap(8.0)
        .center_y()
        .child(
            button(s, "Undo", "undo", |s| {
                if let Some(previous) = s.previous.take() {
                    s.document = previous;
                    s.status = "Previous composition restored".into();
                }
            })
            .disabled(s.previous.is_none()),
        )
        .child(button(s, "Restore", "restore", |s| {
            s.previous = Some(std::mem::replace(
                &mut s.document,
                document::default_document(),
            ));
            s.status = "Default composition restored · conversation retained".into();
        }))
        .child(if s.unsettled && !s.busy {
            button(s, "Retry", "retry", |s| command(s, json!({"op":"retry"})))
        } else {
            el()
        });
    let mut mount = col().key("composition").w_full().grow(1.0).min_h(0.0);
    if let Some(root) = &s.document.root {
        mount = mount.child(render(s, root, narrow));
    }
    col()
        .key("native-root")
        .w_full()
        .h_full()
        .padding(if narrow {
            16.0
        } else {
            s.document.theme.padding
        })
        .gap(12.0)
        .fill(color(s, "background"))
        .child(mount)
        .child(if narrow {
            col()
                .w_full()
                .gap(8.0)
                .child(recovery)
                .child(label(s, &s.status, 11.0).color(color(s, "muted")).w_full())
        } else {
            row().w_full().center_y().gap(12.0).child(recovery).child(
                label(s, &s.status, 11.0)
                    .color(color(s, "muted"))
                    .grow(1.0)
                    .min_w(0.0),
            )
        })
}

fn render(s: &State, n: &Node, narrow: bool) -> El {
    let previous = TEXT_STYLE.with(|current| {
        let mut current = current.borrow_mut();
        let previous = current.clone();
        if n.style.font_size.is_some() {
            current.font_size = n.style.font_size;
        }
        if n.style.weight.is_some() {
            current.weight = n.style.weight;
        }
        if n.style.font_family.is_some() {
            current.font_family = n.style.font_family.clone();
        }
        if n.style.color.is_some() {
            current.color = n.style.color.clone();
        }
        previous
    });
    let mut e = match (n.kind.as_str(), n.version) {
        ("column" | "row" | "card", 1) => container(s, n, narrow),
        ("header", 1) => header(s, n, narrow),
        ("sidebar", 1) => sidebar(s, n, narrow),
        ("transcript", 1) => transcript(s, narrow),
        ("composer", 1) => composer(s),
        ("text", 1) => label(s, &n.text, n.style.font_size.unwrap_or(16.0)),
        ("divider", 1) => el()
            .w_full()
            .h(n.data["thickness"].as_f64().unwrap_or(1.0).clamp(0.5, 16.0) as f32)
            .fill(color(s, "muted")),
        ("button", 1) => {
            let prompt = n.data["prompt"].as_str().unwrap_or("").to_owned();
            button(s, &n.text, &format!("action-{}", n.id), move |s| {
                s.draft = TextEdit::new(&prompt);
                submit(s);
            })
            .disabled(s.busy || s.unsettled)
        }
        ("table", 1) => table(s, n),
        ("restaurant", 1) => restaurant(s, n),
        _ => label(
            s,
            format!("Unsupported {}@{} · {}", n.kind, n.version, n.text),
            14.0,
        )
        .color(color(s, "muted")),
    }
    .key(format!("node-{}", n.id));
    let st = &n.style;
    if let Some(v) = st.width {
        e = e.w(v);
    }
    if let Some(v) = st.grow {
        e = e.grow(v);
    }
    if let Some(v) = st.padding {
        e = e.padding(v);
    }
    if let Some(v) = st.gap {
        e = e.gap(v);
    }
    if let Some(v) = st.radius {
        e = e.radius(v);
    }
    if let Some(v) = &st.fill {
        e = e.fill(hex(v));
    }
    if let Some(v) = &st.color {
        e = e.color(hex(v));
    }
    TEXT_STYLE.with(|current| *current.borrow_mut() = previous);
    e
}
fn container(s: &State, n: &Node, narrow: bool) -> El {
    if narrow && s.panels && n.children.iter().any(|child| child.kind == "sidebar") {
        return col().w_full().grow(1.0).min_h(0.0).child(
            render(
                s,
                n.children
                    .iter()
                    .find(|child| child.kind == "sidebar")
                    .unwrap(),
                narrow,
            )
            .w_full(),
        );
    }
    let mut e = if n.kind == "row" { row() } else { col() };
    e = e.w_full().min_h(0.0).min_w(0.0).gap(s.document.theme.gap);
    if n.kind == "card" {
        e = e
            .padding(20.0)
            .radius(s.document.theme.radius)
            .fill(color(s, "surface"));
    } else {
        e = e.grow(1.0);
    }
    for child in &n.children {
        if narrow && child.kind == "sidebar" && !s.panels {
            continue;
        }
        e = e.child(render(s, child, narrow));
    }
    e
}
fn header(s: &State, n: &Node, narrow: bool) -> El {
    let mut header = row()
        .w_full()
        .center_y()
        .gap(12.0)
        .child(label(
            s,
            if n.text.is_empty() {
                "Computah"
            } else {
                &n.text
            },
            22.0,
        ))
        .child(
            label(
                s,
                if s.demo {
                    "Here with you · Demo"
                } else {
                    "Here with you"
                },
                12.0,
            )
            .color(color(s, "muted"))
            .grow(1.0),
        );
    if narrow {
        header = header.child(button(
            s,
            if s.panels { "Chat" } else { "Panels" },
            "panels",
            |s| s.panels = !s.panels,
        ));
    }
    header
}
fn sidebar(s: &State, n: &Node, narrow: bool) -> El {
    if !s.demo {
        return col()
            .w(288.0)
            .child(label(s, "Your conversation", 16.0))
            .child(
            label(
                s,
                "Living panels appear here when available. No accounts are connected by this app.",
                13.0,
            )
            .color(color(s, "muted")),
        );
    }
    let mut list = col().w(288.0).gap(16.0).min_h(0.0);
    for panel in n.data["panels"].as_array().into_iter().flatten() {
        list = list.child(
            col()
                .w_full()
                .padding(if narrow { 20.0 } else { 24.0 })
                .gap(12.0)
                .radius(28.0)
                .fill(color(s, "surface"))
                .child(label(s, panel["title"].as_str().unwrap_or(""), 16.0))
                .child(
                    label(s, panel["body"].as_str().unwrap_or(""), 14.0).color(color(s, "muted")),
                ),
        );
    }
    list.scroll(ScrollSpec {
        stick_bottom: false,
    })
}
fn transcript(s: &State, narrow: bool) -> El {
    let mut list =
        col()
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .gap(20.0)
            .pt(if narrow { 8.0 } else { 48.0 });
    if s.messages.is_empty() {
        list = list
            .child(label(s, "What’s on your mind?", 28.0))
            .child(label(s, "One conversation with Computah.", 16.0).color(color(s, "muted")));
    }
    for message in &s.messages {
        let user = message.role == "user";
        let mut bubble = col()
            .max_w(if narrow {
                350.0
            } else if message.ingress.is_some() {
                380.0
            } else {
                680.0
            })
            .gap(8.0)
            .padding(16.0)
            .radius(if message.ingress.is_some() {
                18.0
            } else {
                28.0
            })
            .fill(if message.ingress.is_some() {
                hex("#171717")
            } else if user {
                hex("#F5F5F5")
            } else {
                hex("#242424")
            });
        if let Some(meta) = &message.ingress {
            bubble = bubble.child(label(s, meta, 11.0).color(hex("#B0B0B0")));
        }
        bubble = bubble.child(
            label(
                s,
                &message.content,
                if message.ingress.is_some() {
                    14.0
                } else {
                    16.0
                },
            )
            .color(if user && message.ingress.is_none() {
                hex("#111111")
            } else if message.ingress.is_some() {
                hex("#B0B0B0")
            } else {
                color(s, "text")
            }),
        );
        if user {
            bubble = bubble.self_end();
        }
        let mut entry = col().key(&message.id).w_full().gap(12.0).child(bubble);
        for card in &message.cards {
            entry = entry.child(render(s, card, narrow));
        }
        list = list.child(entry);
    }
    list.scroll(ScrollSpec { stick_bottom: true })
}
fn composer(s: &State) -> El {
    row()
        .w_full()
        .min_w(0.0)
        .gap(8.0)
        .center_y()
        .padding(12.0)
        .radius(36.0)
        .fill(color(s, "surface"))
        .child(
            text_input(&s.draft, inherited_font(16.0))
                .key("prompt")
                .label("Message Computah")
                .placeholder("Ask Computah anything", color(s, "muted"))
                .grow(1.0)
                .min_w(0.0)
                .min_h(40.0)
                .max_h(120.0)
                .color(color(s, "text"))
                .on_edit(|s: &mut State| &mut s.draft)
                .on_submit(|s: &mut State, _| submit(s)),
        )
        .child(if s.busy {
            button(s, "Stop", "stop", |s| command(s, json!({"op":"cancel"})))
        } else {
            button(s, "Send", "send", submit)
                .disabled(!s.ready || s.draft.text.trim().is_empty() || s.unsettled)
        })
}
fn table(s: &State, n: &Node) -> El {
    let Some(columns) = n.data["columns"].as_array() else {
        return label(s, "Table unavailable", 14.0);
    };
    let mut grid = col()
        .role("grid")
        .label(if n.text.is_empty() {
            "Comparison"
        } else {
            &n.text
        })
        .w_full()
        .gap(1.0);
    let mut headings = row().role("row").w_full();
    for (i, column) in columns.iter().enumerate() {
        let id = n.id.clone();
        headings = headings.child(
            label(s, column.as_str().unwrap_or(""), 13.0)
                .role("columnheader")
                .label("Sort column")
                .focusable(true)
                .w(0.0)
                .grow(1.0)
                .padding(12.0)
                .on_press(move |s: &mut State| {
                    let descending = s
                        .sort
                        .as_ref()
                        .is_some_and(|(key, col, desc)| key == &id && *col == i && !*desc);
                    s.sort = Some((id.clone(), i, descending));
                }),
        );
    }
    grid = grid.child(headings.fill(color(s, "surface")));
    if let Some(rows) = n.data["rows"].as_array() {
        let mut sorted = rows.iter().collect::<Vec<_>>();
        if let Some((id, index, descending)) = &s.sort
            && id == &n.id
        {
            sorted.sort_by(|a, b| {
                let order = a[*index].as_str().cmp(&b[*index].as_str());
                if *descending { order.reverse() } else { order }
            });
        }
        if rows.is_empty() {
            grid = grid.child(label(s, "No rows yet", 14.0).padding(16.0));
        }
        for r in sorted {
            let mut line = row().role("row").w_full();
            for i in 0..columns.len() {
                line = line.child(
                    label(s, r[i].as_str().unwrap_or("—"), 14.0)
                        .role("gridcell")
                        .w(0.0)
                        .grow(1.0)
                        .padding(12.0),
                );
            }
            grid = grid.child(line);
        }
    }
    col()
        .w_full()
        .gap(12.0)
        .child(label(s, &n.text, 18.0))
        .child(grid)
}
fn restaurant(s: &State, n: &Node) -> El {
    col()
        .w_full()
        .padding(24.0)
        .gap(12.0)
        .radius(28.0)
        .fill(color(s, "surface"))
        .child(label(
            s,
            n.data["name"].as_str().unwrap_or("Restaurant"),
            22.0,
        ))
        .child(label(s, n.data["description"].as_str().unwrap_or(""), 15.0))
        .child(label(s, "Photo not provided", 12.0).color(color(s, "muted")))
        .child(
            label(
                s,
                format!(
                    "Hours unknown · {}",
                    n.data["timezone"].as_str().unwrap_or("Timezone unknown")
                ),
                13.0,
            )
            .color(color(s, "muted")),
        )
}

fn fixture(s: &mut State, name: &str) {
    let output = std::process::Command::new("node")
        .current_dir(host::app_root())
        .args(["--import", "tsx"])
        .arg(host::app_root().join("scripts/render.mjs"))
        .arg(name)
        .output()
        .unwrap();
    assert!(output.status.success());
    activate(s, &String::from_utf8(output.stdout).unwrap()).unwrap();
}
fn main() {
    if std::env::args().any(|arg| arg == "--verify-state") {
        let valid = std::fs::read_to_string(state_path())
            .ok()
            .and_then(|raw| serde_json::from_str::<Saved>(&raw).ok())
            .is_some_and(|saved| {
                saved.version == 1
                    && document::parse(&serde_json::to_string(&saved.document).unwrap()).is_ok()
                    && saved.previous.as_ref().is_none_or(|doc| {
                        document::parse(&serde_json::to_string(doc).unwrap()).is_ok()
                    })
            });
        std::process::exit(if valid { 0 } else { 1 });
    }
    rune::App::new(AppSpec {
        poll: Some(poll),
        scenes: &[
            ("table", |s| fixture(s, "table")),
            ("restaurant", |s| fixture(s, "restaurant")),
            ("empty", |s| fixture(s, "empty")),
            ("error", |s| {
                s.status = "Connection interrupted · Retry reuses the saved request".into();
                s.unsettled = true;
            }),
        ],
        ..AppSpec::new("Computah", (1440.0, 960.0), initial, view)
    })
    .standard_menus()
    .on_close(|s, _| {
        persist(s);
    })
    .run();
}

#[cfg(test)]
mod tests {
    use super::*;
    use rune::{Env, Runtime};

    fn runtime(size: (f32, f32)) -> Runtime<State> {
        let mut rt = Runtime::new(
            State::default(),
            view,
            size,
            Env {
                system_dark: true,
                scale: 1.0,
            },
        );
        rt.frame(0.0);
        rt
    }
    fn tap(rt: &mut Runtime<State>, key: &str) {
        let (x, y) = rt.find(key).expect("control visible");
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.016);
    }
    #[test]
    fn automatic_delete_all_keeps_undo_restore_and_conversation() {
        let mut rt = runtime((1100.0, 780.0));
        rt.update(|s, _| s.draft = TextEdit::new("delete all"));
        rt.frame(0.016);
        tap(&mut rt, "send");
        assert!(rt.find("prompt").is_none());
        assert!(rt.find("node-panels").is_none());
        assert!(rt.find("apply").is_none());
        tap(&mut rt, "undo");
        assert!(rt.find("prompt").is_some());
        assert!(rt.find("demo-user").is_some());
        assert!(
            rt.find("ui-4").is_some(),
            "conversation survives composition undo"
        );
        rt.update(|s, _| fixture(s, "empty"));
        rt.frame(0.016);
        tap(&mut rt, "restore");
        assert!(rt.find("prompt").is_some());
    }
    #[test]
    fn cards_remain_inline_and_narrow_panels_do_not_squeeze_chat() {
        let mut rt = runtime((390.0, 844.0));
        assert!(rt.find("prompt").is_some());
        assert!(rt.find("node-panels").is_none());
        tap(&mut rt, "panels");
        assert!(rt.find("node-panels").is_some());
        assert!(rt.find("prompt").is_none());
        tap(&mut rt, "panels");
        rt.update(|s, _| s.draft = TextEdit::new("compare in a table"));
        rt.frame(0.016);
        tap(&mut rt, "send");
        assert!(rt.find("prompt").is_some());
        let elements = rt.elements();
        assert!(elements.iter().any(|e| e.role == "grid"));
        assert_eq!(
            elements.iter().filter(|e| e.role == "columnheader").count(),
            3
        );
        assert_eq!(elements.iter().filter(|e| e.role == "gridcell").count(), 9);
        let field = rt.presented("prompt").unwrap().0;
        assert!(field[0] >= 0.0 && field[0] + field[2] <= 390.0);
    }
    #[test]
    fn unknown_components_use_fallback_and_rejected_replacement_retains_app() {
        let mut s = State::default();
        let before = serde_json::to_value(&s.document).unwrap();
        assert!(
            activate(
                &mut s,
                r#"{"message":"bad","cards":[],"app":{"version":99}}"#
            )
            .is_err()
        );
        assert_eq!(serde_json::to_value(&s.document).unwrap(), before);
        let messages = projected(
            &json!([{"id":"future","role":"assistant","blocks":[{"kind":"component","componentVersion":99,"props":{"secret":"DO_NOT_SHOW"},"fallback":"Unavailable widget"}]}]),
        );
        assert_eq!(messages[0].content, "Unavailable widget");
    }

    #[test]
    fn failed_checkpoint_keeps_new_draft_and_refuses_relaunch() {
        let directory =
            std::env::temp_dir().join(format!("computah-checkpoint-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("state.json");
        let mut state = State {
            storage: Some(path.clone()),
            ..State::default()
        };
        assert!(persist(&mut state));
        let previous = std::fs::read(&path).unwrap();
        std::fs::create_dir(path.with_extension("tmp")).unwrap();
        state.draft = TextEdit::new("Do not discard this draft");
        assert!(!persist(&mut state));
        assert_eq!(state.draft.text, "Do not discard this draft");
        assert_eq!(std::fs::read(path).unwrap(), previous);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
