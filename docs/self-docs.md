# Agent-readable living self-docs

**Implemented in source; local, built-image and live acceptance are separate.**
Interaction and Workers install native Pi Durable 1.5.0 tools
`self_docs_discover` and `self_docs_read` on each wake, including existing actors.
They read the canonical shipped `docs/*.md` files, not a generated copy, remote
GitHub checkout, search index or private actor file store. No shell or Git
executable is invoked. The Docker image packages the same canonical docs.

The instructions on each wake direct both roles to check these docs before
guessing about Computah's own behavior or asking the user to explain its commands.
They point to `index` for subsystem discovery and `slack` for `DEBUGSHARE`;
likely misspellings are lookup clues, never commands to execute. Unavailable or
inconclusive checks must remain explicit. Interaction also checks available
context and makes a quick relevant authorized lookup before asking about an
unfamiliar reference, without exhaustive research or disclosing private context
in public searches. This is model guidance, not deterministic tool selection or
proof of live conversational acceptance.

## Inputs and bounded results

- `self_docs_discover({offset?: number})` returns up to eight code-allowlisted
  document IDs, actual availability, byte sizes and SHA-256 hashes; follow
  `nextOffset` until null. Missing/unsafe files are explicitly unavailable and
  the page is partial, never silently described as implemented capability.
- `self_docs_read({id, offset?: number, sha256?: string})` accepts an exact
  discovered ID, never a path or URL. It returns verbatim Markdown, at most 8192
  UTF-16 code units, explicit `offsetUnit`, full-file SHA-256, byte length and
  `nextOffset`. Continuation requires the returned hash; changed content returns
  `changed` rather than mixing revisions. Restart at zero after rediscovery.
  Reads reject offsets splitting a surrogate pair; returned continuations do not.
- Each result identifies `shipped_canonical_docs`, `data_not_grants` and a full
  host-supplied `COMPUTAH_REVISION` when valid. Otherwise revision is null with
  `revisionSource: unavailable`; content hashes still identify actual bytes.
  There is no Git/cwd/HOME fallback or claim that a host label attests clean source.

### Example: explain a Computah command

For “What does DEBUGSHARE do?”, discover IDs with `self_docs_discover({})`,
then read `self_docs_read({id:"index"})` to locate the Slack guide. Read
`self_docs_read({id:"slack"})`, not `slack.md` or a filesystem path. If that
result has a non-null `nextOffset`, continue with
`self_docs_read({id:"slack",offset:page.nextOffset,sha256:page.sha256})`, where
`page` is the preceding result. Repeat until `nextOffset` is null; the relevant
command description may not be on the first page. These are native tool-call
examples, not shell commands; substitute the actual returned offset and hash.

If discovery is partial, inspect each entry's `available` flag and continue its
discovery `nextOffset` separately from document paging. A `changed` read means
rediscover and restart that document at zero, not concatenate old and new pages.
An `unavailable` or `cancelled` result is not a completed check: explain what
could not be read rather than guessing the command's behavior. If a guide links
to an integration README outside the allowlist, that link alone does not make
the README accessible through these tools.

Documents are capped at 256 KiB, read into a bounded buffer, decoded as strict
UTF-8 and hashed on demand. There is no retained document cache. Discovery does
not crawl directories or follow links. Only the fixed top-level Markdown IDs in
the module are eligible; arbitrary filenames, dotfiles, private histories,
credentials, directories, special files and symlinks are unavailable. The trusted
shipped image/root must not be concurrently replaced by privileged host code;
these tools are not a sandbox against an administrator mutating ancestor paths.
Results stay below the native 64 KiB output cap, including JSON escaping.

## Authority, replay and observability

These public repository docs need no additional tenant grant beyond the existing
authenticated actor boundary. Tool results do not confer permissions. Preserve
the source's exact implemented/planned, local/enabled/live distinctions. Linked
files outside the allowlist are not automatically readable. Source-lineage fences
also cover these tools in source-bound conversations.

Operations are replay-safe reads with no automatic retry or background job.
Recovery can reread shipped bytes; hash-pinned continuations reject changes.
Cancellation is checked before I/O, between bounded reads and before disclosure;
an in-flight local filesystem syscall is awaited and its descriptor closed before
settlement. Cancellation and unavailable/invalid/changed results are typed failures,
not successful operations. The tools' own operation spans/logs omit document text,
selected ID, path, hash, caller identity and raw errors. Fixed
`computah.self_docs.discover/read` spans inherit the native Pi carrier; shared
bounded structured logs retain the same trace/span identity through the sanitized
Axiom path. Separately, opt-in private content capture
(`COMPUTAH_AXIOM_CONTENT_ENABLED=1`) can record bounded native tool arguments and
results, including document IDs and returned Markdown. That private log path is
not the content-free public trace projection; see
[private operation content](observability.md#deployed-private-content-acceptance)
for the bounded historical receipt and its limits.

Local native tests exercise discovery, hash-pinned paging, Task/Worker use,
Interaction/Worker sleep/reopen, unsafe paths/files, failures and cancellation,
and sanitized span/log parent continuity. Local exporter acceptance is not remote
Axiom ingestion. Abrupt process death during a read and hostile privileged root
replacement are not independently proved. Built-image and deployment receipts
must be verified separately; source publication alone enables neither live model
tool selection nor evidence of live collection.

A bounded historical live receipt is recorded under
[deployed private-content acceptance](observability.md#deployed-private-content-acceptance):
at revision `ab6567b` on 2026-11-08, the backend model called `self_docs_read`
for `self-docs` and returned a ready result with a linked native child span.
That receipt does not prove current deployment, every document, Worker discovery
or the later command-lookup guidance's conversational acceptance.
