export class ExecutorConflict extends Error {
  constructor(readonly code: string) { super("Executor protocol request conflicts with current state"); this.name = "ExecutorConflict"; }
}
