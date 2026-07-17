import { describe, expect, it, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import type { Message, MessageCreateParams } from '@anthropic-ai/sdk/resources/messages';
import { AiExtractionError, extractInvoiceData } from './aiExtractor.js';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', ANTHROPIC_API_KEY: 'test-key' },
}));

function toolUseMessage(input: unknown, id = 'tool_1'): Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 10,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
    },
    content: [
      {
        type: 'tool_use',
        id,
        name: 'record_invoice_extraction',
        input,
        caller: { type: 'direct' },
      },
    ],
  } as unknown as Message;
}

function textOnlyMessage(): Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 10,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
    },
    content: [{ type: 'text', text: 'I could not find invoice details.', citations: [] }],
  } as unknown as Message;
}

function fakeClient(create: (params: MessageCreateParams) => Promise<Message>): Anthropic {
  return { messages: { create } } as unknown as Anthropic;
}

const VALID_INPUT = {
  amount: '49.00',
  currency: 'USD',
  invoiceDate: '2026-06-01',
  extractionConfidence: 'HIGH',
};

describe('extractInvoiceData', () => {
  it('returns the validated extraction on a well-formed tool_use response', async () => {
    const create = vi.fn().mockResolvedValue(toolUseMessage(VALID_INPUT));

    const result = await extractInvoiceData(
      { vendorName: 'Acme Cloud', sourceText: 'Invoice for $49.00 due 2026-06-01' },
      fakeClient(create),
    );

    expect(result).toEqual(VALID_INPUT);
    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0]?.[0] as MessageCreateParams;
    expect(params.tool_choice).toEqual({ type: 'tool', name: 'record_invoice_extraction' });
  });

  it('parses optional fields (billing period, subscriptionType, lineItems) when present', async () => {
    const input = {
      ...VALID_INPUT,
      billingPeriodStart: '2026-06-01',
      billingPeriodEnd: '2026-06-30',
      subscriptionType: 'FIXED_MONTHLY',
      lineItems: [{ description: '5 seats', amount: '49.00' }],
    };
    const create = vi.fn().mockResolvedValue(toolUseMessage(input));

    const result = await extractInvoiceData(
      { vendorName: 'Acme Cloud', sourceText: 'text' },
      fakeClient(create),
    );

    expect(result).toEqual(input);
  });

  it('retries with a corrective tool_result when the tool input fails schema validation, then succeeds', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(toolUseMessage({ amount: 'not-a-number', currency: 'USD' }))
      .mockResolvedValueOnce(toolUseMessage(VALID_INPUT));

    const result = await extractInvoiceData(
      { vendorName: 'Acme Cloud', sourceText: 'text' },
      fakeClient(create),
    );

    expect(result).toEqual(VALID_INPUT);
    expect(create).toHaveBeenCalledTimes(2);
    const secondCallParams = create.mock.calls[1]?.[0] as MessageCreateParams;
    const lastMessage = secondCallParams.messages.at(-1);
    expect(lastMessage?.role).toBe('user');
    expect(JSON.stringify(lastMessage?.content)).toContain('tool_result');
  });

  it('retries when the response contains no tool_use block, then succeeds', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(textOnlyMessage())
      .mockResolvedValueOnce(toolUseMessage(VALID_INPUT));

    const result = await extractInvoiceData(
      { vendorName: 'Acme Cloud', sourceText: 'text' },
      fakeClient(create),
    );

    expect(result).toEqual(VALID_INPUT);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('throws AiExtractionError after exhausting retries on a persistently malformed/incomplete response', async () => {
    const create = vi.fn().mockResolvedValue(toolUseMessage({ amount: '49.00' }));

    await expect(
      extractInvoiceData({ vendorName: 'Acme Cloud', sourceText: 'text' }, fakeClient(create)),
    ).rejects.toThrow(AiExtractionError);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('retries on a retryable API error (e.g. rate limit) and succeeds', async () => {
    const rateLimitError = new Anthropic.APIError(
      429,
      { error: { message: 'rate limited' } },
      'rate limited',
      new Headers(),
    );
    const create = vi
      .fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce(toolUseMessage(VALID_INPUT));

    const result = await extractInvoiceData(
      { vendorName: 'Acme Cloud', sourceText: 'text' },
      fakeClient(create),
    );

    expect(result).toEqual(VALID_INPUT);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('does not retry and throws AiExtractionError immediately on a non-retryable API error', async () => {
    const badRequestError = new Anthropic.APIError(
      400,
      { error: { message: 'bad request' } },
      'bad request',
      new Headers(),
    );
    const create = vi.fn().mockRejectedValue(badRequestError);

    await expect(
      extractInvoiceData({ vendorName: 'Acme Cloud', sourceText: 'text' }, fakeClient(create)),
    ).rejects.toThrow(AiExtractionError);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('throws AiExtractionError after exhausting retries on repeated retryable API errors', async () => {
    const rateLimitError = new Anthropic.APIError(
      503,
      { error: { message: 'overloaded' } },
      'overloaded',
      new Headers(),
    );
    const create = vi.fn().mockRejectedValue(rateLimitError);

    await expect(
      extractInvoiceData({ vendorName: 'Acme Cloud', sourceText: 'text' }, fakeClient(create)),
    ).rejects.toThrow(AiExtractionError);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('rejects an invalid currency code (schema validation on the tool response)', async () => {
    const create = vi.fn().mockResolvedValue(
      toolUseMessage({
        amount: '49.00',
        currency: 'US Dollars',
        invoiceDate: '2026-06-01',
        extractionConfidence: 'HIGH',
      }),
    );

    await expect(
      extractInvoiceData({ vendorName: 'Acme Cloud', sourceText: 'text' }, fakeClient(create)),
    ).rejects.toThrow(AiExtractionError);
  });

  it('rejects an unparseable invoiceDate (schema validation on the tool response)', async () => {
    const create = vi.fn().mockResolvedValue(
      toolUseMessage({
        amount: '49.00',
        currency: 'USD',
        invoiceDate: 'not-a-date',
        extractionConfidence: 'HIGH',
      }),
    );

    await expect(
      extractInvoiceData({ vendorName: 'Acme Cloud', sourceText: 'text' }, fakeClient(create)),
    ).rejects.toThrow(AiExtractionError);
  });
});
