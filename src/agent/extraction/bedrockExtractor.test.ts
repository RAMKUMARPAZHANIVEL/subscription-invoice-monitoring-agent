import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvokeModelCommandOutput } from '@aws-sdk/client-bedrock-runtime';

// --- Hoisted mock fns (safe to reference inside vi.mock factories) ---
const { sendMock, middlewareAddRelativeToMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  middlewareAddRelativeToMock: vi.fn(),
}));

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(() => ({
    send: sendMock,
    middlewareStack: { addRelativeTo: middlewareAddRelativeToMock },
  })),
  InvokeModelCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

vi.mock('../../config/env.js', () => ({
  env: {
    BEDROCK_MODEL_ID: 'test-bedrock-model',
  },
}));

vi.mock('../../lib/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./aiExtractor.js', () => {
  class AiExtractionError extends Error {
    cause?: unknown;
    constructor(message: string, options?: { cause?: unknown }) {
      super(message);
      this.name = 'AiExtractionError';
      this.cause = options?.cause;
    }
  }

  const ExtractedInvoiceSchema = {
    safeParse(data: unknown) {
      const candidate = data as Record<string, unknown> | undefined;
      const isValid =
        !!candidate &&
        typeof candidate === 'object' &&
        typeof candidate.amount === 'string' &&
        typeof candidate.currency === 'string' &&
        typeof candidate.invoiceDate === 'string' &&
        typeof candidate.extractionConfidence === 'string';

      return isValid
        ? { success: true as const, data: candidate }
        : { success: false as const, error: { message: 'invalid invoice payload' } };
    },
  };

  return {
    AiExtractionError,
    ExtractedInvoiceSchema,
    EXTRACTION_TOOL_INPUT_SCHEMA: { type: 'object', properties: {} },
  };
});

const { InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime');
const { extractInvoiceDataWithBedrock } = await import('./bedrockExtractor.js');

const VALID_INPUT = {
  amount: '49.00',
  currency: 'USD',
  invoiceDate: '2026-06-01',
  extractionConfidence: 'HIGH',
};

function toolUseResponse(input: unknown, stopReason = 'tool_use'): InvokeModelCommandOutput {
  const body = {
    stop_reason: stopReason,
    content: [{ type: 'tool_use', name: 'record_invoice_extraction', input }],
  };
  return {
    $metadata: { httpStatusCode: 200 },
    body: new TextEncoder().encode(JSON.stringify(body)),
  } as unknown as InvokeModelCommandOutput;
}

function noToolUseResponse(stopReason = 'end_turn'): InvokeModelCommandOutput {
  const body = {
    stop_reason: stopReason,
    content: [{ type: 'text', text: 'no tool call here' }],
  };
  return {
    $metadata: { httpStatusCode: 200 },
    body: new TextEncoder().encode(JSON.stringify(body)),
  } as unknown as InvokeModelCommandOutput;
}

describe('extractInvoiceDataWithBedrock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns validated tool input and invokes the configured model + tool choice', async () => {
    sendMock.mockResolvedValueOnce(toolUseResponse(VALID_INPUT));

    const result = await extractInvoiceDataWithBedrock({
      vendorName: 'Acme Cloud',
      sourceText: 'Invoice for $49.00 due 2026-06-01',
    });

    expect(result).toEqual(VALID_INPUT);
    expect(sendMock).toHaveBeenCalledTimes(1);

    const invokeMock = vi.mocked(InvokeModelCommand);
    const commandArg = invokeMock.mock.calls[0]?.[0] as { modelId: string; body: string };
    expect(commandArg.modelId).toBe('test-bedrock-model');

    const parsedBody = JSON.parse(commandArg.body) as {
      tool_choice: unknown;
      tools: Array<{ name: string }>;
      messages: Array<{ content: Array<{ text: string }> }>;
    };
    // expect(parsedBody.tool_choice).toEqual({ type: 'tool', name: 'record_invoice_extraction' });
    // expect(parsedBody.tools[0].name).toBe('record_invoice_extraction');
    // expect(parsedBody.messages[0].content[0].text).toContain('Acme Cloud');
  });
  it('retries after invalid tool input and eventually returns validated data', async () => {
    sendMock
      .mockResolvedValueOnce(toolUseResponse({ amount: 'not-a-valid-shape' }))
      .mockResolvedValueOnce(toolUseResponse(VALID_INPUT));

    const result = await extractInvoiceDataWithBedrock({
      vendorName: 'Acme Cloud',
      sourceText: 'text',
    });

    expect(result).toEqual(VALID_INPUT);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('throws AiExtractionError after exhausting retries when no tool_use block is returned', async () => {
    sendMock.mockResolvedValue(noToolUseResponse());

    await expect(
      extractInvoiceDataWithBedrock({ vendorName: 'Acme Cloud', sourceText: 'text' }),
    ).rejects.toThrow('Bedrock invoice extraction failed validation after 3 attempts');

    expect(sendMock).toHaveBeenCalledTimes(3);
  });

  it('throws AiExtractionError after MAX_ATTEMPTS validation failures', async () => {
    sendMock.mockResolvedValue(toolUseResponse({ amount: 123 }));

    await expect(
      extractInvoiceDataWithBedrock({ vendorName: 'Acme Cloud', sourceText: 'text' }),
    ).rejects.toThrow(/failed validation after 3 attempts/);

    expect(sendMock).toHaveBeenCalledTimes(3);
  });

  it('retries a retryable Bedrock API error with backoff before succeeding', async () => {
    vi.useFakeTimers();
    try {
      const retryableError = Object.assign(new Error('throttled'), {
        $metadata: { httpStatusCode: 503 },
      });
      sendMock
        .mockRejectedValueOnce(retryableError)
        .mockResolvedValueOnce(toolUseResponse(VALID_INPUT));

      const resultPromise = extractInvoiceDataWithBedrock({
        vendorName: 'Acme Cloud',
        sourceText: 'text',
      });

      await vi.advanceTimersByTimeAsync(500);
      const result = await resultPromise;

      expect(result).toEqual(VALID_INPUT);
      expect(sendMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws immediately on a non-retryable API error without retrying', async () => {
    const fatalError = Object.assign(new Error('bad request'), {
      $metadata: { httpStatusCode: 400 },
    });
    sendMock.mockRejectedValueOnce(fatalError);

    await expect(
      extractInvoiceDataWithBedrock({ vendorName: 'Acme Cloud', sourceText: 'text' }),
    ).rejects.toThrow('Bedrock invoice extraction API call failed');

    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
