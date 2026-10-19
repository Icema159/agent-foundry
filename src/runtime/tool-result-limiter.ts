export type ToolResultLimitDiagnostic = {
  code: "TOOL_RESULT_TOO_LARGE" | "TOOL_RESULT_OUTPUT_OMITTED";
  limitBytes: number;
  resultBytes: number;
};

export class ToolResultLimiter {
  constructor(private readonly limitBytes: number) {}

  limit(result: unknown, readOnly: boolean): { content: string; diagnostic?: ToolResultLimitDiagnostic } {
    const content = JSON.stringify(result);
    const resultBytes = Buffer.byteLength(content, "utf8");
    if (resultBytes <= this.limitBytes) return { content };
    const diagnostic: ToolResultLimitDiagnostic = {
      code: readOnly ? "TOOL_RESULT_TOO_LARGE" : "TOOL_RESULT_OUTPUT_OMITTED",
      limitBytes: this.limitBytes, resultBytes,
    };
    return {
      diagnostic,
      content: JSON.stringify(readOnly ? {
        ...diagnostic, complete: false,
        instruction: "Result too large. Request a smaller portion; for read_file use startLine and maxLines.",
      } : {
        ...diagnostic, executionReturned: true, outputOmitted: true,
        instruction: "The tool executed and returned. Its actual result is preserved in execution history. Output omission is not an execution failure. Do not repeat the action because its output was omitted.",
      }),
    };
  }
}
