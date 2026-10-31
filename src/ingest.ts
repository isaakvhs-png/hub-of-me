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
  throw new Error("Use a PDF, Word (.docx), or text file.");
}
