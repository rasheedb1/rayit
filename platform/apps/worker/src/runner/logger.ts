/**
 * Logger del worker: JSON por línea, un registro por evento, con los
 * secretos tapados ANTES de serializar. Es la única salida permitida
 * (eslint prohíbe console.*), así que todo lo que el worker imprime pasa
 * por el redactor de @mc/connectors.
 *
 * Campos fijos: time, level, msg. Lo demás son los bindings del logger
 * hijo (job, runId…) más los campos del evento.
 */
import { redactSecrets } from '@mc/connectors';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'json' | 'pretty';
export type LogFields = Record<string, unknown>;

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && value in LEVELS;
}

export interface LogSink {
  write(line: string): void;
}

export interface Logger {
  readonly level: LogLevel;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  format?: LogFormat;
  sink?: LogSink;
  bindings?: LogFields;
  now?: () => Date;
}

const stdoutSink: LogSink = {
  write(line) {
    process.stdout.write(line + '\n');
  },
};

/** Sink en memoria para pruebas: guarda cada línea y la devuelve parseada. */
export class MemorySink implements LogSink {
  readonly lines: string[] = [];
  write(line: string): void {
    this.lines.push(line);
  }
  records(): Array<Record<string, unknown>> {
    return this.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  }
  /** Todo el texto emitido, para afirmar que algo NO aparece. */
  text(): string {
    return this.lines.join('\n');
  }
}

class LoggerImpl implements Logger {
  readonly level: LogLevel;
  readonly #format: LogFormat;
  readonly #sink: LogSink;
  readonly #bindings: LogFields;
  readonly #now: () => Date;

  constructor(opts: Required<Omit<LoggerOptions, 'bindings'>> & { bindings: LogFields }) {
    this.level = opts.level;
    this.#format = opts.format;
    this.#sink = opts.sink;
    this.#bindings = opts.bindings;
    this.#now = opts.now;
  }

  debug(msg: string, fields?: LogFields): void { this.#emit('debug', msg, fields); }
  info(msg: string, fields?: LogFields): void { this.#emit('info', msg, fields); }
  warn(msg: string, fields?: LogFields): void { this.#emit('warn', msg, fields); }
  error(msg: string, fields?: LogFields): void { this.#emit('error', msg, fields); }

  child(bindings: LogFields): Logger {
    return new LoggerImpl({
      level: this.level,
      format: this.#format,
      sink: this.#sink,
      now: this.#now,
      bindings: { ...this.#bindings, ...bindings },
    });
  }

  #emit(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const record = redactSecrets({ time: this.#now().toISOString(), level, msg, ...this.#bindings, ...fields }) as Record<string, unknown>;
    this.#sink.write(this.#format === 'json' ? toJson(record) : toPretty(record));
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return new LoggerImpl({
    level: options.level ?? 'info',
    format: options.format ?? 'json',
    sink: options.sink ?? stdoutSink,
    bindings: options.bindings ?? {},
    now: options.now ?? (() => new Date()),
  });
}

function toJson(record: Record<string, unknown>): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(record, (_key, value: unknown) => {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[circular]';
      seen.add(value);
    }
    return value;
  });
}

function toPretty(record: Record<string, unknown>): string {
  const { time, level, msg, ...rest } = record;
  const hhmmss = typeof time === 'string' ? time.slice(11, 19) : '';
  const tag = String(level).toUpperCase().padEnd(5);
  const extra = Object.entries(rest)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : toJson(v as Record<string, unknown>)}`)
    .join(' ');
  return `${hhmmss} ${tag} ${String(msg)}${extra ? '  ' + extra : ''}`;
}
