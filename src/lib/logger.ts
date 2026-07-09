import pino, { type LoggerOptions } from 'pino';
import { env } from '../config/env.js';

const options: LoggerOptions = {
  level: env.LOG_LEVEL,
  ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
};

export const logger = pino(options);
