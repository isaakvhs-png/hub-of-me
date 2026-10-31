import { Document, HeadingLevel, Packer, Paragraph } from "docx";

export async function toDocx(title: string, body: string): Promise<Buffer> {
  const children = [
    new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }),
    ...body.split("\n").map((line) => new Paragraph(line.length ? line : " ")),
  ];
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}
