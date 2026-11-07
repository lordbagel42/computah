# Native experiment design

Operate-mode proof, not the faithful June design. Black desktop canvas; native Rune text
and geometry, no DOM or webview. Inter is Rune's bundled fallback. The capsule composer
provides a visible request placeholder and a keyboard-submit path. Host controls expose
button roles/focus/disabled state; generated tables expose grid/row/header/cell semantics.

Document tokens: background #000000, surface #191919, foreground #f5f5f5, muted #b5b5b5,
16 pt gap, 24 pt padding, 16 pt radius. Default type is 15 pt body and 20 pt heading;
the registry/source, rather than a separate styling engine, owns component typography.
The recovery shell uses stable neutral tokens independent of a potentially broken theme.

Composition is data-only and removable. Generate creates a proposal, Apply mounts it,
Restore returns the embedded default without modifying disk. Unknown registry versions
produce visible inert fallback. Restaurant mock content is explicitly synthetic; missing
hours remain unknown. No imitation of the separately recovered v6 presence was added.

Native rendering and runtime input checks substitute for web-specific lintapple/HTML
detectors; those tools do not evaluate Rune. OS-level screen reader and IME tests remain
laptop gates, not claims established by the headless accessibility tree.
