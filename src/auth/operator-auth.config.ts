import { createHash } from 'node:crypto';
import { ConfigurationError } from '../common/logging/safe-error';

export const OPERATOR_AUTH_CONFIG = Symbol('OPERATOR_AUTH_CONFIG');

export interface OperatorCredential {
  operatorId: string;
  /** SHA-256 of the API key; the key itself is never retained. */
  keyDigest: Buffer;
}

export interface OperatorAuthConfig {
  credentials: readonly OperatorCredential[];
}

/** Messages name settings, never their values (see ConfigurationError). */
export class InvalidOperatorAuthConfigError extends ConfigurationError {
  constructor(problems: readonly string[]) {
    super(`Invalid operator authentication configuration: ${problems.join('; ')}`);
    this.name = 'InvalidOperatorAuthConfigError';
  }
}

export const MIN_OPERATOR_KEY_LENGTH = 32;
const MAX_OPERATOR_ID_LENGTH = 200;

export function digestOperatorKey(key: string): Buffer {
  return createHash('sha256').update(key, 'utf8').digest();
}

/**
 * Parses `OPERATOR_API_KEYS=operatorId=key,otherOperator=key`. An empty value is
 * valid and means no operator can authenticate (the operations endpoints stay
 * closed). Errors identify the offending entry by position, never by value.
 */
export function loadOperatorAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): OperatorAuthConfig {
  const raw = env.OPERATOR_API_KEYS?.trim();
  if (!raw) return { credentials: [] };

  const problems: string[] = [];
  const credentials: OperatorCredential[] = [];
  const seenIds = new Set<string>();
  const seenDigests = new Set<string>();

  raw.split(',').forEach((entry, index) => {
    const label = `OPERATOR_API_KEYS entry ${index + 1}`;
    const separator = entry.indexOf('=');
    const operatorId = separator < 0 ? '' : entry.slice(0, separator).trim();
    const key = separator < 0 ? '' : entry.slice(separator + 1).trim();

    if (separator < 0 || operatorId.length === 0) {
      problems.push(`${label} must have the form operatorId=key`);
      return;
    }
    if (operatorId.length > MAX_OPERATOR_ID_LENGTH || /\s/.test(operatorId)) {
      problems.push(
        `${label} has an operator ID that is too long or contains whitespace`,
      );
      return;
    }
    if (key.length < MIN_OPERATOR_KEY_LENGTH) {
      problems.push(
        `${label} key must be at least ${MIN_OPERATOR_KEY_LENGTH} characters`,
      );
      return;
    }

    const keyDigest = digestOperatorKey(key);
    if (seenIds.has(operatorId)) {
      problems.push(`${label} repeats an operator ID`);
      return;
    }
    if (seenDigests.has(keyDigest.toString('hex'))) {
      problems.push(`${label} reuses another operator's key`);
      return;
    }
    seenIds.add(operatorId);
    seenDigests.add(keyDigest.toString('hex'));
    credentials.push({ operatorId, keyDigest });
  });

  if (problems.length > 0) throw new InvalidOperatorAuthConfigError(problems);
  return { credentials };
}
