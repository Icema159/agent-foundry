import assert from "node:assert/strict";
import test from "node:test";
import { canonical, manifest, positiveInteger, ValidationError } from "../src/registry/validation.js";

const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false };
const tool = { name: "read_file", revision: 1, description: "Read a file", inputSchema: schema, declaredProfile: "READ_ONLY", handlerId: "files.read" };

test("canonical digest is stable across object key order and changes with content", () => {
  assert.equal(canonical({ a: 1, b: { x: 2, y: 3 } }).digest, canonical({ b: { y: 3, x: 2 }, a: 1 }).digest);
  assert.notEqual(canonical({ a: 1 }).digest, canonical({ a: 2 }).digest);
  assert.throws(() => canonical({ x: Infinity }), ValidationError);
  assert.throws(() => canonical({ x: "a".repeat(65537) }), ValidationError);
});

test("manifest accepts bounded supported JSON schemas and stable descriptor digests", () => {
  const first = manifest({ tools: [tool] });
  assert.equal(first.tools[0]!.declaredProfile, "READ_ONLY");
  assert.equal(first.digest, manifest({ tools: [{ handlerId: "files.read", declaredProfile: "READ_ONLY", inputSchema: schema,
    description: "Read a file", revision: 1, name: "read_file" }] }).digest);
});

test("manifest rejects invalid profiles, duplicates, revisions, schema and size", () => {
  for (const input of [
    { tools: [{ ...tool, declaredProfile: "UNKNOWN" }] },
    { tools: [tool, tool] },
    { tools: [{ ...tool, revision: 0 }] },
    { tools: [{ ...tool, inputSchema: { ...schema, $ref: "remote" } }] },
    { tools: [{ ...tool, inputSchema: { ...schema, additionalProperties: true } }] },
    { tools: [{ ...tool, inputSchema: { ...schema, required: ["missing"] } }] },
    { tools: [{ ...tool, description: "x".repeat(2001) }] },
    { tools: Array.from({ length: 33 }, (_, n) => ({ ...tool, name: `tool${n}` })) },
    { tools: [{ ...tool, unexpected: true }] },
  ]) assert.throws(() => manifest(input), ValidationError);
  let nested: unknown = { type: "string" };
  for (let i = 0; i < 8; i++) nested = { type: "array", items: nested };
  assert.throws(() => manifest({ tools: [{ ...tool, inputSchema: { type: "object", properties: { deep: nested }, additionalProperties: false } }] }), ValidationError);
  for (const invalid of [0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER]) assert.throws(() => positiveInteger(invalid), ValidationError);
});
