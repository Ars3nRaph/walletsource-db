import { pino as pinoLogger } from 'pino';

const logLevel = process.env.LOG_LEVEL || 'info';

export const logger = pinoLogger({
  level: logLevel,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname'
    }
  }
});
