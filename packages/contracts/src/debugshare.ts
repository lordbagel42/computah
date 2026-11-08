/** Opaque report identity only: never authority to read a report or its scope. */
export const debugshareIdPattern =
  "(?:computah_bug_[a-z0-9]{24}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})";

const pattern = new RegExp(`^(?:${debugshareIdPattern})$`, "u");
export type DebugshareId = string & { readonly __debugshareId: unique symbol };

export const isDebugshareId = (value: unknown): value is DebugshareId =>
  typeof value === "string" && pattern.test(value);
