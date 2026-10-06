import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const NODE_PG_BROWSER_MARKERS = [
  "pg-protocol",
  "pg-cloudflare",
  "pg-native",
  "pgpass",
  "pg-pool",
  "pg-types",
  "postgres-array",
  "postgres-bytea",
  "postgres-date",
  "postgres-interval",
  "pg-int8",
  "ConnectionParameters",
];

export function findNodePgBrowserMarkers(contents) {
  const found = new Set();
  for (const content of contents) {
    for (const marker of NODE_PG_BROWSER_MARKERS) {
      if (content.includes(marker)) found.add(marker);
    }
  }
  return [...found].sort();
}

async function collectJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectJavaScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(path);
  }
  return files;
}

async function main() {
  const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
  const staticDirectory = resolve(here, "../.next/static");
  const files = await collectJavaScriptFiles(staticDirectory);
  if (files.length === 0) {
    console.error("[browser-pg-boundary] no emitted JavaScript chunks found");
    process.exitCode = 1;
    return;
  }

  const contents = await Promise.all(files.map((path) => readFile(path, "utf8")));
  const markers = findNodePgBrowserMarkers(contents);
  if (markers.length) {
    console.error(`[browser-pg-boundary] node-postgres runtime markers found: ${markers.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  console.log(`[browser-pg-boundary] OK — scanned ${files.length} emitted client JavaScript chunks`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch(() => {
    console.error("[browser-pg-boundary] failed to read emitted client chunks");
    process.exitCode = 1;
  });
}
