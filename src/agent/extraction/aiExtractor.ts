/**
 * Claude-based structured invoice extraction (research.md #5) — converts extracted invoice text
 * (email body, or PDF/CSV text) into the structured `Invoice` fields (data-model.md) via a Claude
 * tool-use call with a strict JSON schema. The tool_use input is Zod-validated (Principle IX)
 * before it can reach persistence: a response that never yields valid tool input, even after
 * retries, surfaces as `AiExtractionError` rather than a partial/best-guess `Invoice` row
 * (Principle I — fail loud with diagnostics, never persist unvalidated data).
 */

import Anthropic, { APIError } from '@anthropic-ai/sdk';
import type {
  Message,
  MessageParam,
  Tool,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

const MODEL = 'claude-sonnet-5';
const MAX_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 500;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

const TOOL_NAME = 'record_invoice_extraction';

const LineItemSchema = z.object({
  description: z.string().min(1),
  amount: z.string().min(1),
});

export const ExtractedInvoiceSchema = z.object({
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/, 'amount must be a decimal string, e.g. "49.00"'),
  currency: z.string().regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO 4217 code, e.g. "USD"'),
  invoiceDate: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), 'invoiceDate must be a valid date string'),
  billingPeriodStart: z
    .string()
    .refine(
      (value) => !Number.isNaN(Date.parse(value)),
      'billingPeriodStart must be a valid date string',
    )
    .optional(),
  billingPeriodEnd: z
    .string()
    .refine(
      (value) => !Number.isNaN(Date.parse(value)),
      'billingPeriodEnd must be a valid date string',
    )
    .optional(),
  subscriptionType: z.enum(['FIXED_MONTHLY', 'USAGE_BASED', 'PER_SEAT']).optional(),
  lineItems: z.array(LineItemSchema).optional(),
  extractionConfidence: z.enum(['HIGH', 'LOW']),
});

export type ExtractedInvoice = z.infer<typeof ExtractedInvoiceSchema>;

export class AiExtractionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AiExtractionError';
  }
}

const EXTRACTION_TOOL: Tool = {
  name: TOOL_NAME,
  description:
    'Record the structured invoice fields extracted from the provided vendor billing text.',
  input_schema: {
    type: 'object',
    properties: {
      amount: {
        type: 'string',
        description: 'Total invoice amount as a decimal string, e.g. "49.00".',
      },
      currency: {
        type: 'string',
        description: '3-letter ISO 4217 currency code, e.g. "USD".',
      },
      invoiceDate: {
        type: 'string',
        description: 'Invoice issue date as an ISO 8601 date (YYYY-MM-DD) or date-time string.',
      },
      billingPeriodStart: {
        type: 'string',
        description: 'Start of the billing period covered, if stated, as an ISO 8601 date.',
      },
      billingPeriodEnd: {
        type: 'string',
        description: 'End of the billing period covered, if stated, as an ISO 8601 date.',
      },
      subscriptionType: {
        type: 'string',
        enum: ['FIXED_MONTHLY', 'USAGE_BASED', 'PER_SEAT'],
        description: 'The subscription billing model, if determinable from the text.',
      },
      lineItems: {
        type: 'array',
        description: 'Best-effort itemization of charges, if the source text breaks them out.',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            amount: { type: 'string' },
          },
          required: ['description', 'amount'],
        },
      },
      extractionConfidence: {
        type: 'string',
        enum: ['HIGH', 'LOW'],
        description:
          'HIGH if amount, currency, and invoiceDate were unambiguous in the source text; LOW otherwise.',
      },
    },
    required: ['amount', 'currency', 'invoiceDate', 'extractionConfidence'],
  },
};

export interface ExtractInvoiceInput {
  vendorName: string;
  sourceText: string;
}

function buildPrompt({ vendorName, sourceText }: ExtractInvoiceInput): string {
  return [
    `Extract the invoice details from the following billing text from vendor "${vendorName}".`,
    `Call the ${TOOL_NAME} tool with the structured fields. Only include optional fields you can`,
    'support from the text; omit ones you cannot determine rather than guessing.',
    '',
    '--- BEGIN SOURCE TEXT ---',
    sourceText,
    '--- END SOURCE TEXT ---',
  ].join('\n');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableApiError(err: unknown): boolean {
  return (
    err instanceof APIError &&
    typeof err.status === 'number' &&
    RETRYABLE_STATUS_CODES.has(err.status)
  );
}

function findToolUseBlock(message: Message): ToolUseBlock | undefined {
  return message.content.find(
    (block): block is ToolUseBlock => block.type === 'tool_use' && block.name === TOOL_NAME,
  );
}

let defaultClient: Anthropic | undefined;
function getDefaultClient(): Anthropic {
  defaultClient ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return defaultClient;
}

/**
 * Runs the Claude tool-use call and validates its output. Recoverable API errors (rate limits,
 * transient 5xx) are retried with backoff on the same request; a response that fails Zod
 * validation is retried by feeding the validation error back to Claude as a tool_result so it can
 * self-correct (research.md #5). Both retry paths share `MAX_ATTEMPTS`.
 */
export async function extractInvoiceData(
  input: ExtractInvoiceInput,
  client: Anthropic = getDefaultClient(),
): Promise<ExtractedInvoice> {
  const messages: MessageParam[] = [{ role: 'user', content: buildPrompt(input) }];
  let lastValidationError: string | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response: Message;
    try {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        tools: [EXTRACTION_TOOL],
        tool_choice: { type: 'tool', name: TOOL_NAME },
        messages,
      });
    } catch (err) {
      if (attempt < MAX_ATTEMPTS && isRetryableApiError(err)) {
        const backoffMs = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1);
        logger.warn(
          { err, attempt, backoffMs },
          'Retrying Claude invoice extraction after API error',
        );
        await delay(backoffMs);
        continue;
      }
      logger.error({ err, attempt }, 'Claude invoice extraction API call failed');
      throw new AiExtractionError('Claude invoice extraction API call failed', { cause: err });
    }

    const toolUse = findToolUseBlock(response);
    if (!toolUse) {
      lastValidationError = `Claude response did not include a ${TOOL_NAME} tool call (stop_reason: ${response.stop_reason ?? 'unknown'})`;
      if (attempt >= MAX_ATTEMPTS) break;
      logger.warn({ attempt }, 'Retrying Claude invoice extraction: no tool call in response');
      messages.push({ role: 'assistant', content: response.content });
      messages.push({
        role: 'user',
        content: `You must call the ${TOOL_NAME} tool with the extracted invoice fields.`,
      });
      continue;
    }

    const parsed = ExtractedInvoiceSchema.safeParse(toolUse.input);
    if (!parsed.success) {
      lastValidationError = parsed.error.message;
      if (attempt >= MAX_ATTEMPTS) break;
      logger.warn(
        { attempt, error: parsed.error.message },
        'Retrying Claude invoice extraction: schema validation failed',
      );
      messages.push({ role: 'assistant', content: response.content });
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUse.id,
            is_error: true,
            content: `Invalid extraction: ${parsed.error.message}. Call ${TOOL_NAME} again with corrected values.`,
          },
        ],
      });
      continue;
    }

    return parsed.data;
  }

  logger.error(
    { attempts: MAX_ATTEMPTS, error: lastValidationError },
    'Claude invoice extraction failed validation after all retries',
  );
  throw new AiExtractionError(
    `Claude invoice extraction failed validation after ${MAX_ATTEMPTS} attempts: ${lastValidationError ?? 'unknown error'}`,
  );
}
