// A fresh Node process avoids Pi's TS module cache after self-editing the catalog.
import { CATALOG_VERSION, catalog, renderReply } from "./ui-catalog.mjs";

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 160 * 1024)
    throw new Error("UI request exceeds budget");
}
try {
  const request = JSON.parse(input);
  const output =
    request.operation === "catalog"
      ? {
          catalogVersion: CATALOG_VERSION,
          schema: catalog.jsonSchema(),
          prompt: catalog.prompt(),
        }
      : request.operation === "render"
        ? renderReply(request.input)
        : null;
  if (!output) throw new Error("Unknown UI operation");
  process.stdout.write(JSON.stringify(output));
} catch (error) {
  process.stderr.write(String(error.message).slice(0, 16000));
  process.exitCode = 1;
}
