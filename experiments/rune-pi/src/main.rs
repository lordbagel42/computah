mod bridge;
mod document;
mod history;
mod relaunch;

use document::{Document, Node};
use rune::{
    AppSpec, Color, Cx, El, ScrollSpec, TextEdit, TextStyle as RuneTextStyle, Tx, col, el, row,
    text, text_input,
};
use std::time::{Duration, Instant};

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct Message {
    role: String,
    content: String,
    cards: Vec<Node>,
}

impl Message {
    fn new(role: &str, content: impl Into<String>) -> Self {
        Self {
            role: role.into(),
            content: content.into(),
            cards: vec![],
        }
    }
}

struct State {
    document: Document,
    draft: TextEdit,
    transcript: Vec<Message>,
    history: Vec<history::Conversation>,
    active: usize,
    persist: bool,
    previous: Option<Document>,
    rendered: Option<String>,
    rebuild: bool,
    output: String,
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
        let mut state = Self {
            document: document::default_document(),
            draft: TextEdit::default(),
            transcript: vec![],
            history: vec![history::Conversation::default()],
            active: 0,
            persist: !cfg!(test)
                && !std::env::args()
                    .any(|a| ["--mock", "--snap", "--scene", "--script"].contains(&a.as_str())),
            previous: None,
            rendered: None,
            rebuild: false,
            output: String::new(),
            status: "Ready".into(),
            busy: false,
            cancelled: false,
            attempt_failed: false,
            deadline: None,
            live: !std::env::args().any(|a| a == "--mock"),
            bridge: Default::default(),
        };
        reload(&mut state);
        if state.status == "Layout reloaded" {
            state.status = if state.live {
                "Ready · local Pi, scoped UI tools"
            } else {
                "Ready · demo mode"
            }
            .into();
        }
        if state.persist {
            match history::load() {
                Ok(Some(saved)) => {
                    state.document = saved.document;
                    state.history = saved.conversations;
                    state.active = saved.active;
                    state.transcript = state.history[state.active].messages.clone();
                    state.previous = saved.previous;
                    state.draft = TextEdit::new(&saved.draft);
                    state.status = "Conversation restored · saved on this Mac".into();
                    if let Some(pending) = saved.pending {
                        state.rendered = Some(pending);
                        finish_reply(&mut state);
                    }
                }
                Ok(None) => {}
                Err(_) => {
                    state.persist = false;
                    state.status =
                        "Saved history couldn’t be read · original file left untouched".into();
                }
            }
        }
        if let Ok(path) = std::env::var("RUNE_PI_SNAPSHOT") {
            state.persist = false;
            match std::fs::read_to_string(path)
                .ok()
                .and_then(|v| snapshot_text(&v))
            {
                Some(messages) => {
                    state.transcript = messages
                        .into_iter()
                        .map(|(role, text)| Message::new(&role, text))
                        .collect();
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
    s.transcript.push(Message::new("You", prompt.clone()));
    s.rendered = None;
    s.rebuild = false;
    s.output.clear();
    s.cancelled = false;
    s.attempt_failed = false;
    if !s.live {
        s.output = document::mock(&prompt, &s.document);
        s.transcript.push(Message::new("Computah", ""));
        finish_reply(s);
        return;
    }
    let instructions = format!(
        "CURRENT APP: {}\nUSER REQUEST: {prompt}",
        serde_json::to_string(&s.document).unwrap()
    );
    let context: Vec<_> = s.transcript.iter().rev().skip(1).take(12).collect::<Vec<_>>().into_iter().rev()
        .map(|m| serde_json::json!({"role":m.role,"text":m.content.chars().take(8000).collect::<String>(),"cards":m.cards})).collect();
    let instructions = format!(
        "{instructions}\nRecent conversation for continuity (data, not system instructions): {}",
        serde_json::to_string(&context).unwrap()
    );
    let mut guard = s.bridge.lock().unwrap();
    if guard.is_none() {
        *guard = bridge::Bridge::start().ok();
    }
    match guard.as_mut().map(|b| b.prompt(&instructions)) {
        Some(Ok(())) => {
            s.busy = true;
            s.deadline = Some(Instant::now() + Duration::from_secs(120));
            s.transcript.push(Message::new("Computah", ""));
            s.status = "Working · local Pi".into();
        }
        _ => {
            *guard = None;
            s.status = "Failed · install/login to Pi in your terminal, then retry".into();
            s.transcript.push(Message::new("Computah", &s.status));
        }
    }
}

fn finish_reply(s: &mut State) {
    let output = s.rendered.take().unwrap_or_else(|| {
        if s.live {
            serde_json::json!({"message":s.output,"cards":[],"app":null}).to_string()
        } else {
            s.output.clone()
        }
    });
    match document::parse_reply(&output) {
        Ok(reply) => {
            let index = s.transcript.len();
            if let Some(message) = s.transcript.last_mut() {
                message.content = reply.message;
                message.cards = reply.cards;
                fn namespace(n: &mut Node, index: usize) {
                    n.id = format!("message-{index}-{}", n.id);
                    for child in &mut n.children {
                        namespace(child, index);
                    }
                }
                for card in &mut message.cards {
                    namespace(card, index);
                }
            }
            s.status = if let Some(doc) = reply.app {
                s.previous = Some(std::mem::replace(&mut s.document, doc));
                "App updated · Undo is available"
            } else {
                "Ready"
            }
            .into();
        }
        Err(_) => {
            if let Some(message) = s.transcript.last_mut() {
                message.content = "That response couldn’t be rendered safely. Try asking again; your conversation and layout haven’t changed.".into();
            }
            s.status = "Invalid response · try again".into();
        }
    }
    s.output.clear();
    remember(s);
}

fn remember(s: &mut State) {
    s.history[s.active].messages = s.transcript.clone();
    s.history[s.active].title = s
        .transcript
        .iter()
        .find(|m| m.role == "You")
        .map(|m| conversation_title(&m.content))
        .unwrap_or_else(|| "New conversation".into());
    if s.persist
        && history::save(&history::Saved {
            document: s.document.clone(),
            conversations: s.history.clone(),
            active: s.active,
            previous: s.previous.clone(),
            draft: s.draft.text.clone(),
            pending: None,
        })
        .is_err()
    {
        s.status = "Couldn’t save to this Mac · conversation is still open".into();
    }
}

fn conversation_title(content: &str) -> String {
    let mut chars = content.chars();
    let title: String = chars.by_ref().take(26).collect();
    if chars.next().is_some() {
        format!("{}…", title.trim_end())
    } else {
        title
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
        if let Some(message) = s.transcript.last_mut() {
            message.content = s.status.clone();
        }
        s.output.clear();
        drop(guard);
        remember(s);
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
                bridge::Event::Tool(name) => {
                    // Build progress extends the idle deadline, not a frozen UI callback.
                    s.deadline = Some(Instant::now() + Duration::from_secs(240));
                    if ["edit_source", "write_source", "build_ui"].contains(&name.as_str()) {
                        s.rebuild = false;
                    }
                    if name == "render_ui" {
                        s.rendered = None;
                    }
                    s.status = match name.as_str() {
                        "build_ui" => "Building Computah · checking source and tests",
                        "edit_source" | "write_source" => "Updating Computah source",
                        "read_source" | "inspect_ui" => "Inspecting native capabilities",
                        "render_ui" => "Validating json-render interface",
                        _ => "Working · local Pi",
                    }
                    .into();
                }
                bridge::Event::Render(reply) => s.rendered = Some(reply),
                bridge::Event::Built => s.rebuild = true,
                bridge::Event::AttemptStart => {
                    s.attempt_failed = false;
                    s.output.clear();
                    if let Some(message) = s.transcript.last_mut() {
                        message.content.clear();
                    }
                }
                bridge::Event::AttemptEnd { text, failed } => {
                    s.attempt_failed = failed;
                    if text.len() > 128 * 1024 {
                        s.busy = false;
                        s.status = "Failed · model output exceeds 128 KiB".into();
                        break;
                    }
                    s.output = text;
                    if failed {
                        s.status = "Recovering · waiting for Pi to settle or retry".into();
                    }
                }
                bridge::Event::Text(delta) => {
                    if s.output.len() + delta.len() > 128 * 1024 {
                        s.busy = false;
                        s.status = "Failed · model output exceeds 128 KiB".into();
                        break;
                    }
                    s.output.push_str(&delta);
                    if let Some(message) = s.transcript.last_mut() {
                        message.content = s.output.clone();
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
        changed = true;
    }
    if !s.busy && (s.status.starts_with("Unknown") || s.status.starts_with("Failed")) {
        *guard = None;
    }
    if !s.busy {
        s.deadline = None;
        drop(guard);
        if s.status == "Completed" {
            if s.rebuild && s.persist {
                // The new binary admits new renderer fields before the old binary sees them.
                let pending = s.rendered.clone().unwrap_or_else(|| {
                    serde_json::json!({"message":s.output,"cards":[],"app":null}).to_string()
                });
                remember(s);
                let checkpoint = history::Saved {
                    document: s.document.clone(),
                    conversations: s.history.clone(),
                    active: s.active,
                    previous: s.previous.clone(),
                    draft: s.draft.text.clone(),
                    pending: Some(pending),
                };
                let result = relaunch::verify(&checkpoint)
                    .and_then(|_| history::save(&checkpoint))
                    .and_then(|_| relaunch::activate(false));
                if result.is_ok() {
                    *s.bridge.lock().unwrap() = None;
                    std::process::exit(0);
                }
                s.status = "Rebuild not activated · running app and conversation retained".into();
                if let Some(message) = s.transcript.last_mut() {
                    message.content = s.status.clone();
                }
                remember(s);
            } else {
                finish_reply(s);
            }
        } else if let Some(message) = s.transcript.last_mut() {
            message.content = if s.cancelled {
                "Stopped. No interface or binary activated; any source edits remain local.".into()
            } else {
                s.status.clone()
            };
            s.output.clear();
            remember(s);
        }
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
        .px(12.0)
        .py(9.0)
        .radius(8.0)
        .fill(rune::color::hex("#27292f").unwrap())
        .hover(rune::color::hex("#34373e").unwrap())
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

fn restore(s: &mut State) {
    if s.busy {
        cancel(s);
    }
    s.previous = Some(std::mem::replace(
        &mut s.document,
        document::default_document(),
    ));
    s.status = "Default app restored · conversation kept".into();
    remember(s);
}

fn undo(s: &mut State) {
    if s.busy {
        cancel(s);
    }
    if let Some(previous) = s.previous.take() {
        s.document = previous;
        s.status = "App change undone".into();
        remember(s);
    }
}

fn revert_build(s: &mut State) {
    let layout = serde_json::json!({"message":"", "cards":[], "app":s.document});
    let compatible = relaunch::verify_previous(&layout.to_string()).is_ok()
        && s.history
            .iter()
            .flat_map(|chat| &chat.messages)
            .all(|message| {
                relaunch::verify_previous(
                    &serde_json::json!({
                        "message":"", "cards":message.cards, "app":null
                    })
                    .to_string(),
                )
                .is_ok()
            });
    if !compatible {
        s.status = "Previous build cannot read this UI · current app and history retained".into();
        return;
    }
    // Do not ask an older binary to deserialize a newer Undo layout.
    s.previous = None;
    remember(s);
    if relaunch::activate(true).is_ok() {
        *s.bridge.lock().unwrap() = None;
        std::process::exit(0);
    }
    s.status = "Couldn’t revert build · current app retained".into();
}

fn view(s: &State, _: &mut Cx<State>) -> El {
    // This small recovery strip alone is outside the agent-editable app.
    let mut toolbar = row()
        .gap(8.0)
        .center_y()
        .child(
            text(if s.live {
                "Pi / local"
            } else {
                "Demo / offline"
            })
            .font(TextStyle::new(11.0, 500.0))
            .color(hex("#a6a8b0")),
        )
        .child(el().grow(1.0))
        .child(button("Reload JSON", "reload", |s| {
            reload(s);
            remember(s);
        }))
        .child(button("Restore", "restore", restore))
        .child(button("Undo", "undo", undo).disabled(s.previous.is_none()));
    if relaunch::has_backup() {
        toolbar =
            toolbar.child(button("Revert build", "revert-build", revert_build).disabled(s.busy));
    }
    if s.busy {
        toolbar = toolbar.child(button("Stop", "cancel", cancel));
    }
    let mut body = col().key("document-mount").w_full().grow(1.0).min_h(0.0);
    if let Some(n) = &s.document.root {
        body = body.child(render(s, n));
    }
    col()
        .w_full()
        .h_full()
        .fill(color(s, "background"))
        .child(body)
        .child(toolbar.px(16.0).py(8.0).fill(hex("#141518")))
}

type Renderer = fn(&State, &Node) -> El;
// Agent-editable native renderer registry. JSON cannot register code or invoke host actions.
const REGISTRY: &[(&str, u32, Renderer)] = &[
    ("column", 1, container),
    ("row", 1, container),
    ("card", 1, container),
    ("button", 1, chat_button),
    ("text", 1, label),
    ("header", 1, header),
    ("sidebar", 1, sidebar),
    ("transcript", 1, transcript),
    ("composer", 1, composer),
    ("divider", 1, divider),
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
fn hex(value: &str) -> Color {
    rune::color::hex(value).unwrap()
}

thread_local! {
    static FONT_FAMILY: std::cell::Cell<Option<&'static str>> = const { std::cell::Cell::new(None) };
    static FONT_NAMES: std::cell::RefCell<std::collections::HashMap<String, &'static str>> = std::cell::RefCell::new(std::collections::HashMap::new());
}
struct TextStyle;
impl TextStyle {
    #[allow(clippy::new_ret_no_self)]
    fn new(size: f32, weight: f32) -> RuneTextStyle {
        let mut style = RuneTextStyle::new(size, weight);
        if let Some(name) = FONT_FAMILY.with(|f| f.get()) {
            style = style.family(rune::tok::Family::Named(name));
        }
        style
    }
}

fn render(s: &State, n: &Node) -> El {
    let previous = FONT_FAMILY.with(|f| f.get());
    if let Some(name) = &n.style.font_family {
        let interned = FONT_NAMES.with(|names| {
            *names
                .borrow_mut()
                .entry(name.clone())
                .or_insert_with(|| Box::leak(name.clone().into_boxed_str()))
        });
        FONT_FAMILY.with(|f| f.set(Some(interned)));
    }
    let mut e = REGISTRY
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
        .key(format!("node-{}", n.id));
    let style = &n.style;
    if let Some(v) = style.width {
        e = e.w(v);
    }
    if let Some(v) = style.grow {
        e = e.grow(v);
    }
    if let Some(v) = style.padding {
        e = e.padding(v);
    }
    if let Some(v) = style.gap {
        e = e.gap(v);
    }
    if let Some(v) = style.radius {
        e = e.radius(v);
    }
    if style.font_size.is_some() || style.weight.is_some() {
        e = e.font(TextStyle::new(
            style.font_size.unwrap_or(15.0),
            style.weight.unwrap_or(400.0),
        ));
    }
    if let Some(v) = &style.fill {
        e = e.fill(hex(v));
    }
    if let Some(v) = &style.color {
        e = e.color(hex(v));
    }
    FONT_FAMILY.with(|f| f.set(previous));
    e
}
fn container(s: &State, n: &Node) -> El {
    let t = &s.document.theme;
    let mut e = if n.kind == "row" { row() } else { col() };
    e = e
        .w_full()
        .grow(if n.kind == "card" { 0.0 } else { 1.0 })
        .min_w(0.0)
        .min_h(0.0)
        .padding(t.padding)
        .gap(t.gap)
        .fill(color(
            s,
            if n.kind == "card" {
                "surface"
            } else {
                "background"
            },
        ));
    if n.kind == "card" {
        e = e.radius(t.radius);
    }
    for child in &n.children {
        e = e.child(render(s, child));
    }
    e
}
fn divider(s: &State, n: &Node) -> El {
    let thickness = n.data["thickness"]
        .as_f64()
        .filter(|v| v.is_finite())
        .unwrap_or(1.0)
        .clamp(0.5, 16.0) as f32;
    el().w_full().h(thickness).grow(0.0).fill(color(s, "muted"))
}

fn label(s: &State, n: &Node) -> El {
    text(&n.text)
        .wrap_anywhere()
        .w_full()
        .font(TextStyle::new(20.0, 500.0))
        .color(color(s, "text"))
}

fn header(s: &State, n: &Node) -> El {
    row()
        .w_full()
        .center_y()
        .justify_between()
        .child(
            text(&n.text)
                .font(TextStyle::new(16.0, 600.0))
                .color(color(s, "text")),
        )
        .child(
            text(if s.busy {
                "Working…"
            } else {
                "Native · local Pi"
            })
            .font(TextStyle::new(12.0, 400.0))
            .color(color(s, "muted")),
        )
}

fn new_chat(s: &mut State) {
    if s.busy {
        return;
    }
    remember(s);
    if s.transcript.is_empty() {
        return;
    }
    s.history.push(history::Conversation::default());
    s.active = s.history.len() - 1;
    s.transcript.clear();
    s.draft = TextEdit::default();
    *s.bridge.lock().unwrap() = None;
    s.status = "Ready".into();
    remember(s);
}

fn sidebar(s: &State, n: &Node) -> El {
    let mut conversations = col().w_full().grow(1.0).min_h(0.0).gap(6.0);
    for (index, chat) in s.history.iter().enumerate().rev() {
        let title = if index == s.active && !s.transcript.is_empty() {
            conversation_title(&s.transcript[0].content)
        } else {
            conversation_title(&chat.title)
        };
        conversations = conversations.child(
            text(title)
                .key(format!("chat-{index}"))
                .w_full()
                .wrap()
                .padding(10.0)
                .radius(8.0)
                .fill(if index == s.active {
                    color(s, "background")
                } else {
                    color(s, "surface")
                })
                .font(TextStyle::new(12.0, 500.0))
                .color(color(s, "text"))
                .role("button")
                .focusable(true)
                .disabled(s.busy)
                .on_press(move |s: &mut State| {
                    if s.busy || s.active == index {
                        return;
                    }
                    remember(s);
                    s.active = index;
                    s.transcript = s.history[index].messages.clone();
                    s.draft = TextEdit::default();
                    *s.bridge.lock().unwrap() = None;
                    s.status = "Conversation restored".into();
                    remember(s);
                }),
        );
    }
    col().h_full().padding(18.0).pt(30.0).gap(24.0).fill(color(s, "surface"))
        .child(text(&n.text).font(TextStyle::new(24.0, 600.0)).color(color(s, "text")))
        .child(button("New conversation", "new-chat", new_chat).disabled(s.busy).w_full())
        .child(conversations.scroll(ScrollSpec { stick_bottom: false }))
        .child(col().gap(8.0)
            .child(text("Make it yours.").font(TextStyle::new(14.0, 500.0)).color(color(s, "text")))
            .child(text("Ask for a card, a different layout, or a whole new look. It’s all one conversation.").wrap().w_full().font(TextStyle::new(12.0, 400.0)).color(color(s, "muted"))))
}

fn chat_button(s: &State, n: &Node) -> El {
    let prompt = n.data["prompt"].as_str().unwrap_or("").to_string();
    button(&n.text, &format!("action-{}", n.id), |_| {})
        .disabled(s.busy || prompt.is_empty())
        .on_press(move |s: &mut State| {
            s.draft = TextEdit::new(&prompt);
            submit(s);
        })
}
fn transcript(s: &State, _: &Node) -> El {
    if s.transcript.is_empty() {
        return col().w_full().grow(1.0).min_h(0.0).justify_center().gap(14.0)
            .child(text("What are we making today?").wrap().font(TextStyle::new(30.0, 500.0)).color(color(s, "text")))
            .child(text("A thought, a plan, a useful little interface.\nStart a conversation and shape this space as you go.").wrap().font(TextStyle::new(15.0, 400.0)).color(color(s, "muted")))
            .child(col().pt(16.0).gap(8.0)
                .child(button("Compare a few options in a table", "suggest-table", |s| { s.draft = TextEdit::new("Show me an illustrative table comparing three ways to spend a quiet Saturday."); submit(s); }).self_start())
                .child(button("Make a restaurant card", "suggest-restaurant", |s| { s.draft = TextEdit::new("Make an illustrative restaurant card in this chat. Be clear that it is not a real recommendation."); submit(s); }).self_start())
                .child(button("Give this app a new look", "suggest-app", |s| { s.draft = TextEdit::new("Change this entire app to a warmer dark plum theme, remove the sidebar and keep my chat and composer."); submit(s); }).self_start()));
    }
    let mut list = col().w_full().grow(1.0).min_h(0.0).gap(28.0).pb(12.0);
    for (index, message) in s.transcript.iter().enumerate() {
        let user = message.role == "You" || message.role == "user";
        let mut entry = col().key(format!("message-{index}")).w_full().gap(12.0);
        if user {
            entry = entry.child(
                text(&message.content)
                    .wrap_anywhere()
                    .max_w(580.0)
                    .self_end()
                    .padding(14.0)
                    .radius(s.document.theme.radius)
                    .fill(color(s, "surface"))
                    .font(TextStyle::new(15.0, 400.0))
                    .color(color(s, "text")),
            );
        } else {
            entry = entry
                .child(
                    text("Computah")
                        .font(TextStyle::new(13.0, 600.0))
                        .color(color(s, "muted")),
                )
                .child(
                    text(if message.content.is_empty() && s.busy {
                        "Thinking through it…"
                    } else {
                        &message.content
                    })
                    .wrap_anywhere()
                    .w_full()
                    .font(TextStyle::new(15.0, 400.0))
                    .color(color(s, "text")),
                );
            for card in &message.cards {
                entry = entry.child(render(s, card));
            }
        }
        list = list.child(entry);
    }
    list.scroll(ScrollSpec { stick_bottom: true })
}
fn composer(s: &State, _: &Node) -> El {
    col()
        .w_full()
        .gap(8.0)
        .child(
            col()
                .padding(16.0)
                .gap(12.0)
                .radius(16.0)
                .fill(color(s, "surface"))
                .child(
                    text_input(&s.draft, TextStyle::new(15.0, 400.0))
                        .key("prompt")
                        .label("Message Computah")
                        .placeholder("Ask anything. Change anything.", color(s, "muted"))
                        .w_full()
                        .min_h(44.0)
                        .max_h(140.0)
                        .min_w(0.0)
                        .color(color(s, "text"))
                        .on_edit(|s: &mut State| &mut s.draft)
                        .on_submit(|s: &mut State, _| submit(s)),
                )
                .child(
                    row()
                        .center_y()
                        .justify_between()
                        .child(
                            text(if s.busy {
                                "Working on your request…"
                            } else {
                                "Chat, cards, and your whole app"
                            })
                            .font(TextStyle::new(12.0, 400.0))
                            .color(color(s, "muted")),
                        )
                        .child(if s.busy {
                            button("Stop", "composer-stop", cancel)
                        } else {
                            button("Send", "generate", submit)
                                .fill(hex("#d9def2"))
                                .color(hex("#191c28"))
                                .disabled(s.draft.text.trim().is_empty())
                        }),
                ),
        )
        .child(
            text(&s.status)
                .font(TextStyle::new(11.0, 400.0))
                .color(color(s, "muted")),
        )
}
fn table(s: &State, n: &Node) -> El {
    let columns = n.data["columns"].as_array();
    let rows = n.data["rows"].as_array();
    let mut grid = col()
        .role("grid")
        .label("Generated data table")
        .w_full()
        .radius(s.document.theme.radius)
        .border(1.0, color(s, "surface"))
        .gap(1.0);
    if let Some(cols) = columns {
        let mut header = row().role("row").w_full();
        for c in cols.iter().take(8) {
            header = header.child(
                text(c.as_str().unwrap_or("?"))
                    .wrap_anywhere()
                    .role("columnheader")
                    .w(0.0)
                    .grow(1.0)
                    .padding(12.0)
                    .font(TextStyle::new(12.0, 600.0))
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
                            .wrap_anywhere()
                            .role("gridcell")
                            .w(0.0)
                            .grow(1.0)
                            .padding(12.0)
                            .font(TextStyle::new(13.0, 400.0))
                            .color(color(s, "text")),
                    );
                }
                grid = grid.child(line);
            }
        }
    } else {
        grid = grid.child(text("Table data unavailable").color(color(s, "muted")));
    }
    if n.text.is_empty() {
        grid
    } else {
        col()
            .w_full()
            .gap(12.0)
            .child(
                text(&n.text)
                    .font(TextStyle::new(16.0, 600.0))
                    .color(color(s, "text")),
            )
            .child(grid)
    }
}
fn restaurant(s: &State, n: &Node) -> El {
    col()
        .gap(12.0)
        .padding(20.0)
        .radius(s.document.theme.radius)
        .fill(color(s, "surface"))
        .child(
            text(n.data["name"].as_str().unwrap_or("Unnamed restaurant"))
                .wrap()
                .font(TextStyle::new(22.0, 600.0))
                .color(color(s, "text")),
        )
        .child(
            text(n.data["description"].as_str().unwrap_or(""))
                .wrap()
                .w_full()
                .color(color(s, "text")),
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
    let checkpoint = std::env::args().any(|arg| arg == "--verify-checkpoint");
    if checkpoint || std::env::args().any(|arg| arg == "--verify-reply") {
        use std::io::Read;
        let mut input = String::new();
        let valid = std::io::stdin()
            .take(if checkpoint {
                16 * 1024 * 1024 + 1
            } else {
                128 * 1024 + 1
            })
            .read_to_string(&mut input)
            .is_ok()
            && if checkpoint {
                history::admit(input.as_bytes()).is_ok()
            } else {
                document::parse_reply(&input).is_ok()
            };
        std::process::exit(if valid { 0 } else { 1 });
    }
    // A relaunch and a simultaneous Finder/Open request must not create two history writers.
    let isolated =
        std::env::args().any(|a| ["--mock", "--snap", "--scene", "--script"].contains(&a.as_str()));
    let mut instance = None;
    if !isolated {
        for _ in 0..if std::env::args().any(|a| a == "--relaunch") {
            40
        } else {
            1
        } {
            if let Ok(lock) = history::instance_lock() {
                instance = Some(lock);
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        if instance.is_none() {
            return;
        }
    }
    let _instance = instance;
    rune::App::new(AppSpec {
        poll: Some(poll),
        scenes: &[
            ("table", |s| {
                s.live = false;
                s.draft = TextEdit::new("table");
                submit(s);
            }),
            ("restaurant", |s| {
                s.live = false;
                s.draft = TextEdit::new("restaurant");
                submit(s);
            }),
            ("app", |s| {
                s.live = false;
                s.draft = TextEdit::new("change app theme and remove sidebar");
                submit(s);
            }),
            ("empty", |s| s.document.root = None),
            ("unknown", |s| {
                if let Some(n) = s.document.root.as_mut() {
                    n.kind = "future-widget".into();
                }
            }),
        ],
        ..AppSpec::new("Computah", (1100.0, 780.0), State::default, view)
    })
    .standard_menus()
    .keep_running()
    .run();
}

#[cfg(test)]
mod tests {
    use super::*;
    use rune::{Env, Runtime};

    #[test]
    fn long_conversation_text_survives_history_admission() {
        let content = "ordinary text ".repeat(12_000);
        let saved = history::Saved {
            document: document::default_document(),
            conversations: vec![history::Conversation {
                title: "Long conversation".into(),
                messages: vec![
                    Message::new("You", &content),
                    Message::new("Computah", &content),
                ],
            }],
            active: 0,
            previous: None,
            draft: String::new(),
            pending: None,
        };
        let restored = history::admit(&serde_json::to_vec(&saved).unwrap()).unwrap();
        assert_eq!(restored.conversations[0].messages[0].content, content);
        assert_eq!(restored.conversations[0].messages[1].content, content);
    }

    #[test]
    fn cards_stay_in_chat_and_app_changes_activate_with_undo() {
        let mut rt = Runtime::new(
            State {
                live: false,
                draft: TextEdit::new("restaurant"),
                ..State::default()
            },
            view,
            (1100.0, 780.0),
            Env {
                system_dark: true,
                scale: 1.0,
            },
        );
        rt.frame(0.0);
        let (x, y) = rt.find("generate").unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.016);
        assert!(rt.find("prompt").is_some());
        assert!(rt.find("node-message-2-generated").is_some());
        assert!(
            rt.find("apply").is_none(),
            "cards do not ask to replace the app"
        );
        rt.state.draft = TextEdit::new("change app theme and remove sidebar");
        rt.frame(0.016);
        let (x, y) = rt.find("generate").unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.016);
        assert!(
            rt.find("new-chat").is_none(),
            "validated app changes activate without approval"
        );
        assert_eq!(rt.state.document.theme.background, "#14121e");
        assert!(
            rt.find("node-message-2-generated").is_some(),
            "cards survive full-app changes"
        );
        let (x, y) = rt.find("undo").unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.016);
        assert!(rt.find("new-chat").is_some());
        assert_eq!(rt.state.transcript.len(), 4);
        let (x, y) = rt.find("new-chat").unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.016);
        assert!(rt.state.transcript.is_empty());
        let (x, y) = rt.find("chat-0").unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.016);
        assert_eq!(
            rt.state.transcript.len(),
            4,
            "new chat does not discard older conversations"
        );
    }

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
        let (x, y) = rt.find("generate").expect("action visible");
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.016);
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
        let mut value: serde_json::Value =
            serde_json::from_str(include_str!("../layout.json")).unwrap();
        value["root"]["children"][1]["children"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"kind":"composer","version":1,"id":"second-input"}));
        assert!(document::parse(&value.to_string()).is_err());
        let mut reply = serde_json::json!({"message":"Hi", "cards":[{
            "kind":"card","version":1,"id":"card","style":{"padding":12},
            "children":[{"kind":"button","version":1,"id":"next","text":"Continue","data":{"prompt":"Tell me more"}}]
        }],"app":null});
        assert!(document::parse_reply(&reply.to_string()).is_ok());
        reply["cards"][0]["children"][0]["kind"] = "composer".into();
        assert!(document::parse_reply(&reply.to_string()).is_err());
        reply["cards"][0]["children"][0]["kind"] = "button".into();
        reply["cards"][0]["style"]["padding"] = 65.into();
        assert!(document::parse_reply(&reply.to_string()).is_err());
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
