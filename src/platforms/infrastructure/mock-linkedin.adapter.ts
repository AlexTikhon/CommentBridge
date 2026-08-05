import { Injectable } from '@nestjs/common';
import { SocialPlatform } from '../../comments/domain/comment.types';
import { MockAdapterBase } from './mock-adapter.base';

@Injectable()
export class MockLinkedInAdapter extends MockAdapterBase {
  readonly platform = SocialPlatform.LINKEDIN;
  protected readonly maxReplyLength = 1_250;
}
