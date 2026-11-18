import type { GuideMessage, GuideSource } from './course-types';

export function guideSources(value: unknown): GuideSource[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).flatMap(source => {
    if (!source || typeof source !== 'object' || typeof source.chapterId !== 'string' ||
        !/^[a-z0-9_-]{1,160}$/i.test(source.chapterId) || typeof source.blockId !== 'string' ||
        !/^[a-z0-9_-]{1,240}$/i.test(source.blockId) || typeof source.title !== 'string') return [];
    return [{
      chapterId: source.chapterId, blockId: source.blockId, title: source.title.slice(0, 240),
      ...(typeof source.excerpt === 'string' ? { excerpt: source.excerpt.slice(0, 360) } : {}),
    }];
  });
}

export function guideMessage(value: unknown): GuideMessage[] {
  if (!value || typeof value !== 'object' || !('role' in value) || !('content' in value)) return [];
  if ((value.role !== 'user' && value.role !== 'assistant') || typeof value.content !== 'string') return [];
  const message: GuideMessage = { role: value.role, content: value.content.slice(0, 32000) };
  if (message.role === 'assistant') {
    if ('sources' in value) message.sources = guideSources(value.sources);
    if ('model' in value && typeof value.model === 'string') message.model = value.model.slice(0, 150);
  }
  return [message];
}
