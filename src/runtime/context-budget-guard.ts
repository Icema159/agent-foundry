import type { ModelRequest } from "../model/types.js";
import type { ContextProtectionConfig } from "./context-protection-config.js";

export type ContextBudgetDiagnostic = {
  contextWindowTokens: number;
  estimatedInputTokens: number;
  inputBudgetTokens: number;
  reservedOutputTokens: number;
  safetyMarginTokens: number;
};

export class ContextBudgetGuard {
  constructor(
    private readonly contextWindowTokens: number | undefined,
    private readonly config: ContextProtectionConfig,
  ) {}

  check(request: ModelRequest): ContextBudgetDiagnostic | undefined {
    if (this.contextWindowTokens === undefined) return undefined;
    // Conservative heuristic, not an exact tokenizer: one UTF-8 byte per token,
    // plus allowances for provider chat templates and tool-schema wrappers.
    const estimatedInputTokens = Buffer.byteLength(JSON.stringify(request), "utf8")
      + 512 + request.messages.length * 96 + request.tools.length * 64;
    const inputBudgetTokens = Math.max(0,
      this.contextWindowTokens - this.config.reservedOutputTokens - this.config.safetyMarginTokens);
    if (estimatedInputTokens <= inputBudgetTokens) return undefined;
    return {
      contextWindowTokens: this.contextWindowTokens, estimatedInputTokens, inputBudgetTokens,
      reservedOutputTokens: this.config.reservedOutputTokens,
      safetyMarginTokens: this.config.safetyMarginTokens,
    };
  }
}
