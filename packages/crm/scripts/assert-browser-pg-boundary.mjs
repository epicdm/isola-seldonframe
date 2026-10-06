import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
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

function markerContext(contents, marker, radius = 72) {
  const index = contents.indexOf(marker);
  if (index < 0) return null;
  const start = Math.max(0, index - radius);
  const end = Math.min(contents.length, index + marker.length + radius);
  return contents.slice(start, end).replace(/[\r\n\t]/g, " ");
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

function sourceMapEntries(map) {
  if (Array.isArray(map.sections)) return map.sections.flatMap((section) => sourceMapEntries(section.map));
  return (map.sources ?? []).map((source, index) => ({
    source,
    content: map.sourcesContent?.[index] ?? null,
  }));
}

async function reportSourceMap(chunkPath) {
  try {
    const map = JSON.parse(await readFile(`${chunkPath}.map`, "utf8"));
    const entries = sourceMapEntries(map);
    const appEntries = entries.filter(({ source }) =>
      source.includes("packages/crm/src/") || source.includes("/src/")
    );
    console.error(`[browser-pg-boundary] sourcemap sources for ${chunkPath.split("/").pop()}: ${appEntries.length} app modules`);
    for (const { source, content } of appEntries) {
      console.error(`[browser-pg-boundary] source ${source}`);
      if (!content) continue;
      const imports = content.split(/\r?\n/).filter((line) => /^\s*(?:import|export)\b/.test(line)).slice(0, 8);
      for (const line of imports) console.error(`[browser-pg-boundary] import ${source}: ${line.trim().slice(0, 240)}`);
    }
  } catch (error) {
    console.error(`[browser-pg-boundary] no readable source map for ${chunkPath.split("/").pop()}: ${error.code ?? error.name}`);
  }
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
    for (let index = 0; index < files.length; index += 1) {
      const fileMarkers = findNodePgBrowserMarkers([contents[index]]);
      if (fileMarkers.length) {
        console.error(`[browser-pg-boundary] ${relative(staticDirectory, files[index])}: ${fileMarkers.join(", ")}`);
        for (const marker of fileMarkers) {
          const context = markerContext(contents[index], marker);
          if (context) console.error(`[browser-pg-boundary] context ${marker}: ${JSON.stringify(context)}`);
        }
        await reportSourceMap(files[index]);
      }
    }
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
