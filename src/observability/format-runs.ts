import type { RunDetails, RunSummary, TimelineEntry } from "./run-query.js";

export function formatRunList(runs: RunSummary[]): string {
  if (runs.length === 0) return "No runs found.";
  return runs.map((run) => [
    `${run.id}  ${run.status}  ${run.agent}@${run.agentVersion}  ${run.provider}/${run.model}`,
    `  submitted ${run.createdAt}  started ${run.startedAt ?? "-"}  ended ${run.completedAt ?? "-"}`,
  ].join("\n")).join("\n");
}

export function formatRunDetails(run: RunDetails): string {
  const lines = [
    `TaskRun: ${run.id}`,
    `Task: ${run.prompt}`,
    `Status: ${run.status}`,
    `AgentVersion: ${run.agent}@${run.agentVersion}`,
    `Provider / Model: ${run.provider} / ${run.model}`,
    `Recovery count: ${run.recoveryCount}`,
    `Worker: ${run.workerId ?? "-"}`,
    `Heartbeat: ${run.heartbeatAt ?? "-"}`,
    `Submitted: ${run.createdAt}`,
    `Started: ${run.startedAt ?? "-"}`,
    `Completed: ${run.completedAt ?? "-"}`,
    `Total duration: ${milliseconds(run.totalDurationMs)}`,
    `Latest execution duration: ${milliseconds(run.executionDurationMs)}`,
  ];
  if (run.verification) lines.push(`Result verification: ${run.verification.status}`,
    ...run.verification.conditions.map(condition => `  Expected ${condition.type}: ${condition.path}`));
  if (run.finalAnswer !== null) lines.push(`Final answer:\n${run.finalAnswer}`);
  if (run.failure) lines.push(`Failure: ${run.failure.code}${run.failure.message ? ` — ${run.failure.message}` : ""}`);
  lines.push("", "Timeline:");
  if (run.timeline.length === 0) lines.push("  No execution steps yet.");
  let lastAttempt: number | null = null;
  for (const entry of run.timeline) {
    if (entry.executionAttempt !== lastAttempt) {
      lines.push(`  Attempt ${entry.executionAttempt}${lastAttempt === null && entry.executionAttempt > 1 ? " (earlier steps unavailable)" : ""}`);
      lastAttempt = entry.executionAttempt;
    }
    lines.push(`  ${entry.sequence}. ${entry.timestamp} ${formatEntry(entry)}`);
  }
  return lines.join("\n");
}

function formatEntry(entry: TimelineEntry): string {
  const details: string[] = [];
  if (entry.toolName) details.push(entry.toolName);
  if (entry.argumentsSummary) details.push(`args=${entry.argumentsSummary}`);
  if (entry.resultSummary) details.push(`result=${entry.resultSummary}`);
  if (entry.approvalId) details.push(`approval=${entry.approvalId}`);
  if (entry.type === "MODEL_CALL") {
    details.push(`${entry.provider}/${entry.model}`);
    if (entry.usage) {
      const { inputTokens, outputTokens, totalTokens } = entry.usage;
      details.push(`tokens in=${inputTokens ?? "-"} out=${outputTokens ?? "-"} total=${totalTokens ?? "-"}`);
    }
  }
  if (entry.failureCode) details.push(`code=${entry.failureCode}`);
  if (entry.message) details.push(entry.message);
  if (entry.workerId) details.push(`worker=${entry.workerId}`);
  if (entry.answer) details.push(`answer=${entry.answer.length > 120 ? `${entry.answer.slice(0, 117)}...` : entry.answer}`);
  if (entry.durationMs !== undefined) details.push(`duration=${milliseconds(entry.durationMs)}`);
  return `${entry.type}${entry.runtimeStep === null ? "" : ` [runtime step ${entry.runtimeStep}]`}${details.length ? ` ${details.join("  ")}` : ""}`;
}

function milliseconds(value: number | null): string {
  return value === null ? "-" : `${Math.round(value)} ms`;
}
