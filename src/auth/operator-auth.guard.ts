import { timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  digestOperatorKey,
  OPERATOR_AUTH_CONFIG,
  type OperatorAuthConfig,
} from './operator-auth.config';

export interface AuthenticatedOperator {
  id: string;
}

export type AuthenticatedRequest = Request & { operator?: AuthenticatedOperator };

/**
 * Authenticates `Authorization: Bearer <key>` against the configured operator
 * keys. Identity comes only from the matched key, never from client-supplied
 * headers. Every failure looks identical so responses reveal nothing about keys.
 */
@Injectable()
export class OperatorAuthGuard implements CanActivate {
  constructor(
    @Inject(OPERATOR_AUTH_CONFIG) private readonly config: OperatorAuthConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const operatorId = this.authenticate(request.headers.authorization);
    if (!operatorId) {
      http.getResponse<Response>().setHeader('WWW-Authenticate', 'Bearer');
      throw new UnauthorizedException();
    }
    request.operator = { id: operatorId };
    return true;
  }

  private authenticate(header: string | undefined): string | null {
    const match = /^Bearer[ \t]+(\S+)$/i.exec(header?.trim() ?? '');
    if (!match?.[1]) return null;

    const presented = digestOperatorKey(match[1]);
    // Compare against every credential so timing does not depend on which one matched.
    let matched: string | null = null;
    for (const credential of this.config.credentials) {
      if (timingSafeEqual(presented, credential.keyDigest)) {
        matched = credential.operatorId;
      }
    }
    return matched;
  }
}

/** The authenticated operator's ID; only valid on routes behind OperatorAuthGuard. */
export const CurrentOperator = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const operator = context.switchToHttp().getRequest<AuthenticatedRequest>().operator;
    if (!operator) throw new UnauthorizedException();
    return operator.id;
  },
);
