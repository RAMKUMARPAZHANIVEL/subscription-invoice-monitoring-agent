import { describe, expect, it } from 'vitest';
import { extractPdfText, PdfExtractionError } from './pdfExtractor.js';

/**
 * Builds a minimal, hand-assembled single/multi-page PDF (header, objects, xref, trailer) so
 * tests don't depend on checked-in binary fixtures. Pass an empty string for a page to get a
 * page with no content stream text (simulates a scanned/image-only page).
 */
function buildPdf(pageTexts: string[]): Buffer {
  const pageCount = pageTexts.length;
  const catalogObjNum = 1;
  const pagesObjNum = 2;
  const fontObjNum = 3;
  const firstPageObj = 4;
  const firstContentObj = firstPageObj + pageCount;

  const kids = Array.from({ length: pageCount }, (_, i) => `${firstPageObj + i} 0 R`).join(' ');

  const objects: { num: number; body: string }[] = [
    { num: catalogObjNum, body: `<< /Type /Catalog /Pages ${pagesObjNum} 0 R >>` },
    { num: pagesObjNum, body: `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>` },
    { num: fontObjNum, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
  ];

  pageTexts.forEach((text, i) => {
    const pageNum = firstPageObj + i;
    const contentNum = firstContentObj + i;
    objects.push({
      num: pageNum,
      body: `<< /Type /Page /Parent ${pagesObjNum} 0 R /Resources << /Font << /F1 ${fontObjNum} 0 R >> >> /MediaBox [0 0 612 792] /Contents ${contentNum} 0 R >>`,
    });
    const escaped = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    const stream = text.length > 0 ? `BT /F1 24 Tf 72 700 Td (${escaped}) Tj ET` : '';
    objects.push({
      num: contentNum,
      body: `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    });
  });

  objects.sort((a, b) => a.num - b.num);

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets[obj.num] = Buffer.byteLength(body, 'latin1');
    body += `${obj.num} 0 obj\n${obj.body}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(body, 'latin1');
  const totalEntries = objects.length + 1;
  let xref = `xref\n0 ${totalEntries}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }

  body += xref;
  body += `trailer\n<< /Size ${totalEntries} /Root ${catalogObjNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(body, 'latin1');
}

describe('extractPdfText', () => {
  it('extracts text from a single-page PDF', async () => {
    const pdf = buildPdf(['Invoice Total: $42.00']);

    const result = await extractPdfText(pdf);

    expect(result.text).toContain('Invoice Total: $42.00');
    expect(result.pageCount).toBe(1);
  });

  it('extracts and concatenates text across a multi-page PDF', async () => {
    const pdf = buildPdf(['Page one invoice header', 'Page two line items']);

    const result = await extractPdfText(pdf);

    expect(result.text).toContain('Page one invoice header');
    expect(result.text).toContain('Page two line items');
    expect(result.pageCount).toBe(2);
  });

  it('throws PdfExtractionError for a corrupted/unparseable PDF', async () => {
    const validPdf = buildPdf(['Some invoice text']);
    const corrupted = validPdf.subarray(0, Math.floor(validPdf.length * 0.6));

    await expect(extractPdfText(corrupted)).rejects.toThrow(PdfExtractionError);
  });

  it('throws PdfExtractionError for a zero-byte (empty) PDF buffer', async () => {
    await expect(extractPdfText(Buffer.alloc(0))).rejects.toThrow(PdfExtractionError);
    await expect(extractPdfText(Buffer.alloc(0))).rejects.toThrow(/empty/i);
  });

  it('throws PdfExtractionError for a structurally valid PDF with no extractable text', async () => {
    const blankPagePdf = buildPdf(['']);

    await expect(extractPdfText(blankPagePdf)).rejects.toThrow(PdfExtractionError);
    await expect(extractPdfText(blankPagePdf)).rejects.toThrow(/scanned image/i);
  });
});
