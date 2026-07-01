import * as fs from 'fs';
import * as path from 'path';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export interface LoggerOptions {
  level: LogLevel;
  file?: string;
  console?: boolean;
}

export class Logger {
  private level: LogLevel;
  private logFile?: string;
  private useConsole: boolean;

  constructor(options: LoggerOptions) {
    this.level = options.level;
    this.logFile = options.file;
    this.useConsole = options.console !== false;
  }

  private log(level: LogLevel, levelName: string, message: string, meta?: any) {
    if (level < this.level) return;

    const timestamp = new Date().toISOString();
    let metaStr = '';
    
    if (meta !== undefined) {
      if (meta instanceof Error) {
        metaStr = ` ${meta.message} ${meta.stack}`;
      } else if (typeof meta === 'object') {
        try {
          metaStr = ` ${JSON.stringify(meta)}`;
        } catch {
          metaStr = ` [Circular or unstringifiable object]`;
        }
      } else {
        metaStr = ` ${meta}`;
      }
    }

    const logLine = `[${timestamp}] [${levelName}] ${message}${metaStr}`;

    if (this.useConsole) {
      if (level === LogLevel.ERROR) {
        console.error(logLine);
      } else if (level === LogLevel.WARN) {
        console.warn(logLine);
      } else {
        console.log(logLine);
      }
    }

    if (this.logFile) {
      try {
        fs.appendFileSync(this.logFile, logLine + '\n', 'utf8');
      } catch (err) {
        if (this.useConsole) {
          console.error(`Failed to write to log file: ${err}`);
        }
      }
    }
  }

  public debug(message: string, meta?: any) {
    this.log(LogLevel.DEBUG, 'DEBUG', message, meta);
  }

  public info(message: string, meta?: any) {
    this.log(LogLevel.INFO, 'INFO', message, meta);
  }

  public warn(message: string, meta?: any) {
    this.log(LogLevel.WARN, 'WARN', message, meta);
  }

  public error(message: string, meta?: any) {
    this.log(LogLevel.ERROR, 'ERROR', message, meta);
  }
}

// Default export if you want to use a singleton
let defaultLogger: Logger | null = null;

export function getLogger(options?: LoggerOptions): Logger {
  if (options) {
    return new Logger(options);
  }
  if (!defaultLogger) {
    // initialize with default config if not provided
    defaultLogger = new Logger({
      level: LogLevel.INFO,
      console: true
    });
  }
  return defaultLogger;
}
