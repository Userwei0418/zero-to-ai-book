import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const learningState = sqliteTable('learning_state', {
  userId: text('user_id').primaryKey(),
  state: text('state').notNull(),
  revision: integer('revision').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
});
export const requestQuota = sqliteTable('request_quota', {
  key: text('key').primaryKey(),
  count: integer('count').notNull().default(0),
  expiresAt: integer('expires_at').notNull(),
});
export const guideCache = sqliteTable('guide_cache', {
  key: text('key').primaryKey(),
  userId: text('user_id'),
  response: text('response').notNull(),
  expiresAt: integer('expires_at').notNull(),
});
