import { ApplicationError } from '../../comments/domain/comment.errors';
import { SocialPlatform } from '../../comments/domain/comment.types';
import { MockInstagramAdapter } from '../infrastructure/mock-instagram.adapter';
import { MockLinkedInAdapter } from '../infrastructure/mock-linkedin.adapter';
import { PlatformAdapterRegistry } from './platform-adapter.registry';

describe('PlatformAdapterRegistry', () => {
  const instagram = new MockInstagramAdapter();
  const linkedin = new MockLinkedInAdapter();
  const registry = new PlatformAdapterRegistry([instagram, linkedin]);

  it('resolves registered adapters by platform', () => {
    expect(registry.resolve(SocialPlatform.INSTAGRAM)).toBe(instagram);
    expect(registry.resolve(SocialPlatform.LINKEDIN)).toBe(linkedin);
  });

  it('reports an unsupported platform safely', () => {
    expect(() => registry.resolve('OTHER' as SocialPlatform)).toThrow(
      new ApplicationError('UNSUPPORTED_PLATFORM', 'Platform OTHER is not supported.'),
    );
  });

  it('exposes different capabilities and deterministic IDs', async () => {
    expect(instagram.getCapabilities().maxReplyLength).not.toBe(
      linkedin.getCapabilities().maxReplyLength,
    );
    const input = {
      publicationExternalId: 'post',
      parentExternalCommentId: 'comment',
      accountExternalId: 'account',
      message: 'hello',
      idempotencyKey: 'key',
    };
    expect(await instagram.replyToComment(input)).toEqual(
      await instagram.replyToComment(input),
    );
  });
});
