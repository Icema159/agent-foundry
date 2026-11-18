import type { FileHandle } from "node:fs/promises";
import { ToolInputError } from "./tool-registry.js";

export const REPOSITORY_SCAN_BYTES = 8 * 1024 * 1024;
export const REPOSITORY_CONTENT_BYTES = 64 * 1024;
export const EXACT_LINE_COUNT_BYTES = 256 * 1024;
const CHUNK_BYTES = 16 * 1024;

/** Visit complete UTF-8 lines with their original delimiters. Oversized lines carry no text. */
export async function scanRepositoryText(
  file: FileHandle,
  size: bigint,
  visit: (line: number, bytes: number, text: string | undefined) => boolean | void,
) {
  const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
  const line = Buffer.allocUnsafe(REPOSITORY_CONTENT_BYTES);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const limit = size <= BigInt(REPOSITORY_SCAN_BYTES) ? Number(size) : REPOSITORY_SCAN_BYTES;
  let offset = 0;
  let lineBytes = 0;
  let lines = 0;

  const finishLine = () => {
    const length = lineBytes;
    lineBytes = 0;
    return visit(++lines, length, length <= line.length ? line.toString("utf8", 0, length) : undefined);
  };

  while (offset < limit) {
    const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, limit - offset), offset);
    if (!bytesRead) throw new Error("Unexpected end of repository file");
    offset += bytesRead;
    const data = chunk.subarray(0, bytesRead);
    if (data.includes(0)) throw unsupportedText();
    try {
      decoder.decode(data, { stream: true });
    } catch {
      throw unsupportedText();
    }

    let start = 0;
    while (start < data.length) {
      const newline = data.indexOf(10, start);
      const end = newline < 0 ? data.length : newline + 1;
      if (lineBytes + end - start <= line.length) data.copy(line, lineBytes, start, end);
      lineBytes += end - start;
      start = end;
      if (newline >= 0 && finishLine() === false && (end < data.length || BigInt(offset) < size)) {
        return { lines, eof: false, scanLimited: false };
      }
    }
  }

  const eof = BigInt(offset) === size;
  if (eof) {
    try {
      decoder.decode();
    } catch {
      throw unsupportedText();
    }
    if (lineBytes) finishLine();
  }
  return { lines, eof, scanLimited: !eof };
}

function unsupportedText() {
  return new ToolInputError("Requested repository file is not supported UTF-8 text");
}
