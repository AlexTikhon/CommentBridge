import type {
  CommentContext,
  CommentRecord,
  CommentView,
  CursorPage,
  ListCommentsInput,
} from '../../domain/comment.types';

export const COMMENT_REPOSITORY = Symbol('COMMENT_REPOSITORY');

export interface CreatePendingReplyInput {
  publicationId: string;
  parentId: string;
  idempotencyKey: string;
  body: string;
  authorExternalId: string;
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
    parentId: string,
    idempotencyKey: string,
  ): Promise<CommentRecord | null>;
  createPendingReply(input: CreatePendingReplyInput): Promise<CreatePendingReplyResult>;
}
