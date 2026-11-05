export type CopyAnswerResult = "copied" | "empty" | "unavailable" | "failed";

// Keep the original answer intact, including whitespace and Markdown.
export async function copyAnswer(
  answer: string | null,
  clipboard?: Pick<Clipboard, "writeText">,
): Promise<CopyAnswerResult> {
  if (!answer?.trim()) return "empty";
  try {
    const target = clipboard ?? (typeof navigator === "undefined" ? undefined : navigator.clipboard);
    if (!target?.writeText) return "unavailable";
    await target.writeText(answer);
    return "copied";
  } catch {
    return "failed";
  }
}
