//! Local conversation storage. No Pi auth, protocol events or raw model output is stored.
use crate::{Message, document::Document};
use serde::{Deserialize, Serialize};
use std::{io, path::PathBuf};

#[derive(Clone, Deserialize, Serialize)]
pub struct Conversation {
    pub title: String,
    pub messages: Vec<Message>,
}

impl Default for Conversation {
    fn default() -> Self {
        Self {
            title: "New conversation".into(),
            messages: vec![],
        }
    }
}

#[derive(Deserialize, Serialize)]
pub struct Saved {
    pub document: Document,
    pub conversations: Vec<Conversation>,
    pub active: usize,
    #[serde(default)]
    pub previous: Option<Document>,
    #[serde(default)]
    pub draft: String,
    // Host-owned checkpoint consumed once by the rebuilt binary. Never executed as code.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<String>,
}

fn path() -> io::Result<PathBuf> {
    if let Some(path) = std::env::var_os("RUNE_PI_HISTORY") {
        return Ok(path.into());
    }
    let home = std::env::var_os("HOME").ok_or_else(|| io::Error::other("No home directory"))?;
    let folder = if cfg!(target_os = "macos") {
        "Library/Application Support/Computah"
    } else {
        ".local/share/computah"
    };
    Ok(PathBuf::from(home).join(folder).join("conversations.json"))
}

pub fn load() -> io::Result<Option<Saved>> {
    let mut migrate = false;
    let data = match std::fs::read(path()?) {
        Ok(data) => data,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            if std::env::var_os("RUNE_PI_HISTORY").is_some() {
                return Ok(None);
            }
            let home =
                std::env::var_os("HOME").ok_or_else(|| io::Error::other("No home directory"))?;
            let legacy = PathBuf::from(home).join(if cfg!(target_os = "macos") {
                "Library/Application Support/June Rune/conversations.json"
            } else {
                ".local/share/june-rune/conversations.json"
            });
            match std::fs::read(legacy) {
                Ok(data) => {
                    migrate = true;
                    data
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
                Err(e) => return Err(e),
            }
        }
        Err(e) => return Err(e),
    };
    let mut saved = admit(&data)?;
    // Rename host identity, not user/assistant message content or custom layout styling.
    for chat in &mut saved.conversations {
        for message in &mut chat.messages {
            if message.role == "June" {
                message.role = "Computah".into();
                migrate = true;
            }
        }
    }
    fn rename(node: &mut crate::document::Node) -> bool {
        let mut changed = false;
        if ["sidebar", "header"].contains(&node.kind.as_str())
            && ["June", "June Rune", "June · Rune + local Pi"].contains(&node.text.as_str())
        {
            node.text = "Computah".into();
            changed = true;
        }
        for child in &mut node.children {
            changed |= rename(child);
        }
        changed
    }
    if let Some(root) = &mut saved.document.root {
        migrate |= rename(root);
    }
    if migrate {
        // Validated data is copied to the new location; the legacy file stays untouched.
        // An existing Computah history always wins and is never merged with stale history.
        save(&saved)?;
    }
    Ok(Some(saved))
}

// Shared by normal loading and the candidate binary's no-window checkpoint preflight.
pub fn admit(data: &[u8]) -> io::Result<Saved> {
    let saved: Saved = serde_json::from_slice(data)?;
    if saved.active >= saved.conversations.len() {
        return Err(io::Error::other("Invalid active conversation"));
    }
    for document in std::iter::once(&saved.document).chain(saved.previous.as_ref()) {
        crate::document::parse(&serde_json::to_string(document)?).map_err(io::Error::other)?;
    }
    for message in saved.conversations.iter().flat_map(|chat| &chat.messages) {
        // Ordinary conversation text is not a generated UI envelope. Revalidate the
        // inert cards without imposing the materializer's reply budget on saved text.
        crate::document::parse_reply(
            &serde_json::json!({"message":"","cards":message.cards,"app":null}).to_string(),
        )
        .map_err(io::Error::other)?;
    }
    if let Some(pending) = &saved.pending {
        crate::document::parse_reply(pending).map_err(io::Error::other)?;
    }
    Ok(saved)
}

pub fn instance_lock() -> io::Result<std::fs::File> {
    let lock = path()?.with_extension("lock");
    std::fs::create_dir_all(lock.parent().unwrap())?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock)?;
    file.try_lock().map_err(io::Error::other)?;
    Ok(file)
}

pub fn save(saved: &Saved) -> io::Result<()> {
    use std::io::Write;
    let path = path()?;
    std::fs::create_dir_all(
        path.parent()
            .ok_or_else(|| io::Error::other("Invalid history path"))?,
    )?;
    let temporary = path.with_extension("json.tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    file.write_all(&serde_json::to_vec(saved)?)?;
    file.sync_all()?;
    std::fs::rename(temporary, path)
}
