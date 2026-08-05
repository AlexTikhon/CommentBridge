import { Inject, Injectable } from '@nestjs/common';
import { ApplicationError } from '../../comments/domain/comment.errors';
import type { SocialPlatform } from '../../comments/domain/comment.types';
import type { SocialPlatformAdapter } from '../domain/platform.types';

export const PLATFORM_ADAPTERS = Symbol('PLATFORM_ADAPTERS');

@Injectable()
export class PlatformAdapterRegistry {
  private readonly adapters: ReadonlyMap<SocialPlatform, SocialPlatformAdapter>;

  constructor(@Inject(PLATFORM_ADAPTERS) adapters: readonly SocialPlatformAdapter[]) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.platform, adapter]));
  }

  resolve(platform: SocialPlatform): SocialPlatformAdapter {
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      throw new ApplicationError(
        'UNSUPPORTED_PLATFORM',
        `Platform ${platform} is not supported.`,
      );
    }
    return adapter;
  }
}
