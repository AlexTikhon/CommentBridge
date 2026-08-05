import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ApplicationError,
  type ApplicationErrorCode,
} from '../../comments/domain/comment.errors';
import type { RequestWithId } from '../logging/request-id.middleware';

interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: ApplicationErrorCode;
  requestId: string;
  replyId?: string;
  retryable?: boolean;
  errors?: string[];
}

const ERROR_HTTP: Record<
  ApplicationErrorCode,
  { status: number; title: string; slug: string }
> = {
  VALIDATION_ERROR: {
    status: HttpStatus.BAD_REQUEST,
    title: 'Request validation failed',
    slug: 'validation-error',
  },
  POST_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    title: 'Post not found',
    slug: 'post-not-found',
  },
  COMMENT_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    title: 'Comment not found',
    slug: 'comment-not-found',
  },
  UNSUPPORTED_PLATFORM: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unsupported social platform',
    slug: 'unsupported-platform',
  },
  PUBLICATION_NOT_PUBLISHED: {
    status: HttpStatus.CONFLICT,
    title: 'Publication is not published',
    slug: 'publication-not-published',
  },
  IDEMPOTENCY_CONFLICT: {
    status: HttpStatus.CONFLICT,
    title: 'Idempotency conflict',
    slug: 'idempotency-conflict',
  },
  PLATFORM_RATE_LIMITED: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    title: 'Social platform rate limit reached',
    slug: 'platform-rate-limited',
  },
  PLATFORM_UNAVAILABLE: {
    status: HttpStatus.BAD_GATEWAY,
    title: 'Social platform is unavailable',
    slug: 'platform-unavailable',
  },
  PARENT_PUBLICATION_MISMATCH: {
    status: HttpStatus.CONFLICT,
    title: 'Invalid parent comment relationship',
    slug: 'parent-publication-mismatch',
  },
  INTERNAL_ERROR: {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    title: 'Internal server error',
    slug: 'internal-error',
  },
};

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>() as RequestWithId;
    const requestId = request.requestId;

    let code: ApplicationErrorCode = 'INTERNAL_ERROR';
    let detail = 'An unexpected error occurred.';
    let metadata: Readonly<Record<string, string | boolean>> | undefined;
    let errors: string[] | undefined;

    if (exception instanceof ApplicationError) {
      code = exception.code;
      detail = exception.message;
      metadata = exception.metadata;
    } else if (exception instanceof BadRequestException) {
      code = 'VALIDATION_ERROR';
      detail = 'One or more request values are invalid.';
      const body: unknown = exception.getResponse();
      if (
        typeof body === 'object' &&
        body !== null &&
        'message' in body &&
        Array.isArray(body.message)
      ) {
        errors = body.message.filter(
          (item): item is string => typeof item === 'string',
        );
      }
    } else {
      this.logger.error(`Unexpected error requestId=${requestId}`);
    }

    const mapping = ERROR_HTTP[code];
    const problem: ProblemDetails = {
      type: `https://example.local/problems/${mapping.slug}`,
      title: mapping.title,
      status: mapping.status,
      detail,
      code,
      requestId,
    };
    if (errors?.length) problem.errors = errors;
    if (typeof metadata?.replyId === 'string') problem.replyId = metadata.replyId;
    if (typeof metadata?.retryable === 'boolean') {
      problem.retryable = metadata.retryable;
    }

    response.status(mapping.status).type('application/problem+json').json(problem);
  }
}
