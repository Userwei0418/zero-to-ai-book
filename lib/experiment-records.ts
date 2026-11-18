import type { Chapter, LearningState } from './course-types';
import type { RunHistory } from './notebook-runtime';

export type ExperimentRecord = {
  chapterId: string;
  unit: string;
  anchor?: string;
  filename?: string;
  label: string;
  edited: boolean;
  run?: RunHistory[string];
};

/** Linked project files and their full-file cells share the editor's effective contents. */
export function chapterProjectFiles(chapter: Chapter, codes: LearningState['codes'], files: LearningState['files']): Record<string, string> {
  const effective: Record<string, string> = Object.assign(Object.create(null), chapter.files, files?.[chapter.id]);
  for (const block of chapter.blocks) {
    if (!block.filename || typeof block.code !== 'string' || chapter.files?.[block.filename]?.trim() !== block.code.trim()) continue;
    const edit = codes?.[chapter.id + ':' + block.id];
    if (edit === undefined || edit === effective[block.filename]) continue;
    // Course cells may omit the attachment's final newline. Restoring a cell should
    // restore those original bytes, including when an older file override exists.
    effective[block.filename] = edit === block.code ? chapter.files![block.filename] : edit;
  }
  return effective;
}

export function chapterExperimentRecords(chapter: Chapter, state: LearningState, runs: RunHistory): ExperimentRecord[] {
  const rows: ExperimentRecord[] = [];
  const blocks = chapter.blocks.filter(block => block.type === 'code');
  const recordedFiles = new Set<string>();
  const { id: chapterId } = chapter;
  const files = chapterProjectFiles(chapter, state.codes, state.files);
  blocks.forEach((block, i) => {
    const saved = state.codes?.[chapterId + ':' + block.id];
    const edited = saved !== undefined && saved !== (block.code ?? '');
    const run = runs[block.id];
    if (!edited && !run) return;
    if (edited && block.filename && chapter.files?.[block.filename]?.trim() === block.code?.trim() &&
        files[block.filename] === saved) recordedFiles.add(block.filename);
    rows.push({
      chapterId, unit: block.id, anchor: block.id,
      label: block.filename ? `${block.filename} · 单元 ${i + 1}` : `代码单元 ${i + 1}`, edited, run,
    });
  });
  for (const [filename, content] of Object.entries(files)) {
    const unit = chapterId + '-file-' + filename;
    const run = runs[unit];
    const edited = content !== chapter.files?.[filename];
    if (!run && (!edited || recordedFiles.has(filename))) continue;
    const anchor = blocks.find(block => block.filename === filename)?.id;
    rows.push({ chapterId, unit, anchor, filename, label: filename, edited, run });
  }
  return rows;
}
