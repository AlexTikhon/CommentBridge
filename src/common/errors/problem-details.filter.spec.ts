import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  PayloadTooLargeException,
  UnauthorizedException,
  type ArgumentsHost,
} from '@nestjs/common';
import { ApplicationError } from '../../comments/domain/comment.errors';
import { ProblemDetailsFilter } from './problem-details.filter';

interface CapturedResponse {
  status: number;
  body: Record<string, unknown>;
}

interface ResponseDouble {
  setHeader(name: string, value: string): void;
  status(status: number): ResponseDouble;
  type(contentType: string): ResponseDouble;
  json(value: Record<string, unknown>): ResponseDouble;
}

function capture(exception: unknown): CapturedResponse {
  let statusCode = 0;
  let body: Record<string, unknown> = {};
  const response: ResponseDouble = {
    setHeader: () => undefined,
    status: (status: number): ResponseDouble => {
      statusCode = status;
      return response;
    },
    type: (): ResponseDouble => response,
    json: (value: Record<string, unknown>): ResponseDouble => {
      body = value;
      return response;
    },
  };
  const request = { requestId: 'unit-request-id' };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;

  new ProblemDetailsFilter().catch(exception, host);
  return { status: statusCode, body };
}

describe('ProblemDetailsFilter', () => {
  it.each([
    [new NotFoundException(), 404, 'NOT_FOUND'],
    [new UnauthorizedException(), 401, 'UNAUTHORIZED'],
    [new ForbiddenException(), 403, 'FORBIDDEN'],
    [new ConflictException(), 409, 'CONFLICT'],
    [new PayloadTooLargeException(), 413, 'PAYLOAD_TOO_LARGE'],
  ])(
    'preserves standard NestJS HTTP status and maps a safe body',
    (error, status, code) => {
      const captured = capture(error);

      expect(captured.status).toBe(status);
      expect(captured.body).toEqual(
        expect.objectContaining({
          status,
          code,
          requestId: 'unit-request-id',
        }),
      );
      expect(JSON.stringify(captured.body)).not.toContain('stack');
    },
  );

  it('preserves validation details from framework bad requests', () => {
    const captured = capture(
      new BadRequestException({ message: ['message must not be empty'] }),
    );

    expect(captured).toEqual({
      status: 400,
      body: expect.objectContaining({
        code: 'VALIDATION_ERROR',
        errors: ['message must not be empty'],
      }),
    });
  });

  it('preserves custom application error mappings and metadata', () => {
    const captured = capture(
      new ApplicationError('PLATFORM_UNAVAILABLE', 'Safe provider failure.', {
        replyId: 'reply-id',
        retryable: true,
      }),
    );

    expect(captured).toEqual({
      status: 502,
      body: expect.objectContaining({
        code: 'PLATFORM_UNAVAILABLE',
        detail: 'Safe provider failure.',
        replyId: 'reply-id',
        retryable: true,
      }),
    });
  });

  it('preserves an uncommon HTTP status without exposing its raw message', () => {
    const captured = capture(new HttpException('raw internal detail', 418));

    expect(captured.status).toBe(418);
    expect(captured.body).toEqual(
      expect.objectContaining({
        code: 'HTTP_418',
        detail: 'The request could not be completed.',
      }),
    );
    expect(JSON.stringify(captured.body)).not.toContain('raw internal detail');
  });
});
