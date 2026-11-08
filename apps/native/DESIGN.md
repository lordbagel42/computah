# Native conversation surface

Operate mode. Visual authority: approved Figma reference exports in
`ui/reference/{desktop,mobile}-slack.png` and `ui/IMPORT-PLAN.md`; June is provenance
only. Black canvas, neutral rounded living panels, sparse bubbles, compact dim
right-aligned Slack ingress and capsule composer are preserved. Desktop places
panels beside conversation; below 760 logical pixels Panels switches to a separate
panel surface rather than squeezing chat. This is a native adaptation, **not** a
pixel-exact Figma port. No Tasks/Goals navigation or unsupported call/mic buttons.

Theme background/surface/text/muted/gap/padding/radius and per-node bounded style
are versioned inert data. Registered native components define semantic internals;
owner source edits can extend those internals. Layout, controls, content groups,
tables and cards can be recomposed. Restore/Undo deliberately live outside the
replaceable root. Font family is a scoped inherited context applied to individual
Rune text and input elements: Rune containers do not inherit it automatically.
Installed OS fonts only; no licensed font copied. Interned families are bounded.

`computah.native@1` derives from the tested Mac study, not a rewritten clone of
json-render: actual defineSchema/defineCatalog, flat Spec `{root,elements,state}`,
real SpecStream JSONL compiler, core state/visibility/action parameter resolution.
Registry: Row, Column, Card, Divider, Text, Button, Table, Restaurant and native-only
Sidebar, Header, Transcript, Composer, Empty. Divider thickness 0.5–16 (default 1),
style.fill sets its color. Sidebar/Transcript/Composer are singleton controls;
Header is repeatable text. Only Button press → `chat.send {message}`. The original
`{catalog,spec}` stays in design metadata after materialization; legacy native
trees remain readable. Whole replacements only; private SpecStream patches never
mount before validation and are not a fabricated public streaming wire protocol.

Unsupported repeat/watch/slots/directives reject. State/visibility resolves at
materialization, not two-way/watch behavior. 128 KiB document/output, 128 app nodes,
depth 12, 12 cards and 120 aggregate card nodes. Empty app root is legal; blank
inline card is not. Native and Slack must explicitly project one semantic catalog:
native controls, blank composition and state do **not** imply Slack export/parity.
This packet implements only the native projection; no competing Slack renderer.

Reusable Table exposes grid/row/columnheader/gridcell semantics and lexicographic
column sorting. Restaurant states missing photo and unknown hours explicitly;
synthetic fixtures are not live search or reservations. In real mode public unknown
component versions use fallback, never unsafe props or executable handlers.

The v6 presence source is a later faithful port, not generic animation equivalence.
Desktop keyboard and pointer, focus rings and native text input are implemented.
Physical phone packaging, touch/soft-keyboard behavior, IME composition, assistive
technology announcements, OS text scaling, reduced-motion and high-contrast modes
remain platform acceptance gates; a narrow Linux capture is not an iOS app test.
