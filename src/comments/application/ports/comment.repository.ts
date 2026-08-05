import type {
  CommentContext,
  CommentRecord,
  CommentView,
  CursorPage,
  ListCommentsInput,
} from '../../domain/comment.types';
import type {
  PlatformCommentResult,
  SafeProviderError,
} from '../../../platforms/domain/platform.types';

export const COMMENT_REPOSITORY = Symbol('COMMENT_REPOSITORY');

export interface CreatePendingReplyInput {
  publicationId: string;
  parentId: string;
  idempotencyKey: string;
  body: string;
  authorDisplayName: string;
}

export interface CreatePendingReplyResult {
  reply: CommentRecord;
  created: boolean;
}

export interface CommentRepository {
  postExists(postId: string): Promise<boolean>;
  findByIdWithPublication(id: string): Promise<CommentContext | null>;
  findForPost(query: ListCommentsInput): Promise<CursorPage<CommentView>>;
  findByIdempotencyKey(
    publicationId: string,
    idempotencyKey: string,
  ): Promise<CommentRecord | null>;
  createPendingReply(input: CreatePendingReplyInput): Promise<CreatePendingReplyResult>;
  markReplySent(id: string, result: PlatformCommentResult): Promise<CommentRecord>;
  markReplyFailed(id: string, error: SafeProviderError): Promise<CommentRecord>;
}
