import { readFile } from "node:fs/promises";
import { renderReply } from "./ui-catalog.mjs";

const name = process.argv[2];
if (!["table", "restaurant", "empty"].includes(name))
  throw new Error("Unknown fixture");
const theme = JSON.parse(
  await readFile(new URL("../layout.json", import.meta.url), "utf8"),
).theme;
const input = JSON.parse(
  await readFile(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"),
);
process.stdout.write(JSON.stringify(renderReply(input, theme)));
