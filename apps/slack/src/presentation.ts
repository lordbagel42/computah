// One post, below Slack's 40,000 text / 50 block / 3,000 section limits.
// Count UTF-16 units after escaping (conservative for astral characters).
const MAX_TEXT = 29_000;
const MAX_SECTIONS = 20;
const SECTION_TEXT = 2900;
const OMISSION =
  "\n[Answer shortened for Slack: the remaining text exceeded this message's presentation budget.]";

function escapeSlack(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function link(token: string) {
  const match =
    /^\[([^\]\n|<>]+)\]\((https?:\/\/[^\s<>|()[\]`]+)\)$/.exec(token) ??
    /^<(https?:\/\/[^\s<>|]+)\|([^\n|<>]+)>$/.exec(token);
  if (!match) return escapeSlack(token);
  const markdown = token.startsWith("[");
  const target = match[markdown ? 2 : 1];
  const label = match[markdown ? 1 : 2];
  try {
    const url = new URL(target);
    if (!url.hostname || url.username || url.password)
      return escapeSlack(token);
    // No normalization: URL case, percent escapes and query bytes are content.
    return `<${escapeSlack(target)}|${escapeSlack(label)}>`;
  } catch {
    return escapeSlack(token);
  }
}

/** Pure text projection. No model actions, controls, files or extra posts. */
export function presentSlack(text: string) {
  const sections: string[] = [];
  let section = "";
  let fallback = "";
  let fence = false;
  let shortened = false;
  // Preserve inline code and links atomically, and never interpret links in code.
  // Markdown destinations containing parentheses/brackets/backticks are ambiguous
  // here: leave them literal rather than guess or change their target bytes.
  const prose =
    /```|`[^`\n]*`|\[[^\]\n]+\]\(https?:\/\/[^\s<>|()[\]`]+\)|<https?:\/\/[^\s<>|]+\|[^\n<>]+>|https?:\/\/[^\s<>`]+|[^\s`<[]{1,80}|[\s\S]/uy;
  const code = /```|[\s\S]/uy;
  let offset = 0;
  while (offset < text.length) {
    const pattern = fence ? code : prose;
    pattern.lastIndex = offset;
    const token: string = pattern.exec(text)?.[0] ?? text[offset];
    const rendered =
      fence || token.startsWith("`") ? escapeSlack(token) : link(token);
    const nextFence: boolean = token === "```" ? !fence : fence;
    // Reserve room for closing/reopening fences and the omission section.
    if (
      rendered.length > SECTION_TEXT - 8 ||
      fallback.length + rendered.length > MAX_TEXT
    ) {
      shortened = true;
      break;
    }
    if (section.length + rendered.length + (nextFence ? 4 : 0) > SECTION_TEXT) {
      if (sections.length >= MAX_SECTIONS - 2) {
        shortened = true;
        break;
      }
      sections.push(section + (fence ? "\n```" : ""));
      section = fence ? "```\n" : "";
    }
    section += rendered;
    fallback += rendered;
    fence = nextFence;
    offset += token.length;
  }
  if (fence) {
    section += "\n```";
    fallback += "\n```";
  }
  if (section) sections.push(section);
  if (shortened) {
    sections.push(OMISSION);
    fallback += OMISSION;
  }
  // Slack requires nonempty section text, even for an empty core answer.
  if (!sections.length) sections.push("[Empty answer]");
  return {
    text: fallback || "[Empty answer]",
    blocks: sections.map((content) => ({
      type: "section" as const,
      text: { type: "mrkdwn" as const, text: content, verbatim: true },
    })),
  };
}
