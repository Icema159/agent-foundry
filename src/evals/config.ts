import { repositoryExplorerInstructions } from "../agents/repository-explorer.js";
import type { AgentDefinition } from "../persistence/execution-store.js";

export function evalAgent(spec: string): AgentDefinition {
  const match = /^(ollama|openai)\/(.+)@(\d+)$/.exec(spec);
  if (!match || !Number.isSafeInteger(Number(match[3])) || Number(match[3]) < 1) {
    throw new Error("Model configuration must be provider/model@version (e.g. ollama/qwen3.5:9b@2)");
  }
  return {
    name: "repository-explorer", description: "Foundry-owned read-only repository analysis agent",
    version: Number(match[3]), modelProvider: match[1]!, modelName: match[2]!,
    systemInstructions: repositoryExplorerInstructions, maxSteps: 8,
    toolPolicies: { list_files: "ALLOW", search_files: "ALLOW", read_file: "ALLOW", create_file: "REQUIRE_APPROVAL", delete_file: "REQUIRE_APPROVAL" },
  };
}
