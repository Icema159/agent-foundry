export type ContextProtectionConfig = {
  maxToolResultBytes: number;
  reservedOutputTokens: number;
  safetyMarginTokens: number;
};

export function readContextProtectionConfig(): ContextProtectionConfig {
  return {
    maxToolResultBytes: readInteger("FOUNDRY_TOOL_RESULT_MAX_BYTES", 8000, 512),
    reservedOutputTokens: readInteger("FOUNDRY_CONTEXT_RESERVED_OUTPUT_TOKENS", 2048, 1),
    safetyMarginTokens: readInteger("FOUNDRY_CONTEXT_SAFETY_MARGIN_TOKENS", 1024, 1),
  };
}

function readInteger(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer >= ${minimum}`);
  }
  return value;
}
