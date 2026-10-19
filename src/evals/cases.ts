import { createHash } from "node:crypto";

export type EvalAssertion =
  | { type: "completed" }
  | { type: "answer_contains"; text: string }
  | { type: "tool_calls"; tool: string; min?: number; max?: number }
  | { type: "no_runtime_failure" }
  | { type: "max_model_calls"; count: number }
  | { type: "max_duration_ms"; milliseconds: number };

export type EvalCase = {
  id: string;
  name: string;
  prompt: string;
  description?: string;
  assertions: EvalAssertion[];
};

export function defineEvalCase(value: EvalCase): EvalCase {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.id)) throw new Error("Invalid eval case ID");
  if (!value.name.trim() || !value.prompt.trim() || !value.assertions.length) throw new Error("Eval case needs a name, prompt and assertions");
  for (const assertion of value.assertions) {
    switch (assertion.type) {
      case "completed": case "no_runtime_failure": break;
      case "answer_contains":
        if (!assertion.text.trim()) throw new Error("answer_contains needs non-empty text");
        break;
      case "tool_calls":
        if (!assertion.tool.trim() || (assertion.min === undefined && assertion.max === undefined)) throw new Error("tool_calls needs a tool and min/max");
        for (const bound of [assertion.min, assertion.max]) if (bound !== undefined) nonNegativeInteger(bound);
        if (assertion.min !== undefined && assertion.max !== undefined && assertion.min > assertion.max) throw new Error("tool_calls min exceeds max");
        break;
      case "max_model_calls": nonNegativeInteger(assertion.count); break;
      case "max_duration_ms": nonNegativeInteger(assertion.milliseconds); break;
      default: throw new Error("Unknown eval assertion");
    }
  }
  return structuredClone(value);
}

function nonNegativeInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Assertion bound must be a non-negative integer");
}

export function caseRevision(value: EvalCase): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export const evalCases: EvalCase[] = [
  {
    id: "locate-model-provider-factory", name: "Locate model provider factory",
    prompt: "Find where ModelProviderFactory is implemented and explain its purpose. Use repository search and cite the implementation file path.",
    description: "Checks repository evidence, implementation path and the named symbol.",
    assertions: [
      { type: "completed" },
      { type: "tool_calls", tool: "search_files", min: 1 },
      { type: "answer_contains", text: "src/model/model-provider-factory.ts" },
      { type: "answer_contains", text: "ModelProviderFactory" },
      { type: "no_runtime_failure" },
    ],
  },
  {
    id: "find-docker-sandbox", name: "Find Docker sandbox implementation",
    prompt: "Find the Docker sandbox implementation and summarize its isolation, including the network policy. Cite the implementation file path.",
    assertions: [
      { type: "completed" },
      { type: "answer_contains", text: "src/sandbox/docker-sandbox.ts" },
      { type: "answer_contains", text: "network" },
      { type: "no_runtime_failure" },
    ],
  },
  {
    id: "permission-enforcement", name: "Locate permission enforcement",
    prompt: "Find where TOOL_PERMISSION_DENIED is enforced. Explain the check and cite the runtime implementation file path.",
    assertions: [
      { type: "completed" },
      { type: "answer_contains", text: "TOOL_PERMISSION_DENIED" },
      { type: "answer_contains", text: "src/runtime/agent-runtime.ts" },
      { type: "no_runtime_failure" },
    ],
  },
].map(value => defineEvalCase(value as EvalCase));

export function getEvalCase(id: string): EvalCase {
  const value = evalCases.find(item => item.id === id);
  if (!value) throw new Error(`Unknown eval case: ${id}`);
  return structuredClone(value);
}
