import assert from "node:assert/strict";
import test from "node:test";
import { executorLeaseMs, generation } from "../src/executor/protocol-validation.js";

test("executor leases have a bounded, explicitly validated configuration", () => {
  assert.equal(executorLeaseMs(undefined), 30000);
  assert.equal(executorLeaseMs("1000"), 1000);
  assert.equal(executorLeaseMs("120000"), 120000);
  for (const raw of ["", "0", "-1", "999", "120001", "1.5", "invalid", "9007199254740992"])
    assert.throws(() => executorLeaseMs(raw));
});

test("executor fencing generations require positive bounded integers", () => {
  assert.equal(generation(1), 1);
  for (const value of ["1", 0, -1, 1.5, 2147483648, null, undefined]) assert.throws(() => generation(value));
});
