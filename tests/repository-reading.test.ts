import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { RepositoryTools, ToolInputError } from "../src/tools/repository-tools.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "foundry-reading-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, tools: await RepositoryTools.create(root) };
}

test("small file ranges preserve LF, CRLF, BOM, unterminated lines and exact totals", async t => {
  const { root, tools } = await fixture(t);
  const content = "\uFEFFfirst\r\nsecond\n\nlast";
  await fs.writeFile(path.join(root, "lines.txt"), content);
  assert.deepEqual(await tools.execute("read_file", { path: "lines.txt" }), { path: "lines.txt", content });
  assert.deepEqual(await tools.execute("read_file", { path: "lines.txt", startLine: 2, maxLines: 2 }), {
    path: "lines.txt", content: "second\n\n", startLine: 2, endLine: 3, totalLines: 4, complete: false,
  });
  assert.deepEqual(await tools.execute("read_file", { path: "lines.txt", maxLines: Number.MAX_SAFE_INTEGER }), {
    path: "lines.txt", content, startLine: 1, endLine: 4, totalLines: 4, complete: true,
  });
  assert.deepEqual(await tools.execute("read_file", { path: "lines.txt", startLine: Number.MAX_SAFE_INTEGER }), {
    path: "lines.txt", content: "", startLine: Number.MAX_SAFE_INTEGER, endLine: 4, totalLines: 4, complete: false,
  });
  await fs.writeFile(path.join(root, "empty"), "");
  assert.deepEqual(await tools.execute("read_file", { path: "empty", maxLines: 1 }), {
    path: "empty", content: "", startLine: 1, endLine: 0, totalLines: 0, complete: true,
  });
});

test("UTF-8 and CRLF may span reads without changing returned bytes", async t => {
  const { root, tools } = await fixture(t);
  const first = "x".repeat(16383) + "😀\r\n";
  const second = "ą".repeat(8188) + "zz\r\n";
  await fs.writeFile(path.join(root, "split.txt"), first + second + "tail\n");
  assert.equal(Buffer.byteLength(first + second) % 16384, 1);
  assert.deepEqual(await tools.execute("read_file", { path: "split.txt", maxLines: 2 }), {
    path: "split.txt", content: first + second, startLine: 1, endLine: 2, totalLines: 3, complete: false,
  });
});

test("a large file stops after the requested range and does not claim a total", async t => {
  const { root, tools } = await fixture(t);
  await fs.writeFile(path.join(root, "large.txt"), "first\r\nsecond\r\n" + "other\n".repeat(200_000));
  const actualOpen = fs.open;
  let bytes = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await actualOpen(...args);
    const read = file.read.bind(file);
    file.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
      const result = await read(buffer, offset, length, position);
      bytes += result.bytesRead;
      return result;
    }) as typeof file.read;
    return file;
  });
  assert.deepEqual(await tools.execute("read_file", { path: "large.txt", startLine: 2, maxLines: 1 }), {
    path: "large.txt", content: "second\r\n", startLine: 2, endLine: 2, complete: false,
  });
  assert.equal(bytes, 16 * 1024);
});

test("output caps omit whole lines, including UTF-8 text whose JSON encoding exceeds the cap", async t => {
  const { root, tools } = await fixture(t);
  const file = path.join(root, "long.txt");
  for (const longLine of ["x".repeat(100_000), "\t".repeat(40_000)]) {
    await fs.writeFile(file, "first\n" + longLine + "\nlast");
    assert.deepEqual(await tools.execute("read_file", { path: "long.txt" }), {
      path: "long.txt", content: "first\n", startLine: 1, endLine: 1, totalLines: 3, complete: false, truncationReason: "OUTPUT_LIMIT",
    });
    assert.deepEqual(await tools.execute("read_file", { path: "long.txt", startLine: 3 }), {
      path: "long.txt", content: "last", startLine: 3, endLine: 3, totalLines: 3, complete: false,
    });
  }
  await fs.writeFile(file, "x".repeat(600_000));
  assert.deepEqual(await tools.execute("read_file", { path: "long.txt", maxLines: 1 }), {
    path: "long.txt", content: "", startLine: 1, endLine: null, totalLines: 1, complete: false, truncationReason: "OUTPUT_LIMIT",
  });
});

test("the scan limit never returns a partial line or a fabricated total", async t => {
  const { root, tools } = await fixture(t);
  const file = path.join(root, "cap.txt");
  const data = Buffer.alloc(8 * 1024 * 1024 + 2, 0x61);
  data[1] = 10;
  data[data.length - 1] = 10;
  await fs.writeFile(file, data);
  assert.deepEqual(await tools.execute("read_file", { path: "cap.txt", startLine: 2, maxLines: 1 }), {
    path: "cap.txt", content: "", startLine: 2, endLine: null, complete: false, truncationReason: "SCAN_LIMIT",
  });
  assert.deepEqual(await tools.execute("search_files", { query: "a" }), {
    matches: [{ path: "cap.txt", line: 1, text: "a" }], complete: false,
  });
});

test("search caps match output across files and reports an incomplete search", async t => {
  const { root, tools } = await fixture(t);
  const text = "x".repeat(40_000);
  await fs.writeFile(path.join(root, "a.txt"), text + "\n");
  await fs.writeFile(path.join(root, "b.txt"), text + "\n");
  assert.deepEqual(await tools.execute("search_files", { query: "x" }), {
    matches: [{ path: "a.txt", line: 1, text }], complete: false,
  });
});

test("invalid UTF-8 and NUL data are rejected, including a dangling UTF-8 sequence at EOF", async t => {
  const { root, tools } = await fixture(t);
  for (const data of [Buffer.from([0, 1, 2]), Buffer.from([0xff]), Buffer.from([0xe2, 0x82])]) {
    await fs.writeFile(path.join(root, "binary.dat"), Buffer.concat([Buffer.from("marker\n"), data]));
    await assert.rejects(tools.execute("read_file", { path: "binary.dat", maxLines: 1 }), (error: unknown) =>
      error instanceof ToolInputError && error.message === "Requested repository file is not supported UTF-8 text");
    assert.deepEqual(await tools.execute("search_files", { query: "marker" }), { matches: [] });
  }
});

test("a path replacement, new hardlink or content mutation during reading yields no output", async t => {
  for (const mutate of ["symlink", "hardlink", "write"] as const) await t.test(mutate, async sub => {
    const { root, tools } = await fixture(sub);
    const filePath = path.join(root, "visible.txt");
    await fs.writeFile(filePath, "original\n");
    await fs.writeFile(path.join(root, ".env"), "SYNTHETIC_SECRET");
    const actualOpen = fs.open;
    sub.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const file = await actualOpen(...args);
      const read = file.read.bind(file);
      file.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await read(buffer, offset, length, position);
        if (mutate === "symlink") {
          await fs.rename(filePath, path.join(root, "retired.txt"));
          await fs.symlink(".env", filePath);
        } else if (mutate === "hardlink") {
          await fs.link(filePath, path.join(root, "second.txt"));
        } else {
          await fs.appendFile(filePath, "changed\n");
        }
        return result;
      }) as typeof file.read;
      return file;
    });
    await assert.rejects(tools.execute("read_file", { path: "visible.txt", maxLines: 1 }), (error: unknown) =>
      error instanceof ToolInputError && error.message === "Requested repository file is unavailable");
  });
});
