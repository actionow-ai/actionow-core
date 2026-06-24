import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  doublePrecision,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { subject, tenant } from './identity.js';

/**
 * A reference to an object stored in an S3-compatible bucket. Actionow persists
 * the storage *reference* (provider/bucket/key + metadata), never the raw URL —
 * presigned GET/PUT URLs are minted on demand from this row.
 *
 * Lifecycle: a row is created `pending` when a presigned upload URL is issued;
 * once the client has uploaded and the upload is confirmed (HEAD), it moves to
 * `ready` with the observed `size`/`content_type`/`etag`.
 */
export const fileObject = pgTable(
  'file_object',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    // The subject (end-user) that owns this asset (unified tenancy G-B); null → tenant-level.
    subjectId: uuid('subject_id').references(() => subject.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(),
    bucket: text('bucket').notNull(),
    key: text('key').notNull(),
    size: bigint('size', { mode: 'number' }),
    contentType: text('content_type'),
    etag: text('etag'),
    // Media metadata (P1): populated when a generated image/video/audio asset is persisted.
    width: bigint('width', { mode: 'number' }),
    height: bigint('height', { mode: 'number' }),
    duration: doublePrecision('duration'),
    // status allowed values: pending (createFileObject default) | ready (markFileReady)
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('file_object_tenant_idx').on(t.tenantId),
    index('file_object_subject_idx').on(t.subjectId),
    check('file_object_status_allowed', sql`${t.status} IN ('pending', 'ready')`),
  ],
);
