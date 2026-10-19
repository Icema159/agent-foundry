import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { RunDetails, RunSummary } from "../src/observability/run-query.js";
import { Approvals, RunDetail, Runs, type Approval } from "./views.js";
import "./style.css";

async function api<T>(url: string, signal?: AbortSignal, method = "GET"): Promise<T> {
  const response = await fetch(url, { method, signal, headers: method === "POST" ? { "X-Foundry-Dashboard": "1" } : {} });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body as T;
}

function App() {
  const [page, setPage] = useState("runs");
  const [selected, setSelected] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [run, setRun] = useState<RunDetails | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setLoading(true); setError(""); setRun(null);
    async function load() {
      let shouldPoll = true;
      try {
        if (page === "approvals") setApprovals(await api<Approval[]>("/api/approvals", controller.signal));
        else if (selected) {
          const details = await api<RunDetails>(`/api/runs/${encodeURIComponent(selected)}`, controller.signal);
          setRun(details); shouldPoll = !["COMPLETED", "FAILED"].includes(details.status);
        } else setRuns(await api<RunSummary[]>("/api/runs", controller.signal));
        setError("");
      } catch (error) { if (!controller.signal.aborted) setError((error as Error).message); }
      finally { if (!controller.signal.aborted) { setLoading(false); if (shouldPoll) timer = setTimeout(load, 3000); } }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [page, selected, revision]);
  const open = (id: string) => { setPage("runs"); setSelected(id); setNotice(""); };
  async function decide(id: string, decision: "approve" | "deny") {
    setBusy(id); setError("");
    try {
      const result = await api<{ taskRunId: string }>(`/api/approvals/${id}/${decision}`, undefined, "POST");
      open(result.taskRunId); setNotice(`Decision recorded. The worker will continue this same run.`);
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(null); }
  }
  return <div className="shell"><aside><div className="brand"><span className="brand-mark">F</span><div>Agent Foundry<small>Execution console</small></div></div><nav aria-label="Main navigation"><button className={page === "runs" ? "active" : ""} onClick={() => { setPage("runs"); setSelected(null); setNotice(""); }}>Runs</button><button className={page === "approvals" ? "active" : ""} onClick={() => { setPage("approvals"); setNotice(""); }}>Approvals</button></nav><p className="sidebar-note">Local workspace<br/>PostgreSQL execution history</p></aside>
    <main><header><div><p className="eyebrow">AGENT FOUNDRY / OBSERVABILITY</p><h1>{page === "approvals" ? "Pending approvals" : selected ? "Run details" : "Recent runs"}</h1><p className="muted">{page === "approvals" ? "Review the exact action before allowing execution." : selected ? "Follow each step from task to final answer." : "Inspect execution status, model calls, and results."}</p></div><button className="secondary" onClick={() => setRevision(value => value + 1)}>Refresh</button></header>
    {selected && page === "runs" && <button className="link back" onClick={() => setSelected(null)}>← All runs</button>}
    {error && <div role="alert" className="banner error">{error}</div>}{notice && <div role="status" className="banner">{notice}</div>}
    {loading ? <p className="panel empty">Loading execution history…</p> : page === "approvals" ? <Approvals approvals={approvals} busy={busy} decide={decide} open={open}/> : selected ? run && <RunDetail run={run}/> : <Runs runs={runs} open={open}/>}
    <footer>Times shown in your browser’s timezone. Active views refresh every 3 seconds.</footer></main></div>;
}

createRoot(document.getElementById("root")!).render(<App/>);
