import { ConsoleLogger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Error reporting that cannot leak. An error's name, message, stack, cause and extra
 * properties are all untrusted: a driver puts the connection URL in a message, a
 * provider SDK puts a token in a payload, `new URL(secret)` keeps the secret in an
 * `input` property, and any of them can be reassigned. None of that is ever read here.
 *
 * What is reported instead is derived from the error's *type* (instanceof against a
 * fixed list, never `error.name`) and, for a few families, a diagnostic code that is
 * accepted only if it has the exact shape of one. The one deliberate exception is
 * `ConfigurationError`, whose message is written by this codebase and names the
 * setting that is wrong, so that a misconfigured process says how to fix it.
 */

export type ErrorCategory =
  'configuration' | 'database' | 'system' | 'internal' | 'unknown';

export interface SafeErrorFields {
  errorCategory: ErrorCategory;
  /** A label from a fixed list; `Error` for any class that is not on it. */
  errorClass: string;
  /** A Prisma code such as `P2034`, or an allowlisted operating-system code. */
  errorCode?: string;
  /** The PostgreSQL SQLSTATE behind a failed raw query, such as `42501`. */
  sqlState?: string;
  /** Only for `ConfigurationError`: its printable, bounded message. */
  detail?: string;
}

/**
 * A problem the operator can fix by changing a setting, the environment or the
 * database roles. Its message is authored by this codebase: it names settings and
 * objects, and must never contain a setting's value, a credential or data from
 * outside (which is why this is the only error whose message is ever logged).
 */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

const MAX_DETAIL_LENGTH = 500;
const PRISMA_CODE = /^P\d{4}$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;
const IDENTIFIER = /^[A-Za-z0-9._-]{1,200}$/;
const CONTEXT_LABEL = /^[A-Za-z0-9_.:-]{1,100}$/;
const SYSTEM_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);

type ErrorConstructor = abstract new (...args: never[]) => Error;
const DATABASE_ERRORS: readonly (readonly [ErrorConstructor, string])[] = [
  [Prisma.PrismaClientKnownRequestError, 'PrismaClientKnownRequestError'],
  [Prisma.PrismaClientInitializationError, 'PrismaClientInitializationError'],
  [Prisma.PrismaClientRustPanicError, 'PrismaClientRustPanicError'],
  [Prisma.PrismaClientUnknownRequestError, 'PrismaClientUnknownRequestError'],
  [Prisma.PrismaClientValidationError, 'PrismaClientValidationError'],
];
const BUILT_IN_ERRORS: readonly (readonly [ErrorConstructor, string])[] = [
  [TypeError, 'TypeError'],
  [RangeError, 'RangeError'],
  [SyntaxError, 'SyntaxError'],
  [ReferenceError, 'ReferenceError'],
  [EvalError, 'EvalError'],
  [URIError, 'URIError'],
  [AggregateError, 'AggregateError'],
];

const UNKNOWN: SafeErrorFields = {
  errorCategory: 'unknown',
  errorClass: 'UnknownError',
};

function printable(value: string, limit: number): string {
  const clean = value.replace(/[^\x20-\x7e]/g, '?');
  return clean.length > limit ? `${clean.slice(0, limit)}...` : clean;
}

function matching(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

function withDefined(fields: SafeErrorFields): SafeErrorFields {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as unknown as SafeErrorFields;
}

function describeError(error: unknown): SafeErrorFields {
  if (!(error instanceof Error)) return UNKNOWN;

  if (error instanceof ConfigurationError) {
    return {
      errorCategory: 'configuration',
      errorClass: 'ConfigurationError',
      detail: printable(error.message, MAX_DETAIL_LENGTH),
    };
  }

  for (const [type, label] of DATABASE_ERRORS) {
    if (!(error instanceof type)) continue;
    const known = error as Partial<Prisma.PrismaClientKnownRequestError> &
      Partial<Prisma.PrismaClientInitializationError>;
    const meta: unknown = known.meta;
    return withDefined({
      errorCategory: 'database',
      errorClass: label,
      errorCode: matching(known.code ?? known.errorCode, PRISMA_CODE),
      sqlState:
        typeof meta === 'object' && meta !== null
          ? matching((meta as { code?: unknown }).code, SQLSTATE)
          : undefined,
    });
  }

  const systemCode = (error as { code?: unknown }).code;
  if (typeof systemCode === 'string' && SYSTEM_ERROR_CODES.has(systemCode)) {
    return { errorCategory: 'system', errorClass: 'Error', errorCode: systemCode };
  }

  const builtIn = BUILT_IN_ERRORS.find(([type]) => error instanceof type);
  return { errorCategory: 'internal', errorClass: builtIn?.[1] ?? 'Error' };
}

/** Never throws, whatever it is given, including an object that traps every access. */
export function safeErrorFields(error: unknown): SafeErrorFields {
  try {
    return describeError(error);
  } catch {
    return UNKNOWN;
  }
}

/** A short label safe to persist or expose; the class label of `safeErrorFields`. */
export function safeErrorClass(error: unknown): string {
  return safeErrorFields(error).errorClass;
}

/** An identifier (worker instance, request ID) is logged only if it looks like one. */
export function safeIdentifier(value: unknown): string | undefined {
  return matching(value, IDENTIFIER);
}

export type EventContext = Record<string, string | number | boolean | null>;

/**
 * One structured log line: a fixed `event` identifier, the operation's context, and
 * (when something failed) the safe description of the error. Context values come
 * from the caller and must already be safe: counts, flags, validated identifiers.
 */
export function eventLine(event: string, context: EventContext = {}): string {
  return JSON.stringify({ event, ...context });
}

export function errorEventLine(
  event: string,
  context: EventContext,
  error: unknown,
): string {
  return JSON.stringify({ event, ...context, ...safeErrorFields(error) });
}

/**
 * The framework logs a startup exception itself (as an object, so that its stack and
 * its extra properties are printed) before any application code can intercept it.
 * Installed as the application logger, this turns every error object that reaches
 * `error`, `warn` or `fatal` into the safe event line, and keeps only the context
 * label of the other arguments, which drops stacks and arbitrary objects.
 */
export class SafeConsoleLogger extends ConsoleLogger {
  override error(message: unknown, ...optionalParams: unknown[]): void {
    super.error(...sanitize(message, optionalParams));
  }

  override warn(message: unknown, ...optionalParams: unknown[]): void {
    super.warn(...sanitize(message, optionalParams));
  }

  override fatal(message: unknown, ...optionalParams: unknown[]): void {
    super.fatal(...sanitize(message, optionalParams));
  }
}

function sanitize(message: unknown, rest: unknown[]): [unknown, ...unknown[]] {
  const labels = rest.filter(
    (value): value is string => typeof value === 'string' && CONTEXT_LABEL.test(value),
  );
  const safeMessage =
    typeof message === 'string'
      ? message
      : errorEventLine('logger.error-object', {}, message);
  return [safeMessage, ...labels];
}
