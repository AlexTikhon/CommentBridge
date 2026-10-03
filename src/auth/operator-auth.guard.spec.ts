import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { loadOperatorAuthConfig } from './operator-auth.config';
import { OperatorAuthGuard, type AuthenticatedRequest } from './operator-auth.guard';

const aliceKey = 'a'.repeat(32);
const bobKey = 'b'.repeat(40);

function contextFor(headers: Record<string, string>) {
  const request = { headers } as unknown as AuthenticatedRequest;
  const setHeader = jest.fn();
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ setHeader }),
    }),
  } as unknown as ExecutionContext;
  return { context, request, setHeader };
}

describe('OperatorAuthGuard', () => {
  const guard = new OperatorAuthGuard(
    loadOperatorAuthConfig({ OPERATOR_API_KEYS: `alice=${aliceKey},bob=${bobKey}` }),
  );

  it('authenticates a bearer key and attaches the operator it belongs to', () => {
    const { context, request } = contextFor({ authorization: `Bearer ${bobKey}` });

    expect(guard.canActivate(context)).toBe(true);
    expect(request.operator).toEqual({ id: 'bob' });
  });

  it('accepts a case-insensitive scheme', () => {
    const { context, request } = contextFor({ authorization: `bearer ${aliceKey}` });

    expect(guard.canActivate(context)).toBe(true);
    expect(request.operator?.id).toBe('alice');
  });

  it.each([
    ['no header', {}],
    ['a different scheme', { authorization: `Basic ${aliceKey}` }],
    ['an empty token', { authorization: 'Bearer ' }],
    ['an unknown key', { authorization: `Bearer ${'z'.repeat(32)}` }],
    ['a near-miss key', { authorization: `Bearer ${aliceKey}x` }],
  ])('rejects %s without revealing why', (_label, headers) => {
    const { context, request, setHeader } = contextFor(headers);

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(request.operator).toBeUndefined();
    expect(setHeader).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer');
  });

  it('ignores a spoofed X-Operator-Id header', () => {
    const { context, request } = contextFor({
      authorization: `Bearer ${aliceKey}`,
      'x-operator-id': 'mallory',
    });

    guard.canActivate(context);

    expect(request.operator).toEqual({ id: 'alice' });
  });

  it('denies everyone when no credentials are configured', () => {
    const closed = new OperatorAuthGuard(loadOperatorAuthConfig({}));
    const { context } = contextFor({ authorization: `Bearer ${aliceKey}` });

    expect(() => closed.canActivate(context)).toThrow(UnauthorizedException);
  });
});
