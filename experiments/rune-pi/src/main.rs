mod bridge;
mod document;

use document::{Document, Node};
use rune::{
    AppSpec, Color, Cx, El, ScrollSpec, TextEdit, TextStyle, Tx, col, el, row, text, text_input,
};
use std::time::{Duration, Instant};

struct State {
    document: Document,
    draft: TextEdit,
    transcript: Vec<(String, String)>,
    proposal: Option<Document>,
    status: String,
    busy: bool,
    cancelled: bool,
    attempt_failed: bool,
    deadline: Option<Instant>,
    live: bool,
    bridge: bridge::Shared,
}

impl Default for State {
    fn default() -> Self {
        let mut state = Self { document: document::default_document(), draft: TextEdit::default(), transcript: vec![("June".into(), "Try ‘make a table’, ‘restaurant’, or ‘empty’. Apply the proposed layout; Restore always stays outside it.".into())], proposal: None, status: "Mock · deterministic, no external effects".into(), busy: false, cancelled: false, attempt_failed: false, deadline: None, live: std::env::args().any(|a| a == "--pi"), bridge: Default::default() };
        reload(&mut state);
        if state.status == "Layout reloaded" {
            state.status = if state.live {
                "Ready · local Pi, tools disabled"
            } else {
                "Mock · deterministic, no external effects"
            }
            .into();
        }
        if let Ok(path) = std::env::var("RUNE_PI_SNAPSHOT") {
            match std::fs::read_to_string(path)
                .ok()
                .and_then(|v| snapshot_text(&v))
            {
                Some(messages) => {
                    state.transcript = messages;
                    state.status =
                        "Portable v1 snapshot · read-only text/fallback projection".into();
                }
                None => state.status = "Invalid v1 snapshot; default conversation retained".into(),
            }
        }
        state
    }
}

// Read-only projection of the integration owner's v1 snapshot/fixture envelope. Never
// interpret connection/auth data, execute component props, or invent a second wire schema.
fn snapshot_text(input: &str) -> Option<Vec<(String, String)>> {
    if input.len() > 128 * 1024 {
        return None;
    }
    let envelope: serde_json::Value = serde_json::from_str(input).ok()?;
    let snapshot = envelope.get("snapshot").unwrap_or(&envelope);
    if snapshot["version"] != 1 {
        return None;
    }
    let messages = snapshot["messages"].as_array()?;
    let mut output = Vec::new();
    for message in messages {
        let mut parts = Vec::new();
        for block in message["blocks"].as_array()? {
            parts.push(match block["kind"].as_str()? {
                "text" => block["text"].as_str()?.to_string(),
                "component" => block["fallback"].as_str()?.to_string(),
                _ => "Unsupported block".into(),
            });
        }
        output.push((message["role"].as_str()?.to_string(), parts.join("\n")));
    }
    Some(output)
}

fn submit(s: &mut State) {
    if s.busy || s.draft.text.trim().is_empty() {
        return;
    }
    let prompt = s.draft.text.clone();
    s.draft = TextEdit::default();
    s.transcript.push(("You".into(), prompt.clone()));
    s.proposal = None;
    s.cancelled = false;
    s.attempt_failed = false;
    if !s.live {
        let answer = document::mock(&prompt);
        s.proposal = document::parse(&answer).ok();
        s.transcript.push((
            "June".into(),
            "Generated a layout proposal. Apply it above; Restore returns to the conversation."
                .into(),
        ));
        s.status = "Completed · mock proposal ready".into();
        return;
    }
    let instructions = format!(
        "You are a UI composition assistant. Return ONLY a JSON document matching this example (no markdown): {}. Allowed kind@version: column@1, row@1, text@1, transcript@1, composer@1, table@1 (data columns:string[], rows:string[][]), restaurant@1 (data name,description,photo:null,timezone,schedule:null). IDs unique. root:null removes everything. No executable code, URLs, actions or secrets. User request: {prompt}",
        include_str!("../layout.json")
    );
    let mut guard = s.bridge.lock().unwrap();
    if guard.is_none() {
        *guard = bridge::Bridge::start().ok();
    }
    match guard.as_mut().map(|b| b.prompt(&instructions)) {
        Some(Ok(())) => {
            s.busy = true;
            s.deadline = Some(Instant::now() + Duration::from_secs(120));
            s.transcript.push(("June".into(), String::new()));
            s.status = "Streaming · local Pi (tools disabled)".into();
        }
        _ => {
            *guard = None;
            s.status = "Failed · install/login to Pi in your terminal, then retry".into();
        }
    }
}

