'use client';

import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { Chapter, ChapterInfo, LearningState } from '@/lib/course-types';
import { chapterExperimentRecords, type ExperimentRecord } from '@/lib/experiment-records';
import { readChapterRunHistory, subscribeRunHistory } from '@/lib/notebook-runtime';
import './experiment-records.css';

type Group = { chapter: ChapterInfo; rows: ExperimentRecord[] };
type Props = {
  chapters: ChapterInfo[];
  codes: LearningState['codes'];
  files: LearningState['files'];
  scope: string;
  loadChapter: (id: string) => Promise<Chapter>;
  onOpen: (entry: ExperimentRecord) => void;
};

const runLabels = { running: '运行中', ok: '已运行', error: '运行报错', interrupted: '已停止' } as const;

export function ExperimentRecords({ chapters, codes, files, scope, loadChapter, onOpen }: Props) {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [limit, setLimit] = useState(6);
  useEffect(() => {
    let disposed = false;
    let revision = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const editChapters = new Set(Object.keys(codes || {}).map(key => key.split(':', 1)[0]));
    const refresh = async () => {
      const current = ++revision;
      const chaptersWithRecords = chapters.map(chapter => ({
        chapter, runs: readChapterRunHistory(scope, chapter.id),
      })).filter(({ chapter, runs }) => editChapters.has(chapter.id) ||
        Object.keys(files?.[chapter.id] || {}).length > 0 || Object.keys(runs).length > 0);
      const outcomes = await Promise.allSettled(chaptersWithRecords.map(async ({ chapter, runs }) => {
        const source = await loadChapter(chapter.id);
        return { chapter, rows: chapterExperimentRecords(source, { codes, files }, runs) };
      }));
      if (disposed || current !== revision) return;
      setFailed(outcomes.some(outcome => outcome.status === 'rejected'));
      setGroups(outcomes.flatMap(outcome => outcome.status === 'fulfilled' && outcome.value.rows.length ? [outcome.value] : []));
    };
    void refresh();
    const unsubscribe = subscribeRunHistory(scope, () => {
      if (timer) return;
      timer = setTimeout(() => { timer = undefined; void refresh(); }, 400);
    });
    return () => { disposed = true; clearTimeout(timer); unsubscribe(); };
  }, [scope, chapters, codes, files, loadChapter, retry]);

  const rows = (groups || []).flatMap(group => group.rows.map(entry => ({ entry, chapter: group.chapter })));
  return <section className="experiment-records" aria-label="实验记录">
    <div className="record-section-title"><h3>实验记录</h3>{groups && <span>{rows.length} 项</span>}</div>
    {!groups && <p className="empty-record" role="status">正在读取实验记录…</p>}
    {groups && !rows.length && !failed && <p className="empty-record">改过的代码和运行过的实验会出现在这里。</p>}
    {rows.slice(0, limit).map(({ entry, chapter }) => <button className="experiment-record" key={entry.chapterId + ':' + entry.unit} onClick={() => onOpen(entry)}>
      <span><small>{chapter.volume === 'lower' ? '下册' : '上册'} · {chapter.shortTitle || chapter.title}</small>
        <strong>{entry.label}</strong>
        <span className="experiment-record-status">
          {entry.edited && <span>已修改</span>}
          {entry.run && <span className={entry.run.status === 'error' ? 'run-error' : undefined}>
            {entry.run.historical ? '历史输出' : '本次会话'} · {runLabels[entry.run.status]}
          </span>}
        </span>
      </span><ChevronRight aria-hidden="true" size={16}/>
    </button>)}
    {rows.length > limit && <button className="record-more" onClick={() => setLimit(value => value + 12)}>再显示 {Math.min(12, rows.length - limit)} 项</button>}
    {rows.some(({ entry }) => entry.run?.historical) && <p className="record-help">历史输出保存在本机。要恢复变量，可在工作区按顺序重跑单元。</p>}
    {failed && <div className="record-help" role="status">部分章节暂时无法读取。<button className="record-more" onClick={() => setRetry(value => value + 1)}>重试</button></div>}
  </section>;
}
