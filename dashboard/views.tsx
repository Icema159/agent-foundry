import type { RunDetails, RunSummary } from "../src/observability/run-query.js";

export type Approval = { id: string; taskRunId: string; toolName: string; validatedArguments: unknown; requestedAt: string };
export const time = (value: string | null) => value ? new Date(value).toLocaleString() : "—";
const duration = (ms: number | null) => ms === null ? "—" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
export function Status({ status }: { status: string }) { return <span className={`status ${status.toLowerCase()}`}>{status.replaceAll("_", " ")}</span>; }

export function Runs({ runs, open }: { runs: RunSummary[]; open(id: string): void }) {
  return <section className="panel"><div className="table-scroll"><table><thead><tr><th>Task run</th><th>Status</th><th>Agent / version</th><th>Provider / model</th><th>Submitted</th><th>Started</th><th>Completed</th><th>Duration</th></tr></thead><tbody>
    {runs.map(run => <tr key={run.id}><td><button className="link mono" onClick={() => open(run.id)}>{run.id}</button></td><td><Status status={run.status}/></td><td>{run.agent}<small>Version {run.agentVersion}</small></td><td>{run.provider}<small>{run.model}</small></td><td>{time(run.createdAt)}</td><td>{time(run.startedAt)}</td><td>{time(run.completedAt)}</td><td>{duration(run.completedAt ? Date.parse(run.completedAt) - Date.parse(run.createdAt) : null)}</td></tr>)}
  </tbody></table></div>{!runs.length && <p className="empty">No runs yet. Submit a task from the CLI to get started.</p>}</section>;
}

export function RunDetail({ run }: { run: RunDetails }) {
  let attempt = 0;
  return <>
    <section className="panel task"><div className="section-heading"><h2>Task</h2><Status status={run.status}/></div><p className="prompt">{run.prompt}</p><p className="mono muted">{run.id}</p><dl className="metadata">
      <div><dt>Agent version</dt><dd>{run.agent} · v{run.agentVersion}</dd></div><div><dt>Model</dt><dd>{run.provider} / {run.model}</dd></div><div><dt>Recoveries</dt><dd>{run.recoveryCount}</dd></div>
      {run.verification && <div><dt>Result verification</dt><dd>{run.verification.status.replaceAll("_", " ")}{run.verification.conditions.map((condition, index) => <small key={index}>{condition.type}: {condition.path}</small>)}</dd></div>}
      <div><dt>Submitted</dt><dd>{time(run.createdAt)}</dd></div><div><dt>Latest start</dt><dd>{time(run.startedAt)}</dd></div><div><dt>Completed</dt><dd>{time(run.completedAt)}</dd></div><div><dt>Total elapsed</dt><dd>{duration(run.totalDurationMs)}</dd></div><div><dt>Latest execution</dt><dd>{duration(run.executionDurationMs)}</dd></div><div><dt>Worker / heartbeat</dt><dd className="mono">{run.workerId ?? "—"}<small>{time(run.heartbeatAt)}</small></dd></div>
    </dl></section>
    {run.finalAnswer !== null && <section className="panel answer"><h2>Final answer</h2><div className="prose">{run.finalAnswer}</div></section>}
    {run.failure && <section className="panel failure" role="alert"><h2>Execution failed</h2><strong className="mono">{run.failure.code}</strong><p className="prose">{run.failure.message}</p></section>}
    <section className="panel"><div className="section-heading"><h2>Execution timeline</h2><span className="muted">{run.timeline.length} events</span></div><ol className="timeline">
      {run.timeline.map(entry => { const newAttempt = entry.executionAttempt !== attempt; attempt = entry.executionAttempt; return <li key={entry.sequence}>
        {newAttempt && <h3 className="attempt">Attempt {entry.executionAttempt}{entry.executionAttempt > 1 && <small>Whole-run recovery</small>}</h3>}
        <article className={`event ${entry.type === "RUNTIME_FAILURE" ? "event-failed" : ""}`}><div className="event-head"><span className="event-number">{entry.sequence}</span><strong>{entry.type}</strong>{entry.toolName && <code>{entry.toolName}</code>}<span className="muted event-time">{time(entry.timestamp)}</span></div>
          <div className="event-body">{entry.runtimeStep !== null && <span className="muted">Runtime step {entry.runtimeStep} · </span>}{entry.durationMs !== undefined && <span>{duration(entry.durationMs)} · </span>}{entry.model && <span>{entry.provider} / {entry.model}</span>}
          {entry.usage && <p className="tokens">Tokens: input {entry.usage.inputTokens ?? "—"} · output {entry.usage.outputTokens ?? "—"} · total {entry.usage.totalTokens ?? "—"}</p>}
          {entry.argumentsSummary && <pre>{entry.argumentsSummary}</pre>}{entry.resultSummary && <pre>{entry.resultSummary}</pre>}
          {entry.approvalId && <p className="mono">Approval: {entry.approvalId}</p>}{entry.failureCode && <strong className="error-text">{entry.failureCode}</strong>}{entry.message && <p>{entry.message}</p>}
          {entry.answer && <details><summary>View answer at this step</summary><div className="prose">{entry.answer}</div></details>}</div>
        </article></li>; })}
    </ol>{!run.timeline.length && <p className="empty">Waiting for execution. Events will appear here.</p>}</section>
  </>;
}

export function Approvals({ approvals, busy, decide, open }: { approvals: Approval[]; busy: string | null; decide(id: string, decision: "approve" | "deny"): void; open(id: string): void }) {
  return <div className="approval-list">{approvals.map(approval => <section className="panel" key={approval.id}>
    <div className="section-heading"><h2>{approval.toolName}</h2><Status status="WAITING_FOR_APPROVAL"/></div>
    <p className="muted">Requested {time(approval.requestedAt)}</p><p className="mono">Approval: {approval.id}</p>
    <button className="link mono" onClick={() => open(approval.taskRunId)}>Run {approval.taskRunId} →</button>
    <h3>Exact validated arguments</h3><pre className="arguments">{JSON.stringify(approval.validatedArguments, null, 2)}</pre>
    <div className="actions"><button className="primary" disabled={busy !== null} onClick={() => decide(approval.id, "approve")}>{busy === approval.id ? "Submitting…" : "Approve"}</button><button className="danger" disabled={busy !== null} onClick={() => decide(approval.id, "deny")}>Deny</button></div>
  </section>)}{!approvals.length && <section className="panel empty"><h2>All clear</h2><p>No actions are waiting for your approval.</p></section>}</div>;
}
