import type { LearningState } from './course-types';

export type LearningCache = { state: LearningState; revision: number; dirty: boolean; savedAt: string };
export type LearningSnapshot = { state?: LearningState; revision: number; authenticated?: boolean; cacheScope?: string };

/** An anonymous response has no server records and must never erase a local draft. */
export function selectLearningSnapshot(snapshot: LearningSnapshot, local: LearningCache | null) {
  if (!snapshot.authenticated) return {
    state: local?.state || {}, revision: 0, mode: 'device' as const,
  };
  if (local?.dirty) return {
    state: local.state, revision: local.revision || 0,
    mode: local.revision !== snapshot.revision ? 'conflict' as const : 'pending' as const,
  };
  return { state: snapshot.state || {}, revision: snapshot.revision || 0, mode: 'cloud' as const };
}

export function saveLearningCache(storage: Pick<Storage, 'setItem'>, key: string, value: LearningCache) {
  try { storage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}
