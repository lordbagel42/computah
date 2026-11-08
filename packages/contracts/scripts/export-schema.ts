import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { Schema } from "effect";
import {
  AccountHandle,
  BrowserSessionHandle,
  BusOutput,
  BusReceipt,
  BusSendRequest,
  CancelRequest,
  CancelResult,
  OperatorHistoryPage,
  OperatorSnapshot,
  SendRequest,
  Snapshot,
  StreamEvent,
  Submission,
  SubmissionObservation,
  SubmissionObservationEvent,
  Viewer,
  WireError,
} from "../src/index.js";

const schemas = {
  AccountHandle,
  BrowserSessionHandle,
  BusOutput,
  BusReceipt,
  BusSendRequest,
  Viewer,
  Snapshot,
  OperatorSnapshot,
  OperatorHistoryPage,
  SendRequest,
  Submission,
  CancelRequest,
  CancelResult,
  StreamEvent,
  SubmissionObservation,
  SubmissionObservationEvent,
  WireError,
};
const directory = new URL("../fixtures/v1/schema/", import.meta.url);
const checkOnly = process.argv.includes("--check");
if (!checkOnly) await mkdir(directory, { recursive: true });
for (const [name, schema] of Object.entries(schemas)) {
  const document = Schema.toJsonSchemaDocument(schema, {
    onExcessProperty: "error",
  });
  const generated = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...document.schema,
    $defs: document.definitions,
  };
  const path = new URL(`${name}.json`, directory);
  if (checkOnly) {
    if (
      !isDeepStrictEqual(JSON.parse(await readFile(path, "utf8")), generated)
    ) {
      throw new Error(
        `${name} schema is stale; run pnpm --filter @computah/contracts schema`,
      );
    }
  } else {
    await writeFile(path, `${JSON.stringify(generated, null, 2)}\n`);
  }
}
