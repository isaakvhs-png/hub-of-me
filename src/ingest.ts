import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export async function textFromUpload(filename: string, bytes: Buffer): Promise<{ kind: string; text: string }> {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".docx")) {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer: bytes });
    return { kind: "docx", text: result.value.trim() };
  }
  if (lower.endsWith(".pdf")) {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const extracted = await extractText(pdf, { mergePages: true });
    const text = Array.isArray(extracted.text) ? extracted.text.join("\n") : String(extracted.text ?? "");
    return { kind: "pdf", text: text.trim() };
  }
  if (lower.endsWith(".txt") || lower.endsWith(".md")) {
    return { kind: "text", text: bytes.toString("utf8").trim() };
  }
  if (/\.(png|jpe?g|webp|gif)$/.test(lower)) {
    const text = await imageText(bytes, lower);
    return { kind: "image", text };
  }
  throw new Error("Use a PDF, Word (.docx), text file, or image.");
}

const exec = promisify(execFile);

async function imageText(bytes: Buffer, filename: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hub-image-"));
  const imagePath = join(dir, filename.replace(/[^\w.]+/g, "-") || "image.png");
  try {
    await writeFile(imagePath, bytes);
    const { stdout } = await exec("tesseract", [imagePath, "stdout", "-l", "eng"], { timeout: 20000, maxBuffer: 2_000_000 });
    return stdout.trim();
  } catch {
    return "";
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
