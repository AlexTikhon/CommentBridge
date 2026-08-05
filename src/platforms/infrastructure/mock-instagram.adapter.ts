import { Injectable } from '@nestjs/common';
import { SocialPlatform } from '../../comments/domain/comment.types';
import { MockAdapterBase } from './mock-adapter.base';

@Injectable()
export class MockInstagramAdapter extends MockAdapterBase {
  readonly platform = SocialPlatform.INSTAGRAM;
  protected readonly maxReplyLength = 2_200;
}