fn cancel(s: &mut State) {
    if !s.busy {
        return;
    }
    s.cancelled = true;
    s.status = "Cancelling · waiting for Pi to settle".into();
    let mut guard = s.bridge.lock().unwrap();
    if guard.as_mut().is_none_or(|b| b.cancel().is_err()) {
        s.busy = false;
        s.deadline = None;
        *guard = None;
        s.status = "Unknown · Pi connection lost during cancellation".into();
    }
}

fn poll(s: &mut State, _: f64, tx: &mut Tx) -> bool {
    if !s.busy {
        return false;
    }
    tx.wake_after(Duration::from_millis(50));
    let mut changed = false;
    let mut guard = s.bridge.lock().unwrap();
    if let Some(b) = guard.as_mut() {
        while let Ok(event) = b.events.try_recv() {
            changed = true;
            match event {
                bridge::Event::AttemptStart => {
                    s.attempt_failed = false;
                    if let Some((_, output)) = s.transcript.last_mut() {
                        output.clear();
                    }
                }
                bridge::Event::AttemptEnd { text, failed } => {
                    s.attempt_failed = failed;
                    if text.len() > 128 * 1024 {
                        s.busy = false;
                        s.status = "Failed · model output exceeds 128 KiB".into();
                        break;
                    }
                    if let Some((_, output)) = s.transcript.last_mut() {
                        *output = text;
                    }
                    if failed {
                        s.status = "Recovering · waiting for Pi to settle or retry".into();
                    }
                }
                bridge::Event::Text(delta) => {
                    if let Some((_, output)) = s.transcript.last_mut() {
                        if output.len() + delta.len() > 128 * 1024 {
                            s.busy = false;
                            s.status = "Failed · model output exceeds 128 KiB".into();
                            break;
                        }
                        output.push_str(&delta);
                    }
                }
                bridge::Event::Done => {
                    s.busy = false;
                    s.status = if s.cancelled {
                        "Cancelled"
                    } else if s.attempt_failed {
                        "Failed · check Pi model/auth in your terminal; raw errors withheld"
                    } else {
                        "Completed"
                    }
                    .into();
                    if !s.cancelled && !s.attempt_failed {
                        s.proposal = s
                            .transcript
                            .last()
                            .and_then(|(_, v)| document::parse(v).ok());
                        if s.proposal.is_none() {
                            s.status =
                                "Completed · no valid layout proposal; current layout retained"
                                    .into();
                        }
                    }
                    break;
                }
                bridge::Event::Failed => {
                    s.busy = false;
                    s.status =
                        "Failed · check Pi model/auth in your terminal; raw errors withheld".into();
                    break;
                }
                bridge::Event::Unknown => {
                    s.busy = false;
                    s.status = "Unknown · Pi exited; retry starts a fresh process".into();
                    break;
                }
            }
        }
    }
    if s.busy && s.deadline.is_some_and(|d| Instant::now() > d) {
        s.busy = false;
        s.status = "Unknown · timed out; process stopped, retry starts fresh".into();
        *guard = None;
        return true;
    }
    if !s.busy && (s.status.starts_with("Unknown") || s.status.starts_with("Failed")) {
        *guard = None;
    }
    if !s.busy {
        s.deadline = None;
    }
    changed
}

fn button(label: &str, key: &str, action: fn(&mut State)) -> El {
    text(label)
        .key(key)
        .role("button")
        .label(label)
        .focusable(true)
        .font(TextStyle::new(13.0, 500.0))
        .color(rune::color::hex("#f5f5f5").unwrap())
        .padding(10.0)
        .radius(12.0)
        .fill(rune::color::hex("#292929").unwrap())
        .on_press(action)
}

fn reload(s: &mut State) {
    let path = std::env::var("RUNE_PI_LAYOUT").unwrap_or_else(|_| "layout.json".into());
    match std::fs::read_to_string(path)
        .map_err(|_| "Cannot read layout; retained previous layout.")
        .and_then(|v| document::parse(&v))
    {
        Ok(doc) => {
            s.document = doc;
            s.status = "Layout reloaded".into();
        }
        Err(message) => s.status = message.into(),
    }
}

