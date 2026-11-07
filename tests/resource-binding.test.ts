import assert from "node:assert/strict";
import test from "node:test";
import { isResourceFreeReadOnly, RESOURCE_FREE_SCHEMA } from "../src/authorization/resource-binding.js";

test("resource-free binding accepts only the fixed empty READ_ONLY contract", () => {
  assert.equal(isResourceFreeReadOnly({ declaredProfile: "READ_ONLY", inputSchema: RESOURCE_FREE_SCHEMA }, {}), true);
  for (const declaredProfile of ["WRITE", "DESTRUCTIVE", "EXTERNAL_WRITE"])
    assert.equal(isResourceFreeReadOnly({ declaredProfile, inputSchema: RESOURCE_FREE_SCHEMA }, {}), false);
});

test("resource-free binding rejects target spoofing, encoded arguments and schema tricks", () => {
  for (const args of [{ resourceId: "allowed" }, { path: "../secret" }, { resourceId: "%2e%2e" }, { allowedResources: ["*"] }, [], null, "{}"])
    assert.equal(isResourceFreeReadOnly({ declaredProfile: "READ_ONLY", inputSchema: RESOURCE_FREE_SCHEMA }, args), false);
  for (const inputSchema of [
    { type: "object", properties: { path: { type: "string" } }, additionalProperties: false },
    { type: "object", properties: {}, additionalProperties: true },
    { type: "object", properties: {}, additionalProperties: false, anyOf: [] },
    { type: "object", properties: {}, additionalProperties: false, required: ["path"] },
  ]) assert.equal(isResourceFreeReadOnly({ declaredProfile: "READ_ONLY", inputSchema }, {}), false);
});
