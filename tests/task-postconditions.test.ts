import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { TaskPostconditionVerifier, parsePostconditions } from "../src/verification/task-postconditions.js";
import { parseTaskInput } from "../src/cli/task-input.js";

test("CLI separates repeated expected-file conditions from the original prompt", () => {
  assert.deepEqual(parseTaskInput(["--expect-created-file", "./note.md", "--expect-created-file", "other.txt", "Create both files"]), {
    prompt: "Create both files", postconditions: [{ type: "file_created", path: "note.md" }, { type: "file_created", path: "other.txt" }],
  });
  assert.deepEqual(parseTaskInput(["Find all TODOs"]), { prompt: "Find all TODOs", postconditions: [] });
  assert.throws(() => parseTaskInput(["--expect-created-file"]), /requires a file path/);
  assert.throws(() => parseTaskInput(["--expect-created-file", "note.md"]), /Usage/);
  for (const file of ["../escape", "/tmp/escape", ".", "foo/../bar", "a\0b"]) {
    assert.throws(() => parsePostconditions([{ type: "file_created", path: file }]));
  }
  assert.throws(() => parsePostconditions([{ type: "unknown", path: "note.md" }]));
});

test("verification requires both successful tool evidence and the actual regular file", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "foundry-postconditions-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const verifier = new TaskPostconditionVerifier();
  const conditions = parsePostconditions([{ type: "file_created", path: "note.md" }]);
  const success = { name: "create_file", result: { path: "./note.md", created: true } };
  assert.equal((await verifier.verify(root, conditions, [success]))[0]?.passed, false);
  await fs.writeFile(path.join(root, "note.md"), "A note");
  assert.equal((await verifier.verify(root, conditions, []))[0]?.passed, false);
  assert.equal((await verifier.verify(root, conditions, [{ name: "create_file", result: { error: "TOOL_APPROVAL_DENIED" } }]))[0]?.passed, false);
  assert.equal((await verifier.verify(root, conditions, [{ name: "create_file", result: { path: "other.md", created: true } }]))[0]?.passed, false);
  assert.equal((await verifier.verify(root, conditions, [success]))[0]?.passed, true);
});

test("verification rejects symlinks escaping the workspace and non-files", async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "foundry-postcondition-paths-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "workspace");
  await fs.mkdir(root);
  await fs.writeFile(path.join(parent, "outside.txt"), "outside");
  await fs.symlink(parent, path.join(root, "escape"));
  await fs.symlink(path.join(parent, "outside.txt"), path.join(root, "link.txt"));
  await fs.mkdir(path.join(root, "directory"));
  const verifier = new TaskPostconditionVerifier();
  for (const file of ["escape/outside.txt", "link.txt", "directory"]) {
    const check = await verifier.verify(root, [{ type: "file_created", path: file }], [{ name: "create_file", result: { path: file, created: true } }]);
    assert.equal(check[0]?.passed, false);
    assert.equal(check[0]?.fileExists, false);
  }
});
