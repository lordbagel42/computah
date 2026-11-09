import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function equalSecret(provided: string, expected?: string): boolean {
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return (
    Boolean(expected && expected.length >= 32) &&
    timingSafeEqual(hash(provided), hash(expected ?? ""))
  );
}

export function signedCapture(
  body: string,
  timestamp: string,
  signature: string,
  secret: string,
  now = Date.now(),
) {
  return (
    /^\d{13}$/.test(timestamp) &&
    Math.abs(now - Number(timestamp)) <= 300_000 &&
    /^[a-f0-9]{64}$/.test(signature) &&
    equalSecret(
      signature,
      createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex"),
    )
  );
}

/** Bytes, not Content-Length, are authoritative. Reject malformed UTF-8. */
export async function boundedBody(
  request: Request,
  limit: number,
): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("Body too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
