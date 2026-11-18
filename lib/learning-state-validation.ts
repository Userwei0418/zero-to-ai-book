import { z } from 'zod';
import type { LearningState } from './course-types';

export const MAX_LEARNING_STATE_BYTES = Math.floor(1.8 * 1024 * 1024);
export const MAX_PROJECT_FILE_BYTES = 128 * 1024;
export const MAX_CHAPTER_FILE_BYTES = 700 * 1024;
const encoder = new TextEncoder();
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);

function validKey(key: string) {
  return key.length > 0 && key.length <= 240 && !key.includes('\0') && !forbiddenKeys.has(key);
}

export function safeProjectPath(path: string) {
  if (!path || path.length > 240 || /[\\\u0000-\u001f\u007f:]/.test(path) || path.startsWith('/')) return false;
  return path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !forbiddenKeys.has(part));
}

const identifier = z.string().min(1).max(240).refine(validKey, '标识不正确。');
const chapterId = z.string().min(1).max(160).regex(/^[a-z0-9_-]+$/i).refine(validKey, '章节标识不正确。');
const text = z.string().max(180000);

function boundedRecord<T extends z.ZodTypeAny>(value: T, maximum = 2000) {
  return z.record(z.string().refine(validKey, '记录标识不正确。'), value).superRefine((record, context) => {
    if (Object.keys(record).length > maximum) context.addIssue({ code: z.ZodIssueCode.custom, message: '学习记录条目过多。' });
  });
}

const projectFiles = z.record(z.string().refine(safeProjectPath, '文件路径必须是安全的相对路径。'), z.string()).superRefine((files, context) => {
  let bytes = 0;
  if (Object.keys(files).length > 1000) context.addIssue({ code: z.ZodIssueCode.custom, message: '单章项目文件过多。' });
  for (const [path, content] of Object.entries(files)) {
    const length = encoder.encode(content).byteLength;
    bytes += length;
    if (length > MAX_PROJECT_FILE_BYTES) context.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: '单个文件不能超过 128 KiB。' });
  }
  if (bytes > MAX_CHAPTER_FILE_BYTES) context.addIssue({ code: z.ZodIssueCode.custom, message: '单章保存的文件总量不能超过 700 KiB。' });
});

const schema = z.object({
  chapterId: chapterId.optional(),
  anchor: z.string().max(240).optional(),
  fontSize: z.number().int().min(16).max(24).optional(),
  reduceMotion: z.boolean().optional(),
  bookmarks: z.array(z.object({
    chapterId,
    blockId: identifier,
    title: z.string().max(1000),
    savedAt: z.string().max(80),
  }).strip()).max(2000).optional(),
  codes: boundedRecord(text).optional(),
  files: z.record(chapterId, projectFiles).superRefine((files, context) => {
    if (Object.keys(files).length > 2000) context.addIssue({ code: z.ZodIssueCode.custom, message: '章节文件记录过多。' });
  }).optional(),
  predictions: boundedRecord(text).optional(),
  videoTimes: boundedRecord(z.number().finite().nonnegative(), 1000).optional(),
  chats: boundedRecord(z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(32000),
    sources: z.array(z.object({ chapterId, blockId: identifier, title: z.string().max(240), excerpt: z.string().max(360).optional() }).strip()).max(3).optional(),
    model: z.string().max(150).optional(),
  }).strip()).max(100), 1000).optional(),
}).strip().superRefine((state, context) => {
  if (encoder.encode(JSON.stringify(state)).byteLength > MAX_LEARNING_STATE_BYTES) context.addIssue({ code: z.ZodIssueCode.custom, message: '学习记录总量超过保存上限，请先导出并清理较早的记录。' });
});

/** Reject malformed input; preserve all supported fields and strip unknown fields. */
export function validateLearningState(value: unknown): LearningState {
  return schema.parse(value);
}
