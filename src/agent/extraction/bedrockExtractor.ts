import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  type InvokeModelCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';

import { HttpRequest } from '@smithy/protocol-http';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import {
  AiExtractionError,
  ExtractedInvoiceSchema,
  EXTRACTION_TOOL_INPUT_SCHEMA,
  type ExtractInvoiceInput,
  type ExtractedInvoice,
} from './aiExtractor.js';
import type {
  FinalizeHandler,
  FinalizeHandlerArguments,
  HandlerExecutionContext,
} from '@smithy/types';
import type { ServiceInputTypes, ServiceOutputTypes } from '@aws-sdk/client-bedrock-runtime';

const MAX_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 500;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const TOOL_NAME = 'record_invoice_extraction';

const GATEWAY_URL = process.env.GATEWAY_URL ?? 'https://gateway.corevalue.dev';
const BEDROCK_REGION = process.env.AWS_REGION ?? 'us-east-1';

interface ToolUseBlock {
  type: string;
  name?: string;
  input?: unknown;
}

interface ClaudeResponse {
  stop_reason: string;
  content: ToolUseBlock[];
}

const client = new BedrockRuntimeClient({
  region: BEDROCK_REGION,
  endpoint: GATEWAY_URL,
  token: { token: process.env.COREVALUE_API_KEY! },
  authSchemePreference: ['httpBearerAuth'],
});

client.middlewareStack.addRelativeTo(
  (
    next: FinalizeHandler<ServiceInputTypes, ServiceOutputTypes>,
    _context: HandlerExecutionContext,
  ) =>
    async (args: FinalizeHandlerArguments<ServiceInputTypes>) => {
      if (args.request instanceof HttpRequest) {
        delete args.request.headers['x-amz-date'];
        delete args.request.headers['x-amz-content-sha256'];
        delete args.request.headers['x-amz-security-token'];
      }

      return next(args);
    },
  {
    name: 'covaGatewayAuth',
    relation: 'after',
    toMiddleware: 'awsAuthMiddleware',
  },
);

export interface BedrockClientLike {
  send(command: InvokeModelCommand): Promise<InvokeModelCommandOutput>;
}

function buildPrompt({ vendorName, sourceText }: ExtractInvoiceInput): string {
  return [
    `Extract the invoice details from the following billing text from vendor "${vendorName}".`,
    `Use the ${TOOL_NAME} tool with the structured fields. Only include optional fields you can`,
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

function isRetryableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const metadata = (err as { $metadata?: unknown }).$metadata;
  const status =
    metadata && typeof metadata === 'object' && 'httpStatusCode' in metadata
      ? metadata.httpStatusCode
      : undefined;
  return typeof status === 'number' && RETRYABLE_STATUS_CODES.has(status);
}

function getToolUse(response: InvokeModelCommandOutput) {
  function parseJson<T>(text: string): T {
    return JSON.parse(text) as T;
  }

  const body = parseJson<ClaudeResponse>(new TextDecoder().decode(response.body));

  return body.content.find((block) => block.type === 'tool_use' && block.name === TOOL_NAME);
}

function buildInvokeBody(input: ExtractInvoiceInput): string {
  return JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 1024,
    tools: [
      {
        name: TOOL_NAME,
        description:
          'Record the structured invoice fields extracted from the provided vendor billing text.',
        input_schema: EXTRACTION_TOOL_INPUT_SCHEMA,
      },
    ],
    tool_choice: {
      type: 'tool',
      name: TOOL_NAME,
    },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: buildPrompt(input),
          },
        ],
      },
    ],
  });
}

export async function extractInvoiceDataWithBedrock(
  input: ExtractInvoiceInput,
): Promise<ExtractedInvoice> {
  let lastValidationError: string | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response: InvokeModelCommandOutput;
    try {
      response = await client.send(
        new InvokeModelCommand({
          modelId: env.BEDROCK_MODEL_ID,
          body: buildInvokeBody(input),
          contentType: 'application/json',
          accept: 'application/json',
        }),
      );
    } catch (err) {
      if (attempt < MAX_ATTEMPTS && isRetryableError(err)) {
        const backoffMs = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1);
        logger.warn(
          { err, attempt, backoffMs },
          'Retrying Bedrock invoice extraction after API error',
        );
        await delay(backoffMs);
        continue;
      }
      logger.error({ err, attempt }, 'Bedrock invoice extraction API call failed');
      throw new AiExtractionError('Bedrock invoice extraction API call failed', { cause: err });
    }
    const toolUse = getToolUse(response);
    const parsed = ExtractedInvoiceSchema.safeParse(toolUse?.input);
    if (parsed.success) return parsed.data;

    lastValidationError = toolUse
      ? parsed.error.message
      : `Bedrock response did not include a ${TOOL_NAME} tool call (stop_reason: ${'unknown'})`;
    if (attempt >= MAX_ATTEMPTS) break;

    logger.warn({ attempt, error: lastValidationError }, 'Retrying Bedrock invoice extraction');
  }

  logger.error(
    { attempts: MAX_ATTEMPTS, error: lastValidationError },
    'Bedrock invoice extraction failed validation after all retries',
  );
  throw new AiExtractionError(
    `Bedrock invoice extraction failed validation after ${MAX_ATTEMPTS} attempts: ${lastValidationError ?? 'unknown error'}`,
  );
}
