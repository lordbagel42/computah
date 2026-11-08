//! Host-owned install/relaunch. Generated UI never chooses commands or target paths.
use std::io::{self, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

pub fn root() -> PathBuf {
    std::env::var_os("COMPUTAH_PROJECT_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

pub fn verify(saved: &crate::history::Saved) -> io::Result<()> {
    verify_with(
        root().join("target/debug/computah-rune-pi"),
        "--verify-checkpoint",
        &serde_json::to_string(saved)?,
    )
}

pub fn verify_previous(reply: &str) -> io::Result<()> {
    verify_with(
        std::env::current_exe()?.with_extension("previous"),
        "--verify-reply",
        reply,
    )
}

fn verify_with(executable: PathBuf, mode: &str, input: &str) -> io::Result<()> {
    let mut child = Command::new(executable)
        .arg(mode)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    child.stdin.take().unwrap().write_all(input.as_bytes())?;
    if child.wait()?.success() {
        Ok(())
    } else {
        Err(io::Error::other(
            "Candidate rejected the UI; running app retained",
        ))
    }
}

pub fn activate(rollback: bool) -> io::Result<()> {
    let executable = std::env::current_exe()?;
    let candidate = root().join("target/debug/computah-rune-pi");
    let backup = executable.with_extension("previous");
    // Only the dedicated installed bundle or this project's Cargo binary is replaceable.
    if !executable.ends_with("Computah.app/Contents/MacOS/Computah") && executable != candidate {
        return Err(io::Error::other("Not a Computah installation"));
    }
    if rollback || executable != candidate {
        let temporary = executable.with_extension("next");
        std::fs::copy(if rollback { &backup } else { &candidate }, &temporary)?;
        if !rollback {
            std::fs::copy(&executable, &backup)?;
        }
        std::fs::rename(&temporary, &executable)?;
    }
    let launch = Command::new(&executable)
        .arg("--relaunch")
        .current_dir(root())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    if let Err(error) = launch {
        if !rollback && backup.is_file() {
            let temporary = executable.with_extension("next");
            std::fs::copy(&backup, &temporary)?;
            std::fs::rename(temporary, executable)?;
        }
        return Err(error);
    }
    // Avoid retaining Pi or a build worker across app replacement.
    Ok(())
}

pub fn has_backup() -> bool {
    std::env::current_exe().is_ok_and(|path| path.with_extension("previous").is_file())
}
