import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { textFromUpload } from "../src/ingest.js";

describe("pdf", () => {
  it("reads text out of a PDF with no quality gate", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText("A source kept whole.", { x: 50, y: 700, size: 18, font });
    const bytes = Buffer.from(await doc.save());
    const read = await textFromUpload("source.pdf", bytes);
    expect(read.kind).toBe("pdf");
    expect(read.text).toContain("A source kept whole");
  });
});