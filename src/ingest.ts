import { call } from "./models.js";

/** Plain-text formats read as they are. */
const TEXT_LIKE = /\.(txt|ics|calendar|vcs|md|markdown|csv|tsv|json|jsonl|log|html?|xml|ya?ml|ini|toml|srt|vtt|ts|js|py|css|sql|rtf)$/;
const IMAGE = /\.(png|jpe?g|webp|gif)$/;

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", txt: "text/plain", md: "text/markdown",
  csv: "text/csv", json: "application/json", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", mp4: "video/mp4", mov: "video/quicktime",
};

export function mimeOf(filename: string, given?: string | null): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  return MIME[ext] ?? (given || "application/octet-stream");
}

/**
 * Any file is taken (IDEA.md: "it has the capability to take any kind of file"). What it can read becomes text; what it
 * can't is stored anyway, marked unreadable, and it brings that up from time to time.
 */
export async function readUpload(filename: string, bytes: Buffer): Promise<{ text: string; readable: boolean; mime: string }> {
  const lower = filename.toLowerCase();
  const mime = mimeOf(filename);
  try {
    if (lower.endsWith(".docx")) {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer: bytes });
      return { text: result.value.trim(), readable: Boolean(result.value.trim()), mime };
    }
    if (lower.endsWith(".pdf")) {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const extracted = await extractText(pdf, { mergePages: true });
      const text = (Array.isArray(extracted.text) ? extracted.text.join("\n") : String(extracted.text ?? "")).trim();
      return { text, readable: Boolean(text), mime };
    }
    if (TEXT_LIKE.test(lower)) {
      const text = bytes.toString("utf8").trim();
      return { text, readable: Boolean(text), mime };
    }
    if (IMAGE.test(lower)) {
      const described = await call("web", {
        task: "read-picture",
        system: "Describe this picture for someone's personal memory: what is in it, any text in it word for word, and anything that tells when or where it was taken. Plain text.",
        prompt: `The picture is called ${filename}.`,
        images: [{ mediaType: mime, base64: bytes.toString("base64") }],
        maxTokens: 1500,
      });
      return { text: described.text.trim(), readable: true, mime };
    }
  } catch {
    return { text: "", readable: false, mime };
  }
  return { text: "", readable: false, mime };
}
