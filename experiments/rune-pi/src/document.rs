//! Experiment-local composition, not the portable frontend wire protocol.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Document {
    pub version: u32,
    pub theme: Theme,
    pub root: Option<Node>,
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
    pub text: String,
    #[serde(default)]
    pub data: Value,
    #[serde(default)]
    pub children: Vec<Node>,
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
        depth <= 12
            && ids.len() < 128
            && !n.id.is_empty()
            && ids.insert(n.id.clone())
            && n.children.iter().all(|c| visit(c, depth + 1, ids))
    }
    if doc
        .root
        .as_ref()
        .is_some_and(|n| !visit(n, 0, &mut Default::default()))
    {
        return Err("Layout is too deep, too large, or has duplicate/empty IDs.");
    }
    Ok(doc)
}

pub fn mock(prompt: &str) -> String {
    let mut doc = default_document();
    let kind = if prompt.to_lowercase().contains("restaurant") {
        "restaurant"
    } else {
        "table"
    };
    doc.root = if prompt.to_lowercase().contains("empty") {
        None
    } else {
        Some(Node {
            kind: kind.into(),
            version: 1,
            id: "generated".into(),
            text: String::new(),
            children: vec![],
            data: if kind == "restaurant" {
                serde_json::json!({"name":"Example Kitchen", "description":"Synthetic restaurant card; reusable data, not a recommendation.", "photo":null, "timezone":"America/Boise", "schedule":null})
            } else {
                serde_json::json!({"columns":["Component", "State"], "rows":[["Native Rune", "Rendered"],["Local Pi", "Mock — no credentials"]]})
            },
        })
    };
    serde_json::to_string_pretty(&doc).unwrap()
}
