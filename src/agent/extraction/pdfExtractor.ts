/**
 * PDF text extraction (research.md #3) — pulls the text layer out of PDF attachments before
 * handing it to structured extraction. Unparseable bytes and text-less pages (scanned images)
 * both surface as `PdfExtractionError` rather than partial/empty success, so per-email isolation
 * can record a diagnosable `errorReason` (constitution Principles I, VI) instead of silently
 * passing empty text downstream.
 */

import { PDFParse } from 'pdf-parse';

export interface PdfExtractionResult {
  text: string;
  pageCount: number;
}

export class PdfExtractionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PdfExtractionError';
  }
}

export async function extractPdfText(data: Buffer): Promise<PdfExtractionResult> {
  if (data.length === 0) {
    throw new PdfExtractionError('Cannot extract text from an empty PDF attachment (0 bytes)');
  }

  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText();
    // Build text from per-page content rather than `result.text`, which always includes a
    // "-- N of M --" page-separator marker even when every page has no real text.
    const pageTexts = result.pages
      .map((page) => page.text.trim())
      .filter((text) => text.length > 0);
    if (pageTexts.length === 0) {
      throw new PdfExtractionError(
        'PDF text extraction returned empty content (likely a scanned image)',
      );
    }
    return { text: pageTexts.join('\n\n'), pageCount: result.total };
  } catch (err) {
    if (err instanceof PdfExtractionError) throw err;
    throw new PdfExtractionError('Failed to parse PDF attachment', { cause: err });
  } finally {
    await parser.destroy();
  }
}
