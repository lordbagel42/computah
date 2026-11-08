# Native chat design

Operate surface: Rune text and geometry, no DOM/webview. Neutral charcoal background
#111214, surface #1c1e22, foreground #ededee, muted #a6a8b0; 16pt gap, 24pt padding,
12pt radius. Rune's bundled sans fallback; 15pt conversation body, 16pt section heading,
24pt app title. Muted copy remains readable against both surfaces.

Default layout: 196pt sidebar, saved conversations and New conversation; flexible main
column with compact header, independently scrolling transcript and multiline input. User
bubbles align right, assistant prose and custom cards left. Send becomes Stop while busy.
No mode selector. Content wraps within available width; tables have native cell semantics.

json-render catalog Specs and per-node styles use the same native renderer in chat/app.
Validated changes swap the document automatically; conversation stays intact. No approval gate.
Installed named fonts inherit through native subtrees; no licensed assets are bundled.
Recovery strip uses stable neutral tokens outside that document and survives blank mounts.
Restore resets the app, Undo reverses one layout action, blank mounts remain recoverable.
The local owner can implement missing native capabilities through scoped source tools and
fixed verification/build/relaunch. Progress remains responsive; generated UI stays inert data.

Native screenshots and accessibility snapshots are the relevant visual/interaction checks;
web lintapple/DOM detectors do not evaluate Rune. OS accessibility was exercised on the Mac;
VoiceOver reading order, native IME and full keyboard/clipboard coverage remain unverified.
