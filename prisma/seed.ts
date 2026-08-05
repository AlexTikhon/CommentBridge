import {
  CommentDirection,
  DeliveryStatus,
  PrismaClient,
  PublicationStatus,
  SocialPlatform,
} from '@prisma/client';

const prisma = new PrismaClient();

export const SEED_IDS = {
  post: '11111111-1111-4111-8111-111111111111',
  instagramAccount: '22222222-2222-4222-8222-222222222221',
  linkedinAccount: '22222222-2222-4222-8222-222222222222',
  instagramPublication: '33333333-3333-4333-8333-333333333331',
  linkedinPublication: '33333333-3333-4333-8333-333333333332',
  draftPublication: '33333333-3333-4333-8333-333333333333',
  failedPublication: '33333333-3333-4333-8333-333333333334',
  instagramComment: '44444444-4444-4444-8444-444444444441',
  instagramSecondComment: '44444444-4444-4444-8444-444444444442',
  linkedinComment: '44444444-4444-4444-8444-444444444443',
  draftComment: '44444444-4444-4444-8444-444444444444',
  failedComment: '44444444-4444-4444-8444-444444444445',
  seededReply: '55555555-5555-4555-8555-555555555551',
} as const;

export async function seed(client: PrismaClient = prisma): Promise<void> {
  const createdAt = new Date('2026-08-04T09:00:00.000Z');

  await client.post.upsert({
    where: { id: SEED_IDS.post },
    update: { content: 'A deterministic cross-platform product update.' },
    create: {
      id: SEED_IDS.post,
      content: 'A deterministic cross-platform product update.',
      createdAt,
    },
  });

  await client.socialAccount.upsert({
    where: { id: SEED_IDS.instagramAccount },
    update: {},
    create: {
      id: SEED_IDS.instagramAccount,
      platform: SocialPlatform.INSTAGRAM,
      externalAccountId: 'mock-instagram-account-1',
      displayName: 'Demo Brand Instagram',
      createdAt,
    },
  });
  await client.socialAccount.upsert({
    where: { id: SEED_IDS.linkedinAccount },
    update: {},
    create: {
      id: SEED_IDS.linkedinAccount,
      platform: SocialPlatform.LINKEDIN,
      externalAccountId: 'mock-linkedin-account-1',
      displayName: 'Demo Brand LinkedIn',
      createdAt,
    },
  });

  await client.postPublication.upsert({
    where: { id: SEED_IDS.instagramPublication },
    update: { status: PublicationStatus.PUBLISHED },
    create: {
      id: SEED_IDS.instagramPublication,
      postId: SEED_IDS.post,
      socialAccountId: SEED_IDS.instagramAccount,
      externalPostId: 'instagram-post-100',
      status: PublicationStatus.PUBLISHED,
      publishedAt: new Date('2026-08-04T09:30:00.000Z'),
      createdAt,
    },
  });
  await client.postPublication.upsert({
    where: { id: SEED_IDS.draftPublication },
    update: { status: PublicationStatus.DRAFT },
    create: {
      id: SEED_IDS.draftPublication,
      postId: SEED_IDS.post,
      socialAccountId: SEED_IDS.instagramAccount,
      externalPostId: 'instagram-post-draft',
      status: PublicationStatus.DRAFT,
      createdAt,
    },
  });
  await client.postPublication.upsert({
    where: { id: SEED_IDS.failedPublication },
    update: { status: PublicationStatus.FAILED },
    create: {
      id: SEED_IDS.failedPublication,
      postId: SEED_IDS.post,
      socialAccountId: SEED_IDS.instagramAccount,
      externalPostId: 'instagram-post-failed',
      status: PublicationStatus.FAILED,
      createdAt,
    },
  });
  await client.postPublication.upsert({
    where: { id: SEED_IDS.linkedinPublication },
    update: { status: PublicationStatus.PUBLISHED },
    create: {
      id: SEED_IDS.linkedinPublication,
      postId: SEED_IDS.post,
      socialAccountId: SEED_IDS.linkedinAccount,
      externalPostId: 'linkedin-post-200',
      status: PublicationStatus.PUBLISHED,
      publishedAt: new Date('2026-08-04T09:35:00.000Z'),
      createdAt,
    },
  });

  const inboundComments = [
    {
      id: SEED_IDS.instagramComment,
      postPublicationId: SEED_IDS.instagramPublication,
      externalCommentId: 'instagram-comment-101',
      authorExternalId: 'instagram-user-10',
      authorDisplayName: 'Demo User A',
      body: 'Great product update!',
      remoteCreatedAt: new Date('2026-08-04T10:00:00.000Z'),
    },
    {
      id: SEED_IDS.instagramSecondComment,
      postPublicationId: SEED_IDS.instagramPublication,
      externalCommentId: 'instagram-comment-102',
      authorExternalId: 'instagram-user-11',
      authorDisplayName: 'Demo User B',
      body: 'When is the next release?',
      remoteCreatedAt: new Date('2026-08-04T10:05:00.000Z'),
    },
    {
      id: SEED_IDS.linkedinComment,
      postPublicationId: SEED_IDS.linkedinPublication,
      externalCommentId: 'linkedin-comment-201',
      authorExternalId: 'linkedin-user-20',
      authorDisplayName: 'Demo User C',
      body: 'Thanks for sharing this update.',
      remoteCreatedAt: new Date('2026-08-04T10:10:00.000Z'),
    },
    {
      id: SEED_IDS.draftComment,
      postPublicationId: SEED_IDS.draftPublication,
      externalCommentId: 'instagram-comment-draft',
      authorExternalId: 'instagram-user-draft',
      authorDisplayName: 'Draft Commenter',
      body: 'This comment belongs to a draft publication.',
      remoteCreatedAt: new Date('2026-08-04T10:15:00.000Z'),
    },
    {
      id: SEED_IDS.failedComment,
      postPublicationId: SEED_IDS.failedPublication,
      externalCommentId: 'instagram-comment-failed',
      authorExternalId: 'instagram-user-failed',
      authorDisplayName: 'Failed Commenter',
      body: 'This comment belongs to a failed publication.',
      remoteCreatedAt: new Date('2026-08-04T10:20:00.000Z'),
    },
  ];

  for (const comment of inboundComments) {
    await client.comment.upsert({
      where: { id: comment.id },
      update: {},
      create: {
        ...comment,
        direction: CommentDirection.INBOUND,
        deliveryStatus: DeliveryStatus.RECEIVED,
        createdAt,
      },
    });
  }

  await client.comment.upsert({
    where: { id: SEED_IDS.seededReply },
    update: {},
    create: {
      id: SEED_IDS.seededReply,
      postPublicationId: SEED_IDS.instagramPublication,
      parentId: SEED_IDS.instagramComment,
      externalCommentId: 'instagram-reply-501',
      direction: CommentDirection.OUTBOUND,
      deliveryStatus: DeliveryStatus.SENT,
      idempotencyKey: 'seeded-reply-key',
      authorExternalId: 'mock-instagram-account-1',
      authorDisplayName: 'Demo Brand Instagram',
      body: 'Thank you for the feedback!',
      remoteCreatedAt: new Date('2026-08-04T10:02:00.000Z'),
      createdAt,
    },
  });
}

if (require.main === module) {
  void seed()
    .then(() => {
      console.log(`Seed complete. Post ID: ${SEED_IDS.post}`);
    })
    .finally(async () => prisma.$disconnect());
}
