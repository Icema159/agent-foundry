import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { RepositoryTools, ToolInputError } from "../src/tools/repository-tools.js";

test("repository discovery and reads share a fail-closed visibility policy", async t => {
  const parent = await mkdtemp(path.join(tmpdir(), "foundry-visibility-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "workspace");
  const marker = "SYNTHETIC_SECRET_SHOULD_NOT_APPEAR";
  const denied = [
    ".env", ".ENV.production", "nested/.env.local", ".env.example", ".envrc",
    ".npmrc", ".netrc", ".git-credentials", ".ssh/config", ".aws/credentials",
    ".config/gcloud/application_default_credentials.json", ".docker/config.json",
    "nested/service-account.json", "nested/id_ed25519", "nested/private.PEM",
    "nested/signing.key", "nested/store.p12", ".git/config",
  ];
  const ordinary = ["README.md", "nested/app.ts", "nested/config.json"];
  for (const file of [...denied, ...ordinary]) {
    const absolute = path.join(root, file);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, denied.includes(file) ? `visible-query ${marker}\n` : "visible-query\n");
  }
  await writeFile(path.join(parent, "outside.txt"), marker);
  await symlink(".env", path.join(root, "harmless.txt"));
  await symlink(".aws", path.join(root, "local-settings"));
  await symlink("nested/app.ts", path.join(root, "safe-link.ts"));
  await symlink("../outside.txt", path.join(root, "outside-link.txt"));
  await symlink("missing.txt", path.join(root, "broken.txt"));
  await link(path.join(root, ".env"), path.join(root, "hardlink.txt"));
  const tools = await RepositoryTools.create(root);

  assert.deepEqual(await tools.execute("list_files", {}), { files: ordinary });
  assert.deepEqual(await tools.execute("search_files", { query: marker }), { matches: [] });
  assert.deepEqual(await tools.execute("search_files", { query: "visible-query" }), {
    matches: ordinary.map(file => ({ path: file, line: 1, text: "visible-query" })),
  });
  for (const file of ordinary) {
    assert.deepEqual(await tools.execute("read_file", { path: `./${file}` }), {
      path: `./${file}`, content: "visible-query\n",
    });
  }
  for (const file of [...denied, "./.env", "nested/../.env", "harmless.txt",
    "local-settings/credentials", "safe-link.ts", "hardlink.txt", "outside-link.txt",
    "broken.txt", "../outside.txt", path.join(root, ".env"), "missing.txt", "nested"]) {
    await assert.rejects(() => tools.execute("read_file", { path: file }), (error: unknown) => {
      assert.ok(error instanceof ToolInputError, file);
      assert.equal(error.message, "Requested repository file is unavailable");
      return true;
    }, file);
  }
});