fn view(s: &State, _: &mut Cx<State>) -> El {
    // Recovery is deliberately NOT mounted inside the data-driven document.
    let toolbar = row()
        .gap(8.0)
        .center_y()
        .child(button("Restore", "restore", |s| {
            s.document = document::default_document();
            s.status = "Default layout restored (in memory)".into();
        }))
        .child(button("Reload JSON", "reload", reload))
        .child(
            button("Apply proposal", "apply", |s| {
                if !s.busy
                    && let Some(doc) = s.proposal.take()
                {
                    s.document = doc;
                }
            })
            .disabled(s.proposal.is_none() || s.busy),
        )
        .child(button("Cancel", "cancel", cancel).disabled(!s.busy));
    let mut body = col().key("document-mount").w_full().grow(1.0).min_h(0.0);
    if let Some(n) = &s.document.root {
        body = body.child(render(s, n));
    }
    col()
        .w_full()
        .h_full()
        .padding(16.0)
        .gap(12.0)
        .fill(rune::color::hex("#000000").unwrap())
        .child(toolbar)
        .child(
            text(format!(
                "{}{}",
                if s.live { "LOCAL PI · " } else { "" },
                s.status
            ))
            .font(TextStyle::new(13.0, 400.0))
            .color(rune::color::hex("#b5b5b5").unwrap()),
        )
        .child(body)
}

type Renderer = fn(&State, &Node) -> El;
// Agent-editable native renderer registry. JSON cannot register code or invoke host actions.
const REGISTRY: &[(&str, u32, Renderer)] = &[
    ("column", 1, container),
    ("row", 1, container),
    ("text", 1, label),
    ("transcript", 1, transcript),
    ("composer", 1, composer),
    ("table", 1, table),
    ("restaurant", 1, restaurant),
];

fn color(s: &State, which: &str) -> Color {
    let t = &s.document.theme;
    rune::color::hex(match which {
        "surface" => &t.surface,
        "muted" => &t.muted,
        "background" => &t.background,
        _ => &t.text,
    })
    .unwrap()
}
fn render(s: &State, n: &Node) -> El {
    REGISTRY
        .iter()
        .find(|(kind, version, _)| *kind == n.kind && *version == n.version)
        .map(|(_, _, render)| render(s, n))
        .unwrap_or_else(|| {
            text(format!(
                "Unsupported {}@{} · {}",
                n.kind,
                n.version,
                if n.text.is_empty() {
                    "component unavailable"
                } else {
                    &n.text
                }
            ))
            .color(color(s, "muted"))
        })
        .key(format!("node-{}", n.id))
}
fn container(s: &State, n: &Node) -> El {
    let t = &s.document.theme;
    let mut e = if n.kind == "row" { row() } else { col() };
    e = e
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .padding(t.padding)
        .gap(t.gap)
        .fill(color(s, "background"));
    for child in &n.children {
        e = e.child(render(s, child));
    }
    e
}
fn label(s: &State, n: &Node) -> El {
    text(&n.text)
        .font(TextStyle::new(20.0, 500.0))
        .color(color(s, "text"))
}
fn transcript(s: &State, _: &Node) -> El {
    let mut list = col().w_full().grow(1.0).min_h(0.0).gap(16.0);
    for (index, (role, content)) in s.transcript.iter().enumerate() {
        list = list.child(
            col()
                .key(format!("message-{index}"))
                .gap(6.0)
                .padding(16.0)
                .radius(s.document.theme.radius)
                .fill(color(s, "surface"))
                .child(
                    text(role)
                        .font(TextStyle::new(12.0, 600.0))
                        .color(color(s, "muted")),
                )
                .child(
                    text(content)
                        .font(TextStyle::new(15.0, 400.0))
                        .color(color(s, "text")),
                ),
        );
    }
    list.scroll(ScrollSpec { stick_bottom: true })
}
fn composer(s: &State, _: &Node) -> El {
    row()
        .gap(12.0)
        .center_y()
        .padding(12.0)
        .radius(28.0)
        .fill(color(s, "surface"))
        .child(
            text_input(&s.draft, TextStyle::new(15.0, 400.0))
                .key("prompt")
                .label("Layout request")
                .placeholder("Describe a layout…", color(s, "muted"))
                .single_line()
                .grow(1.0)
                .min_w(0.0)
                .color(color(s, "text"))
                .on_edit(|s: &mut State| &mut s.draft)
                .on_submit(|s: &mut State, _| submit(s)),
        )
        .child(
            button("Generate", "generate", submit)
                .disabled(s.busy || s.draft.text.trim().is_empty()),
        )
}
fn table(s: &State, n: &Node) -> El {
    let columns = n.data["columns"].as_array();
    let rows = n.data["rows"].as_array();
    let mut grid = col()
        .role("grid")
        .label("Generated data table")
        .w_full()
        .gap(1.0);
    if let Some(cols) = columns {
        let mut header = row().role("row").w_full();
        for c in cols.iter().take(8) {
            header = header.child(
                text(c.as_str().unwrap_or("?"))
                    .role("columnheader")
                    .w(0.0)
                    .grow(1.0)
                    .padding(12.0)
                    .color(color(s, "text")),
            );
        }
        grid = grid.child(header.fill(color(s, "surface")));
        if let Some(rows) = rows {
            for r in rows.iter().take(100) {
                let mut line = row().role("row").w_full();
                for i in 0..cols.len().min(8) {
                    line = line.child(
                        text(r[i].as_str().unwrap_or("—"))
                            .role("gridcell")
                            .w(0.0)
                            .grow(1.0)
                            .padding(12.0)
                            .color(color(s, "text")),
                    );
                }
                grid = grid.child(line);
            }
        }
    } else {
        grid = grid.child(text("Table data unavailable").color(color(s, "muted")));
    }
    grid.scroll(ScrollSpec {
        stick_bottom: false,
    })
}
fn restaurant(s: &State, n: &Node) -> El {
    col()
        .gap(12.0)
        .padding(20.0)
        .radius(s.document.theme.radius)
        .fill(color(s, "surface"))
        .child(
            text(n.data["name"].as_str().unwrap_or("Unnamed restaurant"))
                .font(TextStyle::new(22.0, 600.0))
                .color(color(s, "text")),
        )
        .child(text(n.data["description"].as_str().unwrap_or("")).color(color(s, "text")))
        .child(
            el().h(80.0)
                .center()
                .child(text("Photo not provided").color(color(s, "muted"))),
        )
        .child(
            text(format!(
                "Hours unknown · {}",
                n.data["timezone"].as_str().unwrap_or("timezone unknown")
            ))
            .color(color(s, "muted")),
        )
}

