import { Module } from '@nestjs/common';
import {
  PlatformAdapterRegistry,
  PLATFORM_ADAPTERS,
} from './application/platform-adapter.registry';
import { MockInstagramAdapter } from './infrastructure/mock-instagram.adapter';
import { MockLinkedInAdapter } from './infrastructure/mock-linkedin.adapter';

@Module({
  providers: [
    MockInstagramAdapter,
    MockLinkedInAdapter,
    {
      provide: PLATFORM_ADAPTERS,
      inject: [MockInstagramAdapter, MockLinkedInAdapter],
      useFactory: (instagram: MockInstagramAdapter, linkedin: MockLinkedInAdapter) => [
        instagram,
        linkedin,
      ],
    },
    PlatformAdapterRegistry,
  ],
  exports: [PlatformAdapterRegistry, MockInstagramAdapter, MockLinkedInAdapter],
})
export class PlatformsModule {}
