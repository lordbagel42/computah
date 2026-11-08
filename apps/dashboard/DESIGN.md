# Operator surface design

This surface extends Computah's selected Figma/native visual world; it does not
replace it. Source: `ui/IMPORT-PLAN.md`, inspected desktop Slack Figma export,
and native owner token/semantic-boundary handoff. No shipping raster assets.

## Tokens and composition

| Role                                              | Value                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Canvas / panel / control / assistant text surface | #000 / #111 / #1C1C1C / #242424                                                                |
| Main / secondary text                             | #F5F5F5 / #B0B0B0                                                                              |
| Interaction / Task / Worker                       | #80B8FF / #BBA4F4 / #65DCAF                                                                    |
| Focus / selection                                 | 2px blue outline with 4px offset / #48405B background                                          |
| Typography                                        | Platform system stack; monospace only for actual identities                                    |
| Type scale                                        | 12px evidence notes; 14px body/controls; 16px sections; 20px product; 28px title (24px narrow) |
| Spacing                                           | 8px compact; 12px controls; 20–24px panel inset; 24px workspace gap; 32px page inset           |
| Geometry                                          | 24px flat panel corners (20px narrow); 16px messages/task rows; capsule buttons                |

Desktop pairs conversation text with the execution path, a selectable delegation
ledger and Worker evidence. It deliberately avoids generic infrastructure
metrics, fake activity charts and global admin navigation. At 1100px evidence
columns stack; at 760px all regions stack with conversation first, preserving
the DOM/keyboard reading sequence. No content is
hidden solely for narrow widths. IDs wrap; long text remains plain text.

Selection changes only the evidence pane and pressed state, preserving keyboard
focus. Hover/selected styles distinguish rows without making color the only
status signal. Controls and message anchors have at least 44px height. Motion is
limited to a 140ms background/border response and honors reduced motion.

Signed-out, initial core failure, stale-refresh failure, absent Task/actor/text,
truncated text and pagination are visible states rather than synthetic success.
The synthetic validation scope is explicitly labeled. Real mode identifies core
configuration, not provider entitlement or successful deployment.
