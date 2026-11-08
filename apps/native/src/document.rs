//! Native composition projection reused from the Rune study, not the public wire protocol.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Document {
    pub version: u32,
    pub theme: Theme,
    pub root: Option<Node>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub design: Option<Value>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Theme {
    pub background: String,
    pub surface: String,
    pub text: String,
    pub muted: String,
    pub gap: f32,
    pub padding: f32,
    pub radius: f32,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Node {
    pub kind: String,
    pub version: u32,
    pub id: String,
    #[serde(default)]
    pub style: Style,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub data: Value,
    #[serde(default)]
    pub children: Vec<Node>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub design: Option<Value>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Style {
    pub width: Option<f32>,
    pub grow: Option<f32>,
    pub padding: Option<f32>,
    pub gap: Option<f32>,
    pub radius: Option<f32>,
    pub font_size: Option<f32>,
    pub font_family: Option<String>,
    pub weight: Option<f32>,
    pub fill: Option<String>,
    pub color: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Reply {
    pub message: String,
    #[serde(default)]
    pub cards: Vec<Node>,
    pub app: Option<Document>,
}

pub fn default_document() -> Document {
    parse(include_str!("../layout.json")).expect("embedded layout is valid")
}

pub fn parse(input: &str) -> Result<Document, &'static str> {
    if input.len() > 128 * 1024 {
        return Err("Layout exceeds 128 KiB; retained previous layout.");
    }
    let doc: Document = serde_json::from_str(input)
        .map_err(|_| "Invalid layout JSON; retained previous layout.")?;
    validate(&doc)?;
    Ok(doc)
}

fn validate(doc: &Document) -> Result<(), &'static str> {
    if doc.version != 1 {
        return Err("Unsupported layout version; retained previous layout.");
    }
    let t = &doc.theme;
    if [&t.background, &t.surface, &t.text, &t.muted]
        .iter()
        .any(|s| rune::color::hex(s).is_none())
        || ![t.gap, t.padding, t.radius]
            .iter()
            .all(|v| v.is_finite() && (0.0..=64.0).contains(v))
    {
        return Err("Invalid theme; retained previous layout.");
    }
    fn visit(n: &Node, depth: usize, ids: &mut std::collections::HashSet<String>) -> bool {
        let s = &n.style;
        let bounded = |v: Option<f32>, low: f32, high: f32| {
            v.is_none_or(|v| v.is_finite() && (low..=high).contains(&v))
        };
        depth <= 12
            && ids.len() < 128
            && !n.id.is_empty()
            && ids.insert(n.id.clone())
            && bounded(s.width, 0.0, 1600.0)
            && bounded(s.grow, 0.0, 10.0)
            && [s.padding, s.gap, s.radius]
                .iter()
                .all(|v| bounded(*v, 0.0, 64.0))
            && bounded(s.font_size, 10.0, 48.0)
            && s.font_family
                .as_ref()
                .is_none_or(|name| !name.trim().is_empty() && name.len() <= 128)
            && bounded(s.weight, 100.0, 900.0)
            && [&s.fill, &s.color]
                .iter()
                .all(|v| v.as_ref().is_none_or(|v| rune::color::hex(v).is_some()))
            && n.children.iter().all(|c| visit(c, depth + 1, ids))
    }
    if doc
        .root
        .as_ref()
        .is_some_and(|n| !visit(n, 0, &mut Default::default()))
    {
        return Err("Layout is too deep, too large, or has duplicate/empty IDs.");
    }
    fn controls(n: &Node, seen: &mut std::collections::HashSet<String>) -> bool {
        (!["sidebar", "composer", "transcript"].contains(&n.kind.as_str())
            || seen.insert(n.kind.clone()))
            && n.children.iter().all(|child| controls(child, seen))
    }
    if doc
        .root
        .as_ref()
        .is_some_and(|n| !controls(n, &mut Default::default()))
    {
        return Err("Use one sidebar, transcript and composer per app.");
    }
    Ok(())
}

pub fn parse_reply(input: &str) -> Result<Reply, &'static str> {
    if input.len() > 128 * 1024 {
        return Err("Reply exceeds 128 KiB.");
    }
    let reply: Reply = serde_json::from_str(input).map_err(|_| "Invalid reply JSON.")?;
    // Validate cards through the same inert tree contract as the app, including aggregate
    // node count and unique IDs. Cards cannot mount live transcript/composer controls.
    let mut cards = default_document();
    cards.root = Some(Node {
        kind: "column".into(),
        version: 1,
        id: "_reply-root".into(),
        style: Style::default(),
        text: String::new(),
        data: Value::Null,
        children: reply.cards.clone(),
        design: None,
    });
    validate(&cards)?;
    fn inert(n: &Node) -> bool {
        !["transcript", "composer", "header", "sidebar"].contains(&n.kind.as_str())
            && n.children.iter().all(inert)
    }
    if !reply.cards.iter().all(inert) {
        return Err("Chat cards cannot contain app controls.");
    }
    if let Some(app) = &reply.app {
        validate(app)?;
    }
    Ok(reply)
}
