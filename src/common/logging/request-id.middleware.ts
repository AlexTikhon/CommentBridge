import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

export interface RequestWithId extends Request {
  requestId: string;
}

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RequestIdMiddleware.name);

  use(request: Request, response: Response, next: NextFunction): void {
    const incoming = request.header(REQUEST_ID_HEADER);
    const requestId =
      incoming && /^[a-zA-Z0-9._-]{1,100}$/.test(incoming) ? incoming : randomUUID();
    (request as RequestWithId).requestId = requestId;
    response.setHeader(REQUEST_ID_HEADER, requestId);
    response.on('finish', () => {
      this.logger.log(
        `${request.method} ${request.path} ${response.statusCode} requestId=${requestId}`,
      );
    });
    next();
  }
}
