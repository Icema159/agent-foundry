import { ValidationError } from "../registry/validation.js";

export function executorLeaseMs(raw: string | undefined): number {
  if (raw === undefined) return 30000;
  const value = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value) || value < 1000 || value > 120000)
    throw new ValidationError("FOUNDRY_EXECUTOR_LEASE_MS must be an integer between 1000 and 120000");
  return value;
}

export function generation(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 2147483647)
    throw new ValidationError("Invalid claim generation");
  return value;
}

export function pollLimit(value: unknown = 10): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 10)
    throw new ValidationError("Poll limit must be between 1 and 10");
  return value;
}
