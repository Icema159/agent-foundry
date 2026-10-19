import { parsePostconditions, type TaskPostcondition } from "../verification/task-postconditions.js";

export function parseTaskInput(args: string[]): { prompt: string; postconditions: TaskPostcondition[] } {
  const conditions: TaskPostcondition[] = [];
  let index = 0;
  while (args[index] === "--expect-created-file" || args[index] === "--expect-deleted-file") {
    const flag = args[index]!;
    const file = args[index + 1];
    if (!file || file.startsWith("--")) throw new Error(`${flag} requires a file path`);
    conditions.push({ type: flag === "--expect-deleted-file" ? "file_deleted" : "file_created", path: file });
    index += 2;
  }
  if (args[index] === "--") index += 1;
  const prompt = args.slice(index).join(" ").trim();
  if (!prompt) throw new Error('Usage: npm run agent -- [--expect-created-file PATH] [--expect-deleted-file PATH] "Task prompt"');
  return { prompt, postconditions: parsePostconditions(conditions) };
}