fn main() {
    rune::run(AppSpec {
        poll: Some(poll),
        scenes: &[
            ("table", |s| {
                s.document = document::parse(&document::mock("table")).unwrap()
            }),
            ("restaurant", |s| {
                s.document = document::parse(&document::mock("restaurant")).unwrap()
            }),
            ("empty", |s| s.document.root = None),
            ("unknown", |s| {
                if let Some(n) = s.document.root.as_mut() {
                    n.kind = "future-widget".into();
                }
            }),
        ],
        ..AppSpec::new(
            "June · Rune + local Pi",
            (900.0, 700.0),
            State::default,
            view,
        )
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use rune::{Env, Runtime};

    #[test]
    fn generated_blank_layout_can_always_be_restored() {
        let state = State {
            live: false,
            draft: TextEdit::new("empty"),
            ..State::default()
        };
        let mut rt = Runtime::new(
            state,
            view,
            (900.0, 700.0),
            Env {
                system_dark: true,
                scale: 1.0,
            },
        );
        rt.frame(0.0);
        for key in ["generate", "apply"] {
            let (x, y) = rt.find(key).expect("action visible");
            rt.pointer_down(x, y);
            rt.pointer_up(x, y);
            rt.frame(0.016);
        }
        assert!(rt.state.document.root.is_none());
        assert!(rt.find("prompt").is_none(), "composer really unmounted");
        let (x, y) = rt.find("restore").expect("recovery survives blank mount");
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.016);
        assert!(rt.find("prompt").is_some());
    }

    #[test]
    fn layouts_reject_bad_versions_ids_and_theme_but_allow_unknown_components() {
        let mut value: serde_json::Value =
            serde_json::from_str(include_str!("../layout.json")).unwrap();
        value["root"]["kind"] = "future-widget".into();
        assert!(document::parse(&value.to_string()).is_ok());
        value["root"]["children"][0]["id"] = "workspace".into();
        assert!(document::parse(&value.to_string()).is_err());
        value["root"] = serde_json::Value::Null;
        assert!(document::parse(&value.to_string()).is_ok());
        value["version"] = 2.into();
        assert!(document::parse(&value.to_string()).is_err());
        value["version"] = 1.into();
        value["theme"]["gap"] = (-1).into();
        assert!(document::parse(&value.to_string()).is_err());
    }

    #[test]
    fn snapshot_unknown_components_use_fallback_not_props_or_credentials() {
        let input = r#"{"version":1,"messages":[{"role":"assistant","blocks":[{"kind":"component","component":"unknown","props":{"token":"DO_NOT_RENDER"},"fallback":"Unavailable widget"},{"kind":"text","text":"Visible text"}]}],"connections":[{"token":"DO_NOT_RENDER"}]}"#;
        assert_eq!(
            snapshot_text(input),
            Some(vec![(
                "assistant".into(),
                "Unavailable widget\nVisible text".into()
            )])
        );
    }
}
