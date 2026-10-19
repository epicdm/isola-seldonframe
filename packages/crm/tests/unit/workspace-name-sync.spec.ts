import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mutateWorkspaceName,
  replaceWorkspaceNameInHtml,
} from "../../src/lib/blueprint/mutate";

function blueprint(name: string) {
  return JSON.parse(JSON.stringify({
    workspace: { name },
    intake: { completion: { message: `Thanks from ${name}.` } },
    booking: { eventType: { title: `${name} consultation` } },
  }));
}

test("workspace rename updates the native blueprint name, intake completion and booking title", () => {
  const original = blueprint("Old Isola");

  const updated = mutateWorkspaceName(original, "New Isola", "Old Isola");

  assert.equal(updated.workspace.name, "New Isola");
  assert.equal(updated.intake.completion.message, "Thanks from New Isola.");
  assert.equal(updated.booking.eventType.title, "New Isola consultation");
  assert.equal(original.workspace.name, "Old Isola");
  assert.equal(original.intake.completion.message, "Thanks from Old Isola.");
});

test("workspace rename no-ops on stale blueprint state that does not match the locked old name", () => {
  const original = blueprint("Different Name");
  original.intake.completion.message = "Thanks from Old Isola.";
  original.booking.eventType.title = "Old Isola consultation";

  const updated = mutateWorkspaceName(original, "New Isola", "Old Isola");

  assert.equal(updated.workspace.name, "Different Name");
  assert.equal(updated.intake.completion.message, "Thanks from Old Isola.");
  assert.equal(updated.booking.eventType.title, "Old Isola consultation");
});

test("HTML rename changes only literal names and reports the occurrence count", () => {
  const source = '<nav>Old Isola</nav><main>Custom copy stays intact.</main><footer>Old Isola</footer>';
  const result = replaceWorkspaceNameInHtml(source, "Old Isola", "New Isola");

  assert.equal(result.replacements, 2);
  assert.equal(
    result.contentHtml,
    '<nav>New Isola</nav><main>Custom copy stays intact.</main><footer>New Isola</footer>'
  );
});

test("HTML rename handles renderer-escaped names and is idempotent", () => {
  const first = replaceWorkspaceNameInHtml("<footer>Acme &amp; Sons</footer>", "Acme & Sons", "New <Brand>");
  const second = replaceWorkspaceNameInHtml(first.contentHtml, "Acme & Sons", "New <Brand>");

  assert.equal(first.replacements, 1);
  assert.equal(first.contentHtml, "<footer>New &lt;Brand&gt;</footer>");
  assert.equal(second.replacements, 0);
  assert.equal(second.contentHtml, first.contentHtml);
});

test("HTML rename does not treat raw markup as an unescaped workspace name", () => {
  const result = replaceWorkspaceNameInHtml("<Brand>Navigation</Brand>", "<Brand>", "Uplink");

  assert.equal(result.replacements, 0);
  assert.equal(result.contentHtml, "<Brand>Navigation</Brand>");
});
