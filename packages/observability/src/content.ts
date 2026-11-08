/** Private operation evidence only. Never feed this projection to public telemetry. */
export const contentKinds = [
  "incoming",
  "final",
  "model.input",
  "model.output",
  "tool.call",
  "tool.result",
  "activity",
] as const;
export type RuntimeContentKind = (typeof contentKinds)[number];

const secrets = new Set<string>();
let redactionReady = true;
const credentialKey =
  /authorization|headers|cookie|password|passwd|secret|token(?!s$)|api[_-]?key|credential|private[_-]?key|signature/i;
const hiddenKey =
  /^(thinking|reasoning|reasoningContent|thinkingSignature|encrypted_content|chain_of_thought|cot)$/i;

/** Host-owned credentials, not principal identities. Bounded to avoid unbounded retention. */
export function registerContentSecrets(values: readonly string[]) {
  for (const value of values) {
    if (!value || secrets.has(value)) continue;
    if (value.length > 65_536 || secrets.size >= 512) redactionReady = false;
    else secrets.add(value);
  }
}

/** Never evict known credentials or keep exporting after registration overflow. */
export function contentRedactionReady() {
  return redactionReady;
}

/** Called at bootstrap: extract credentials from structured auth config, not entire histories. */
export function registerContentEnvironment(env: NodeJS.ProcessEnv) {
  for (const [key, value] of Object.entries(env)) {
    if (!value || (!credentialKey.test(key) && !/AUTH_JSON/.test(key)))
      continue;
    registerContentSecrets([value]);
    if (/^[[{]/.test(value)) {
      try {
        const visit = (item: unknown, depth: number) => {
          if (!item || typeof item !== "object") return;
          const entries = Object.entries(item);
          if (depth > 8 || entries.length > 128) {
            redactionReady = false;
            return;
          }
          for (const [name, child] of entries) {
            if (credentialKey.test(name) && typeof child === "string")
              registerContentSecrets([child]);
            else visit(child, depth + 1);
          }
        };
        visit(JSON.parse(value), 0);
      } catch {
        // A malformed optional secret cannot break application bootstrap.
      }
    }
  }
}

function redact(text: string) {
  let safe = text;
  for (const secret of secrets) safe = safe.replaceAll(secret, "[redacted]");
  return safe
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      "[redacted private key]",
    )
    .replace(/\b(?:Bearer|Basic)\s+[^\s<>"',;]+/gi, "[redacted authorization]")
    .replace(
      /\b(?:sk-[a-zA-Z0-9_-]{8,}|xox[baprs]-[a-zA-Z0-9-]+|gh[pousr]_[a-zA-Z0-9_]+|github_pat_[a-zA-Z0-9_]+)\b/g,
      "[redacted credential]",
    )
    .replace(
      /\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g,
      "[redacted credential]",
    )
    .replace(
      /\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]*/gi,
      "[redacted header]",
    )
    .replace(
      /((?:password|passwd|secret|token|access_token|refresh_token|api[_-]?key|client_secret)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi,
      '$1"[redacted]"',
    )
    .replace(
      /((?:authorization|cookie|password|passwd|secret|token|access_token|refresh_token|api[_-]?key|client_secret)["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi,
      "$1[redacted]",
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@");
}

/** Positive envelope; bounded JSON projection with explicit omitted/truncated evidence. */
export function projectContent(payload: unknown) {
  let truncated = false;
  let redacted = false;
  let remaining = 32_768;
  let nodes = 0;
  const seen = new WeakSet<object>();
  const missing = new Set<string>();
  const text = (value: string) => {
    // Enough lookahead for every registered secret crossing the emitted prefix.
    const input = value.slice(0, 131_072);
    if (input !== value) truncated = true;
    const safe = redact(input);
    redacted ||= safe !== input;
    // Bound encoded JSON bytes (including escaping), not JS UTF-16 length alone.
    const limit = Math.min(16_384, remaining);
    let bounded = safe.slice(0, limit);
    while (Buffer.byteLength(JSON.stringify(bounded)) > limit && bounded.length)
      bounded = bounded.slice(0, Math.floor(bounded.length * 0.8));
    if (bounded !== safe) truncated = true;
    remaining -= Buffer.byteLength(JSON.stringify(bounded));
    return bounded;
  };
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 1024 || depth > 12 || remaining < 16) {
      truncated = true;
      return "[truncated]";
    }
    if (typeof value === "string") return text(value);
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (!value || typeof value !== "object") {
      missing.add("unsupported_value");
      return null;
    }
    if (seen.has(value)) {
      missing.add("cyclic_value");
      return null;
    }
    seen.add(value);
    const type = Object.getOwnPropertyDescriptor(value, "type")?.value;
    if (
      typeof type === "string" &&
      /^(thinking|reasoning|redacted_thinking)$/i.test(type)
    ) {
      missing.add("hidden_reasoning_excluded");
      return "[hidden reasoning excluded]";
    }
    if (Array.isArray(value)) {
      if (value.length > 128) truncated = true;
      const result: unknown[] = [];
      for (let i = 0; i < Math.min(128, value.length); i++) {
        if (nodes >= 1024 || remaining < 16) {
          truncated = true;
          break;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !("value" in descriptor)) {
          missing.add("accessor_excluded");
          result.push(null);
        } else result.push(visit(descriptor.value, depth + 1));
      }
      return result;
    }
    const result: Record<string, unknown> = Object.create(null);
    const keys = Object.keys(value);
    if (keys.length > 64) truncated = true;
    for (const key of keys.slice(0, 64)) {
      if (nodes >= 1024 || remaining < 16) {
        truncated = true;
        break;
      }
      if (hiddenKey.test(key)) {
        missing.add("hidden_reasoning_excluded");
        continue;
      }
      if (
        credentialKey.test(key) &&
        !/^(input_tokens|output_tokens|totalTokens|total_tokens|cache_read_tokens|cache_write_tokens|reasoning_tokens)$/i.test(
          key,
        )
      ) {
        redacted = true;
        result[text(key)] = "[redacted]";
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        missing.add("accessor_excluded");
        continue;
      }
      result[text(key)] = visit(descriptor.value, depth + 1);
    }
    return result;
  };
  try {
    const data = visit(payload, 0);
    const serialized = JSON.stringify(data);
    if (Buffer.byteLength(serialized) > 65_536)
      return {
        payload: "null",
        truncated: true,
        redacted,
        missing: "record_limit",
      };
    return {
      payload: serialized,
      truncated,
      redacted,
      missing: [...missing].join(",") || "none",
    };
  } catch {
    return {
      payload: "null",
      truncated: true,
      redacted,
      missing: "projection_failed",
    };
  }
}

/** OTel GenAI messages only, using the same private credential/content boundary. */
export function projectChatMessages(messages: unknown): string | undefined {
  if (!Array.isArray(messages) || !contentRedactionReady()) return undefined;
  // Prioritize the latest request/response within the shared bounded projection.
  const projected = projectContent(messages.slice(-64).reverse());
  const data: unknown = JSON.parse(projected.payload);
  if (!Array.isArray(data)) return undefined;
  const result = data.flatMap((message) => {
    if (
      !message ||
      !["system", "user", "assistant", "tool"].includes(message.role) ||
      !Array.isArray(message.parts)
    )
      return [];
    const parts = message.parts.flatMap((part: Record<string, unknown>) => {
      if (!part || typeof part !== "object") return [];
      if (part.type === "text" && typeof part.content === "string")
        return [{ type: "text", content: part.content }];
      if (
        part.type === "tool_call" &&
        typeof part.id === "string" &&
        typeof part.name === "string"
      )
        return [
          {
            type: "tool_call",
            id: part.id,
            name: part.name,
            arguments: part.arguments,
          },
        ];
      if (part.type === "tool_call_response" && typeof part.id === "string")
        return [
          { type: "tool_call_response", id: part.id, response: part.response },
        ];
      return [];
    });
    const finishReason = [
      "stop",
      "length",
      "content_filter",
      "tool_call",
      "error",
      "aborted",
      "pending",
      "deferred",
    ].includes(message.finish_reason)
      ? message.finish_reason
      : undefined;
    return parts.length || finishReason
      ? [
          {
            role: message.role,
            parts,
            ...(finishReason ? { finish_reason: finishReason } : {}),
          },
        ]
      : [];
  });
  return JSON.stringify(result.reverse());
}
