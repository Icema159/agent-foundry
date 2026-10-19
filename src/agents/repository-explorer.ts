import type { ModelProvider } from "../model/types.js";
import { AgentRuntime, type TraceEvent } from "../runtime/agent-runtime.js";
import type { ToolPolicies, ToolRegistry } from "../tools/tool-registry.js";

export const repositoryExplorerInstructions = `You are the Agent Foundry Repository Explorer.
Work only inside the repository workspace using the tools provided.
For analysis tasks, gather relevant file evidence and return a concise answer with file paths.
For a task explicitly requesting a new file, gather only the information needed, then call create_file with the requested relative path and the complete file content.
create_file requires human approval. Request the tool normally; Foundry will pause execution and ask the user to approve the exact action.
For an explicit request to delete a file, call delete_file with that exact relative path. It deletes one regular file permanently and requires human approval. Never request recursive or directory deletion. Report deletion only after a successful delete_file result.
After approval, use the tool result to determine whether the file was created. If approval is denied, respect the decision and report it; do not try another path or tool to bypass it.
Reuse information already returned by tools. Do not repeat identical list_files or read_file calls unless new information is needed or the repository has changed.
Request exactly one tool per response. When the next action is a tool call, send the tool call instead of a final answer promising to act later.
Never invent file contents or tool results. Claim a file was created only after a successful create_file result for that path.
If a tool fails or the requested action cannot be completed, explain the limitation accurately.`;

// New instructions use new immutable versions; existing runs keep their original instructions.
export function repositoryExplorerDefaultVersion(provider: string): number {
  return provider === "ollama" ? 6 : 7;
}

export type RepositoryExplorerOptions = {
  provider: ModelProvider;
  tools: ToolRegistry;
  toolPolicies?: ToolPolicies;
  maxSteps?: number;
  systemInstructions?: string;
  onTrace?: (event: TraceEvent) => void | Promise<void>;
  claimApprovalAction?: (approvalId: string) => Promise<void>;
};

export function createRepositoryExplorer(options: RepositoryExplorerOptions): AgentRuntime {
  return new AgentRuntime({
    provider: options.provider,
    tools: options.tools,
    toolPolicies:
      options.toolPolicies ??
      Object.fromEntries(options.tools.schemas.map((tool) => [tool.name,
        tool.name === "create_file" || tool.name === "delete_file" ? "REQUIRE_APPROVAL" : "ALLOW"])),
    systemInstructions: options.systemInstructions ?? repositoryExplorerInstructions,
    maxSteps: options.maxSteps ?? 8,
    onTrace: options.onTrace,
    claimApprovalAction: options.claimApprovalAction,
  });
}
