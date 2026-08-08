import { randomUUID } from 'node:crypto';
import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ApplicationError,
  type ApplicationErrorCode,
} from '../../comments/domain/comment.errors';
import {
  REQUEST_ID_HEADER,
  type RequestWithId,
} from '../logging/request-id.middleware';

interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
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
  DELIVERY_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    title: 'Reply delivery not found',
    slug: 'delivery-not-found',
  },
  DELIVERY_RETRY_NOT_ALLOWED: {
    status: HttpStatus.CONFLICT,
    title: 'Reply delivery cannot be retried',
    slug: 'delivery-retry-not-allowed',
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
  INTERNAL_ERROR: {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    title: 'Internal server error',
    slug: 'internal-error',
  },
};

interface ErrorMapping {
  status: number;
  title: string;
  slug: string;
  detail: string;
  code: string;
}

const HTTP_EXCEPTION_MAPPINGS: Readonly<Record<number, Omit<ErrorMapping, 'status'>>> =
  {
    [HttpStatus.BAD_REQUEST]: {
      title: 'Request validation failed',
      slug: 'validation-error',
      detail: 'One or more request values are invalid.',
      code: 'VALIDATION_ERROR',
    },
    [HttpStatus.UNAUTHORIZED]: {
      title: 'Authentication required',
      slug: 'authentication-required',
      detail: 'Authentication is required for this request.',
      code: 'UNAUTHORIZED',
    },
    [HttpStatus.FORBIDDEN]: {
      title: 'Access forbidden',
      slug: 'access-forbidden',
      detail: 'This request is not permitted.',
      code: 'FORBIDDEN',
    },
    [HttpStatus.NOT_FOUND]: {
      title: 'Resource not found',
      slug: 'resource-not-found',
      detail: 'The requested resource was not found.',
      code: 'NOT_FOUND',
    },
    [HttpStatus.CONFLICT]: {
      title: 'Request conflict',
      slug: 'request-conflict',
      detail: 'The request conflicts with the current resource state.',
      code: 'CONFLICT',
    },
    [HttpStatus.PAYLOAD_TOO_LARGE]: {
      title: 'Payload too large',
      slug: 'payload-too-large',
      detail: 'The request payload is too large.',
      code: 'PAYLOAD_TOO_LARGE',
    },
  };

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>() as RequestWithId;
    const requestId = request.requestId ?? randomUUID();
    response.setHeader(REQUEST_ID_HEADER, requestId);

    let mapping: ErrorMapping = {
      ...ERROR_HTTP.INTERNAL_ERROR,
      detail: 'An unexpected error occurred.',
      code: 'INTERNAL_ERROR',
    };
    let metadata: Readonly<Record<string, string | boolean>> | undefined;
    let errors: string[] | undefined;

    if (exception instanceof ApplicationError) {
      mapping = {
        ...ERROR_HTTP[exception.code],
        detail: exception.message,
        code: exception.code,
      };
      metadata = exception.metadata;
    } else if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const known = HTTP_EXCEPTION_MAPPINGS[status];
      mapping = known
        ? { status, ...known }
        : {
            status,
            title: 'Request failed',
            slug: 'http-error',
            detail: 'The request could not be completed.',
            code: `HTTP_${status}`,
          };

      if (exception instanceof BadRequestException) {
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
      }
    } else {
      this.logger.error(`Unexpected error requestId=${requestId}`);
    }

    const problem: ProblemDetails = {
      type: `https://commentbridge.local/problems/${mapping.slug}`,
      title: mapping.title,
      status: mapping.status,
      detail: mapping.detail,
      code: mapping.code,
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
