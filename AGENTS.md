# Agent Foundry engineering instructions

## Identity and scope

Agent Foundry is a reliable execution platform for AI agents: **Developer owns
intelligence. Foundry owns execution.** The current integration is a
Foundry-owned Repository Explorer, not a general agent hosting contract.
Bring your own agent / bring your own tools is a future direction, **NOT
IMPLEMENTED**. Do not start Agent Contract / Phase 11 work without a request.

## Architectural invariants

- PostgreSQL is the durable execution source of truth. Redis/BullMQ delivers
  `taskRunId`, not authoritative task state or agent configuration.
- Workers must respect database leases, ownership checks and ordered Steps.
- Foundry-managed tool calls enforce registry validation, permissions and human
  approvals. Model instructions are not an authorization boundary.
- Side effects must use the established execution isolation; current file
  creation/deletion go through the Docker sandbox. Never blindly replay
  destructive actions or claim exactly-once execution.
- Postconditions verify tool evidence and workspace outcomes, not model claims.
  Preserve R3's single durable correction opportunity and conservative safety
  policy; correction is conversation continuation, not whole-run recovery.
- Keep agent reasoning separate from platform execution policy. Do not move
  agent logic into queue transport, persistence or worker orchestration.
- Preserve R1 context configuration and R2 context-budget/tool-result protection,
  including after tool results and approval resume.

## Engineering practice

- Prefer small, focused changes and reuse existing abstractions. Avoid unrelated
  refactoring and preserve established safety guarantees.
- Inspect the relevant implementation before changing or describing it.
- Add deterministic tests for behavioral changes, especially permission,
  approval, side-effect, recovery, verification and context-limit boundaries.
  Prefer test-first for new safety rules; do not claim strict TDD unless used.
- Run focused tests and proportionate verification. For code changes, normally
  run `npm run typecheck` and `npm test`; report commands, results and unverified
  behavior accurately. Real-model tests are separate from fake-provider tests.
- Documentation-only work needs Markdown/link/source checks, not unnecessary
  builds, model runs or database mutations.
- Never reset databases, remove run history, approve actions or run destructive
  tools merely to make a test pass. Keep secrets out of code, docs and reports.
- Edit TypeScript sources, not generated `dist/` output or Prisma client files.

## Documentation navigation and maintenance

- [Execution pipeline](docs/architecture/execution-pipeline.md) is the current
  architecture map. Read only documents relevant to the subsystem being changed;
  do not load all project documentation unnecessarily.
- `docs/architecture/` documents implemented behavior. `docs/design/` is reserved
  for future designs, clearly labelled **PROPOSED / NOT IMPLEMENTED**.
- When modifying a subsystem, inspect its architecture documentation if present.
  Update it **in the same task** if execution behavior, architecture, public
  contracts, safety guarantees, invariants or known limitations change.
- Do not change architecture docs for unrelated cosmetic or implementation-only
  edits. Avoid repeating an architectural explanation across documents; link to
  its owning section. README remains the setup/usage entry point.
- Ground statements in source code. Never describe plans as operational. If
  documentation and code disagree, investigate and reconcile them; do not
  silently rewrite implementation to fit an assumption.
- Create dedicated subsystem docs only when complexity justifies them; do not
  create empty placeholders. Candidates include persistence/recovery,
  permissions/approvals, sandbox, model providers and context management, plus
  a proposed agent-contract design.
- Include relevant documentation changes and remaining inconsistencies in the
  final report.
