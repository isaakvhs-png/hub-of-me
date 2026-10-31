import { Document, Packer, Paragraph } from "docx";
import { describe, expect, it } from "vitest";
import { textFromUpload } from "../src/ingest.js";
import { toDocx } from "../src/docx-export.js";

describe("documents", () => {
  it("reads a Word file and writes one back", async () => {
    const made = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("A source with no quality gate.")] }] }));
    const read = await textFromUpload("note.docx", made);
    expect(read.kind).toBe("docx");
    expect(read.text).toContain("quality gate");
    const out = await toDocx("Soul", "Kept.");
    const again = await textFromUpload("soul.docx", out);
    expect(again.text).toContain("Kept");
  });
});
