'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowRight, Bookmark, BookOpen, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Cloud, Code2, Expand, FileText, History, List, LogIn, LoaderCircle, RotateCcw, Search, Settings2, Sparkles, Trash2, X } from 'lucide-react';
import type { Chapter, ChapterInfo, CourseBlock, CourseIndex, LearningState, Term } from '@/lib/course-types';
import { ExperimentRecords } from './experiment-records';
import { chapterProjectFiles, type ExperimentRecord } from '@/lib/experiment-records';
import { ProjectFiles } from '@/components/project-files';
import { clearNotebookHistory, getNotebookKernel, releaseNotebookSessions, runtimeUnavailable } from '@/lib/notebook-runtime';
import { NotebookCell, NotebookProvider, NotebookToolbar } from '@/components/notebook';
import { AIGuide, type GuideContext, type GuideMessage } from '@/components/ai-guide';
import { paginateChapter, resolvePageLocation, type BookPage, type PageFragment } from './book-pagination';
import { normalizeLearningState, readLocalDraft, useLearningStore } from './learning-store';
import { useReaderSession } from './reader-session';
import type { ReaderSession } from '@/lib/learning-cache';
import { isSampleOutput, markPredictionSamples } from '@/lib/sample-output';
import { SampleOutput } from './sample-output';
import { CourseImage, CourseVideo } from './course-media';
import { CourseImageViewer } from './course-media-reading';
import { PredictionCard, PredictionMeasures, PredictionReview } from './prediction-card';
import { withCoursePredictions } from '@/lib/course-predictions';
import { readingAnchor, readingLocationUrl } from '@/lib/book-location';

type Drawer = 'contents' | 'search' | 'settings' | 'records' | null;
type Location = {chapterId: string; anchor?: string};
const volumeNames = { upper: '上册 · 理解 AI 的来路', lower: '下册 · 做出自己的 AI 助手' };

function cleanTitle(title: string) { return title.replace(/\.md$/i, '').replace(/_/g, ' '); }
function projectFileCell(chapter: Chapter, filename: string, content: string): CourseBlock {
  const original = chapter.blocks.find(block => block.filename === filename || block.filename === filename.split('/').pop());
  const runtime = original?.runtime || (/\b(import|from)\s+(subprocess|fcntl|socket|multiprocessing|mcp|fastmcp|openai|anthropic|requests|httpx)\b/.test(content) ? 'linux' : 'browser');
  return { id: `${chapter.id}-file-${filename}`, type: 'code', language: 'python', filename, code: content, runnable: true, runtime };
}
function writeReadingLocation(chapterId: string, anchor: string) {
  const url = readingLocationUrl(window.location.href, chapterId, anchor);
  if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
}
function snippet(text: string, query: string) {
  const normalized = text.replace(/[#*_`>|]/g, '').replace(/\s+/g, ' ');
  const position = normalized.toLowerCase().indexOf(query.toLowerCase());
  return `${position > 30 ? '…' : ''}${normalized.slice(Math.max(0, position - 30), Math.max(0, position - 30) + 110)}…`;
}
function downloadJson(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function annotateHtml(html: string, terms: Term[], seen: Set<string>, query: string) {
  if (typeof document === 'undefined') return html;
  const root = document.createElement('div'); root.innerHTML = html;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.parentElement?.closest('a,button,code,pre,script,style')) nodes.push(node);
  }
  const vocabulary = terms.flatMap(term => [term.label, ...(term.aliases || [])].map(label => ({ term, label }))).filter(item => item.label.length > 1).sort((a, b) => b.label.length - a.label.length);
  for (const node of nodes) {
    const text = node.textContent || '';
    const result = document.createDocumentFragment();
    let offset = 0;
    while (offset < text.length) {
      let nearest: { start: number; label: string; term?: Term } | undefined;
      for (const item of vocabulary) {
        if (seen.has(item.term.id)) continue;
        const start = text.indexOf(item.label, offset);
        if (start >= 0 && (!nearest || start < nearest.start)) nearest = { start, ...item };
      }
      if (query.trim()) {
        const start = text.toLowerCase().indexOf(query.toLowerCase(), offset);
        if (start >= 0 && (!nearest || start <= nearest.start)) nearest = { start, label: text.slice(start, start + query.length) };
      }
      if (!nearest) { result.append(document.createTextNode(text.slice(offset))); break; }
      result.append(document.createTextNode(text.slice(offset, nearest.start)));
      const element = document.createElement(nearest.term ? 'button' : 'mark');
      element.textContent = nearest.label;
      if (nearest.term) { element.className = 'term-link'; element.dataset.term = nearest.term.id; element.setAttribute('type', 'button'); element.setAttribute('aria-label', `解释术语：${nearest.label}`); seen.add(nearest.term.id); }
      result.append(element);
      offset = nearest.start + nearest.label.length;
    }
    node.replaceWith(result);
  }
  return root.innerHTML;
}

function LocalDraftExport() {
  const [draft] = useState(readLocalDraft);
  if (!draft) return null;
  return <button onClick={() => downloadJson('零基础学AI-早期本地草稿.json', { state: draft })}><ArrowDownToLine size={16}/>导出之前的本地草稿</button>;
}

export function BookReader() {
  const { session, recheck } = useReaderSession();
  return <ScopedBookReader key={session?.scope || 'pending'} session={session} recheck={recheck}/>;
}

function ScopedBookReader({ session, recheck }: { session: ReaderSession | null; recheck: () => void }) {
  const learning = useLearningStore(session, recheck);
  const scope = session?.scope;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (scope) releaseNotebookSessions(scope); };
  }, [scope]);
  const signInHref = '/signin-with-chatgpt?return_to=' + encodeURIComponent(typeof window === 'undefined' ? '/' : window.location.pathname + window.location.search + window.location.hash);
  const { state, update } = learning;
  const [index, setIndex] = useState<CourseIndex | null>(null);
  const [indexError, setIndexError] = useState('');
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [chapterId, setChapterId] = useState('');
  const [chapterError, setChapterError] = useState('');
  const [reading, setReading] = useState(false);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState('');
  const [pages, setPages] = useState<BookPage[]>([]);
  const [page, setPage] = useState(0);
  const [single, setSingle] = useState(false);
  const [layout, setLayout] = useState({ width: 450, height: 500 });
  const [fontRevision, setFontRevision] = useState(0);
  const [turn, setTurn] = useState<'forward' | 'backward' | ''>('');
  const [lightbox, setLightbox] = useState<CourseBlock | null>(null);
  const [guide, setGuide] = useState<GuideContext | null>(null);
  const [seenGuideContexts] = useState(() => new Map<string, string>());
  const [workspace, setWorkspace] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<'cells' | 'files'>('cells');
  const [workspaceTarget, setWorkspaceTarget] = useState<string | null>(null);
  const [recordTarget, setRecordTarget] = useState<ExperimentRecord | null>(null);
  const [fileRun, setFileRun] = useState<CourseBlock | null>(null);
  const [selection, setSelection] = useState<{text: string; x: number; y: number} | null>(null);
  const [backLocations, setBackLocations] = useState<Location[]>([]);
  const [notice, setNotice] = useState('');
  const [prediction, setPrediction] = useState<string | null>(null);
  const [health, setHealth] = useState<{aiConfigured: boolean; remoteRuntimeConfigured: boolean; gpuConfigured: boolean} | null>(null);
  const remoteConfigured = learning.canUseServer ? health?.remoteRuntimeConfigured : false;
  const gpuConfigured = learning.canUseServer ? health?.gpuConfigured : false;
  const paperContent = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const predictionMeasure = useRef<HTMLDivElement>(null);
  const anchor = useRef('');
  const initialized = useRef(false);
  const cache = useRef(new Map<string, Chapter>());
  const prefetchedMedia = useRef(new Set<string>());
  const restoreFocus = useRef<HTMLElement | null>(null);
  const fontSize = state.fontSize || 18;
  const reduceMotion = Boolean(state.reduceMotion);
  const step = single ? 1 : 2;
  const currentInfo = index?.chapters.find(item => item.id === chapterId);
  const chapterOrder = index?.chapters.findIndex(item => item.id === chapterId) ?? 0;
  const nextChapter = index?.chapters[chapterOrder + 1];
  const prevChapter = index?.chapters[chapterOrder - 1];
  const currentAnchor = pages[page]?.[0]?.anchor || chapter?.blocks[0]?.id || '';
  const bookmarked = state.bookmarks?.some(item => item.chapterId === chapterId && item.blockId === currentAnchor);
  const chatKey = guide ? `${guide.chapterId}:${guide.historyKey || guide.termId || guide.selection?.slice(0, 70) || (guide.code ? 'code' : 'chapter')}` : '';
  const guideHistory: GuideMessage[] = state.chats?.[chatKey] || [];
  const readingBlocks = useMemo(() => chapter ? markPredictionSamples(withCoursePredictions(chapter.id, chapter.blocks)) : [], [chapter]);
  const projectFiles = useMemo(() => chapter?.id === chapterId
    ? chapterProjectFiles(chapter, state.codes, state.files) : {}, [chapter, chapterId, state.files, state.codes]);
  const updateProjectFile = (filename: string, content: string) => {
    const block = chapter?.blocks.find(item => item.filename === filename && chapter.files?.[filename]?.trim() === item.code?.trim());
    update(previous => ({ ...previous, files: { ...previous.files, [chapterId]: { ...previous.files?.[chapterId], [filename]: content } }, ...(block ? { codes: { ...previous.codes, [`${chapterId}:${block.id}`]: content } } : {}) }));
  };
  const runProjectFile = (filename: string, content: string) => {
    if (!chapter) return;
    const block = projectFileCell(chapter, filename, content);
    setFileRun(block);
    const kernel = getNotebookKernel(chapterId, learning.cacheScope);
    kernel.setFiles(projectFiles);
    void kernel.execute({ block, value: content });
  };

  const loadChapter = useCallback(async (id: string) => {
    const existing = cache.current.get(id);
    if (existing) return existing;
    const response = await fetch(`/course/chapters/${encodeURIComponent(id)}.json`);
    if (!response.ok) throw new Error('这一章暂时未能加载，请重试。');
    const value = await response.json() as Chapter;
    cache.current.set(id, value);
    return value;
  }, []);

  useEffect(() => {
    fetch('/course/index.json').then(async response => { if (!response.ok) throw new Error('课程目录加载失败'); return response.json() as Promise<CourseIndex>; }).then(setIndex).catch(error => setIndexError(error.message));
    fetch('/api/health').then(response => response.json()).then(data => setHealth(data as {aiConfigured: boolean; remoteRuntimeConfigured: boolean; gpuConfigured: boolean})).catch(() => {});
  }, []);

  useEffect(() => {
    if (!learning.ready || !index || initialized.current) return;
    initialized.current = true;
    const url = new URL(window.location.href);
    const requested = url.searchParams.get('chapter');
    const valid = requested && index.chapters.some(item => item.id === requested) ? requested : state.chapterId;
    const initial = valid && index.chapters.some(item => item.id === valid) ? valid : index.chapters[0]?.id;
    anchor.current = requested ? readingAnchor(url.hash) : state.anchor || '';
    if (initial) setChapterId(initial);
    if (requested) setReading(true);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches && state.reduceMotion === undefined) update({ reduceMotion: true });
  }, [learning.ready, index, state.chapterId, state.anchor, state.reduceMotion, update]);

  useEffect(() => {
    if (!chapterId) return;
    let disposed = false;
    setChapterError(''); setFileRun(null);
    const load = async () => {
      const existing = cache.current.get(chapterId);
      if (existing) { setChapter(existing); return; }
      setChapter(null); setPages([]);
      try {
        const value = await loadChapter(chapterId);
        if (!disposed) setChapter(value);
      } catch (error) { if (!disposed) setChapterError(error instanceof Error ? error.message : '加载失败'); }
    };
    void load();
    return () => { disposed = true; };
  }, [chapterId, loadChapter]);

  useLayoutEffect(() => {
    if (!reading || !paperContent.current) return;
    const element = paperContent.current;
    const read = () => {
      const rect = element.getBoundingClientRect();
      // Read the same CSS breakpoint that chooses the visible paper layout.
      setSingle(getComputedStyle(element).getPropertyValue('--reader-page-count').trim() === '1');
      if (rect.width && rect.height) setLayout(previous => Math.abs(previous.width - rect.width) > 1 || Math.abs(previous.height - rect.height) > 1 ? { width: rect.width, height: rect.height } : previous);
    };
    read();
    const observer = new ResizeObserver(read); observer.observe(element);
    window.addEventListener('resize', read);
    return () => { observer.disconnect(); window.removeEventListener('resize', read); };
  }, [reading, workspace]);

  useEffect(() => {
    const refresh = () => setFontRevision(value => value + 1);
    document.fonts.addEventListener('loadingdone', refresh);
    return () => document.fonts.removeEventListener('loadingdone', refresh);
  }, []);

  useLayoutEffect(() => {
    if (!chapter || chapter.id !== chapterId || !measure.current || !predictionMeasure.current || !reading) return;
    measure.current.style.width = `${layout.width}px`;
    measure.current.style.fontSize = `${fontSize}px`;
    const calculated = paginateChapter(readingBlocks, measure.current, layout.height, predictionMeasure.current);
    const { page: nextPage, anchor: nextAnchor } = resolvePageLocation(calculated, anchor.current, step);
    setPages(calculated); setPage(nextPage);
    if (nextAnchor) {
      anchor.current = nextAnchor;
      if (state.chapterId !== chapter.id || state.anchor !== nextAnchor) update({ chapterId: chapter.id, anchor: nextAnchor });
      writeReadingLocation(chapter.id, nextAnchor);
    }
  // Keep the stable paragraph anchor; saving state must not itself trigger pagination.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter, chapterId, readingBlocks, layout.width, layout.height, fontSize, fontRevision, step, reading]);

  useEffect(() => {
    if (!reading) return;
    // Warm only the next two pages' small illustrations/posters, after current content.
    // A video file is never requested until the reader presses play.
    const timer = window.setTimeout(() => {
      const sources = pages.slice(page + step, page + step + 2).flatMap(items => items.map(({ block }) => block.type === 'image' ? block.previewSrc || block.src : block.type === 'video' ? block.poster : undefined));
      sources.filter((src): src is string => Boolean(src)).slice(0, 4).forEach(src => {
        if (prefetchedMedia.current.has(src)) return;
        prefetchedMedia.current.add(src);
        const image = new Image(); image.decoding = 'async'; image.fetchPriority = 'low'; image.src = src;
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [pages, page, step, reading]);

  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 3500); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => { if (!turn) return; const timer = setTimeout(() => setTurn(''), 380); return () => clearTimeout(timer); }, [turn]);

  const navigate = useCallback((id: string, blockId = '', remember = true, search = '') => {
    if (!mounted.current) return;
    if (remember && chapterId) setBackLocations(previous => [...previous.slice(-9), { chapterId, anchor: anchor.current }]);
    setRecordTarget(null);
    anchor.current = blockId;
    setReading(true); setDrawer(null); setWorkspace(false); setSelection(null); setHighlight(search);
    if (id === chapterId && pages.length) {
      const location = resolvePageLocation(pages, blockId, step);
      setPage(location.page);
      anchor.current = location.anchor;
      update({ chapterId: id, anchor: anchor.current });
    } else { setPage(0); setChapterId(id); update({ chapterId: id, anchor: blockId }); }
    writeReadingLocation(id, anchor.current);
  }, [chapterId, pages, step, update]);

  useEffect(() => {
    const followAddress = () => {
      const url = new URL(window.location.href);
      const id = url.searchParams.get('chapter');
      if (!id || !index?.chapters.some(item => item.id === id)) return;
      const target = readingAnchor(url.hash);
      if (id !== chapterId || target !== anchor.current || !reading) navigate(id, target, false);
    };
    window.addEventListener('hashchange', followAddress);
    window.addEventListener('popstate', followAddress);
    return () => {
      window.removeEventListener('hashchange', followAddress);
      window.removeEventListener('popstate', followAddress);
    };
  }, [chapterId, index, navigate, reading]);

  const turnPage = useCallback((direction: number) => {
    if (!chapter || !pages.length) return;
    setSelection(null);
    const destination = page + direction * step;
    if (destination < 0) { if (prevChapter) navigate(prevChapter.id, '__last__', false); return; }
    if (destination >= pages.length) { if (nextChapter) navigate(nextChapter.id, '', false); return; }
    if (!reduceMotion) setTurn(direction > 0 ? 'forward' : 'backward');
    setPage(destination); anchor.current = pages[destination][0]?.anchor || '';
    update({ chapterId: chapter.id, anchor: anchor.current });
    writeReadingLocation(chapter.id, anchor.current);
  }, [chapter, pages, page, step, prevChapter, nextChapter, navigate, reduceMotion, update]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      if (event.key === 'Escape') { setDrawer(null); setLightbox(null); setSelection(null); setPrediction(null); if (workspace) setWorkspace(false); }
      if (!reading || drawer || lightbox || workspace || prediction || event.ctrlKey || event.metaKey || event.altKey) return;
      if (guide && (event.target as HTMLElement)?.closest('.guide-panel')) return;
      if ((event.target as HTMLElement)?.closest('input,textarea,select,button,[contenteditable="true"],video')) return;
      if (window.getSelection()?.toString()) return;
      if (event.key === 'ArrowRight') { event.preventDefault(); turnPage(1); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); turnPage(-1); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [reading, drawer, guide, lightbox, workspace, prediction, turnPage]);

  useEffect(() => {
    const selector = prediction ? '.prediction-note' : lightbox ? '.image-lightbox' : workspace ? '.experiment-workspace' : drawer ? '.reader-drawer' : null;
    if (!selector) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const modal = document.querySelector<HTMLElement>(selector);
    const frame = requestAnimationFrame(() => {
      const preferred = (drawer === 'search' || prediction) ? modal?.querySelector<HTMLElement>('input,textarea') : null;
      (preferred || modal?.querySelector<HTMLElement>('button,[tabindex="0"]'))?.focus({ preventScroll: true });
    });
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !modal || document.querySelector('.guide-panel')?.contains(document.activeElement)) return;
      const targets = Array.from(modal.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')).filter(item => item.offsetParent !== null);
      if (!targets.length) return;
      const first = targets[0]; const last = targets[targets.length - 1];
      if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', trap); document.body.style.overflow = overflow; previous?.focus({ preventScroll: true }); };
  }, [drawer, workspace, lightbox, prediction]);

  const openExperimentRecord = (entry: ExperimentRecord) => {
    navigate(entry.chapterId, entry.anchor);
    setRecordTarget(entry);
  };
  useEffect(() => {
    if (!recordTarget || chapter?.id !== recordTarget.chapterId || chapterId !== recordTarget.chapterId) return;
    const filename = recordTarget.filename;
    if (filename && recordTarget.run) setFileRun(projectFileCell(chapter, filename, projectFiles[filename] ?? ''));
    else setFileRun(null);
    setWorkspaceTarget(recordTarget.unit);
    setWorkspaceTab(filename ? 'files' : 'cells');
    setWorkspace(true);
    setRecordTarget(null);
  }, [recordTarget, chapter, chapterId, projectFiles]);

  const openWorkspace = (cellId?: string) => {
    setWorkspaceTarget(cellId || null);
    setWorkspaceTab('cells');
    setWorkspace(true);
  };
  useEffect(() => {
    if (!workspace || !workspaceTarget) return;
    const frame = requestAnimationFrame(() => {
      const area = document.querySelector<HTMLElement>('.experiment-workspace');
      const target = area?.querySelector<HTMLElement>(`[data-cell-id="${CSS.escape(workspaceTarget)}"]`) ||
        (workspaceTab === 'files' ? area?.querySelector<HTMLElement>('.project-editor') : null);
      target?.scrollIntoView({ block: 'start' });
      target?.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [workspace, workspaceTarget, workspaceTab]);

  const openGuide = useCallback((context: GuideContext) => {
    restoreFocus.current = document.activeElement as HTMLElement;
    setGuide(context); setSelection(null);
  }, []);
  const askChapter = () => { if (chapter) openGuide({ chapterId, title: '本章导读', definition: chapter.summary }); };
  const onProseClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const termElement = target.closest<HTMLElement>('[data-term]');
    if (termElement && chapter) {
      const term = index?.terms.find(item => item.id === termElement.dataset.term);
      if (term) openGuide({ chapterId, title: term.label, termId: term.id, definition: term.definition, selection: termElement.closest('.prose')?.textContent?.slice(0, 1600) || '' });
      return;
    }
    const link = target.closest<HTMLAnchorElement>('a');
    if (link) {
      const url = new URL(link.href, window.location.href);
      const id = url.searchParams.get('chapter') || link.dataset.chapterId;
      if (id && index?.chapters.some(item => item.id === id)) { event.preventDefault(); navigate(id, readingAnchor(url.hash)); }
      else if (url.origin === window.location.origin && url.hash && !url.search) { event.preventDefault(); navigate(chapterId, readingAnchor(url.hash)); }
    }
  };
  const onSelect = () => setTimeout(() => {
    const selected = window.getSelection();
    if (!selected?.rangeCount || selected.isCollapsed) { setSelection(null); return; }
    const text = selected.toString().trim();
    const common = selected.getRangeAt(0).commonAncestorContainer;
    const element = common instanceof Element ? common : common.parentElement;
    if (text.length < 3 || !element?.closest('.paper-content') || element.closest('textarea,code,pre')) return;
    const rect = selected.getRangeAt(0).getBoundingClientRect();
    setSelection({ text: text.slice(0, 6000), x: Math.min(window.innerWidth - 170, Math.max(16, rect.left + rect.width / 2 - 70)), y: Math.max(75, rect.top - 48) });
  }, 10);

  const toggleBookmark = () => {
    if (!chapter || !currentAnchor) return;
    update(previous => ({ ...previous, bookmarks: bookmarked ? previous.bookmarks?.filter(item => !(item.chapterId === chapterId && item.blockId === currentAnchor)) : [...(previous.bookmarks || []), { chapterId, blockId: currentAnchor, title: `${cleanTitle(chapter.shortTitle || chapter.title)} · ${pages[page]?.[0]?.block.text?.slice(0, 25) || `第 ${page + 1} 页`}`, savedAt: new Date().toISOString() }] }));
    setNotice(bookmarked ? '已移除这一页的书签' : '已夹好书签，下次可以从这里继续');
  };
  const searchResults = useMemo(() => {
    if (!index || query.trim().length < 1) return [];
    const term = query.trim().toLowerCase();
    return index.chapters.filter(item => `${item.title} ${item.text}`.toLowerCase().includes(term));
  }, [index, query]);
  const selectSearch = async (item: ChapterInfo) => {
    try {
      let result = cache.current.get(item.id);
      if (!result) { const response = await fetch(`/course/chapters/${item.id}.json`); if (!response.ok) throw new Error('加载失败'); result = await response.json() as Chapter; cache.current.set(item.id, result); }
      const match = result.blocks.find(block => `${block.text || ''} ${block.code || ''}`.toLowerCase().includes(query.trim().toLowerCase()));
      let offset = 0;
      if (match?.html) { const element = document.createElement('div'); element.innerHTML = match.html; offset = Math.max(0, (element.textContent || '').toLowerCase().indexOf(query.trim().toLowerCase())); }
      navigate(item.id, match ? `${match.id}${offset ? `::${offset}` : ''}` : '', true, query.trim());
    } catch { setNotice('这一条搜索结果暂时无法加载，请重试'); }
  };

  const restoreImportedLearning = async (incoming: Record<string, unknown>) => {
    const allowed = normalizeLearningState(incoming);
    if (incoming.files !== undefined) {
      if (!incoming.files || typeof incoming.files !== 'object' || Array.isArray(incoming.files)) throw new Error('项目文件格式不正确');
      allowed.files = Object.create(null);
      for (const [id, raw] of Object.entries(incoming.files)) {
        if (!index?.chapters.some(item => item.id === id) || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('项目文件的章节或格式不正确');
        let source = cache.current.get(id);
        if (!source) { const response = await fetch(`/course/chapters/${id}.json`); if (!response.ok) throw new Error('暂时无法校验项目文件，请联网后重试'); source = await response.json() as Chapter; cache.current.set(id, source); }
        const originals = source.files || {};
        const edits: Record<string, string> = Object.create(null);
        for (const [path, text] of Object.entries(raw)) {
          if (typeof text !== 'string') throw new Error('项目文件必须是文本');
          if (originals[path] === text) continue;
          const safe = normalizeLearningState({ files: { [id]: { [path]: text } } }).files?.[id]?.[path];
          if (safe !== text) throw new Error('文件路径不安全、格式不支持，或单文件超过 128 KiB');
          edits[path] = text;
        }
        const total = (files: Record<string, string>) => Object.values(files).reduce((sum, text) => sum + new TextEncoder().encode(text).length, 0);
        if (total({ ...originals, ...edits }) > Math.max(700 * 1024, total(originals))) throw new Error('合并后的项目超过 700 KiB，未导入任何修改');
        allowed.files![id] = edits;
      }
    }
    update(previous => ({ ...previous, ...allowed }));
    if (allowed.chapterId && index?.chapters.some(item => item.id === allowed.chapterId)) navigate(allowed.chapterId, allowed.anchor, false);
  };

  const openCellPrediction = (cellId: string) => {
    const question = readingBlocks.find(item => item.prediction?.cellId === cellId);
    if (!question) { setPrediction(cellId); return; }
    const selector = `.prediction-card[data-block-id="${CSS.escape(question.id)}"]`;
    const focusChoice = () => {
      const card = document.querySelector(selector);
      const radio = card?.querySelector<HTMLInputElement>('input:checked') || card?.querySelector<HTMLInputElement>('input[type="radio"]');
      radio?.focus({ preventScroll: true });
    };
    if (document.querySelector(selector)) focusChoice();
    else {
      navigate(chapterId, question.id);
      requestAnimationFrame(focusChoice);
    }
  };

  const renderFragment = (fragment: PageFragment, seen: Set<string>) => {
    const block = fragment.block;
    if (block.type === 'prediction' && block.prediction) {
      const target = chapter?.blocks.find(item => item.id === block.prediction?.cellId);
      if (!target) return null;
      const key = `${chapterId}:choice:${block.id}`;
      return <PredictionCard key={block.id} id={block.id} exercise={block.prediction} block={target} code={state.codes?.[`${chapterId}:${target.id}`] ?? target.code ?? ''} choice={state.predictions?.[key] || ''} onChange={choice => update(previous => ({ ...previous, predictions: { ...previous.predictions, [key]: choice } }))} onExpand={() => openWorkspace(target.id)} chapterId={chapterId} cacheScope={learning.cacheScope} height={fragment.height} saveLabel={saveLabels[learning.status]}/>;
    }
    if (isSampleOutput(block)) return <SampleOutput key={fragment.anchor} block={block} />;
    if (block.type === 'code') return <div className={`block-item code-page-block ${block.runnable ? '' : 'code-reference-block'}`} key={fragment.anchor} data-block-id={block.id} style={{ height: fragment.height }}>
      <NotebookCell block={block} chapterId={chapterId} value={state.codes?.[`${chapterId}:${block.id}`] ?? block.code ?? ''} onChange={value => update(previous => ({ ...previous, codes: { ...previous.codes, [`${chapterId}:${block.id}`]: value } }))} onExpand={() => openWorkspace(block.id)} onAsk={(code, error) => openGuide({ chapterId, title: error ? '帮我理解这个报错' : '解释这段代码', historyKey: `code:${block.id}`, code, error })}/>
      <div className="cell-bottom-actions">{block.runnable ? <button onClick={() => openCellPrediction(block.id)}>运行前，先记下预测</button> : <span>课程参考内容</span>}<button onClick={() => openWorkspace(block.id)}><Expand size={12}/>展开实验与完整输出</button></div>
    </div>;
    if (block.type === 'image') return <CourseImage key={fragment.anchor} block={block} onOpen={setLightbox} priority height={fragment.height}/>;
    if (block.type === 'video') return <div key={fragment.anchor} className="block-item video-page-block" data-block-id={block.id} style={{ height: fragment.height }}><CourseVideo block={block} height={fragment.height} time={state.videoTimes?.[`${chapterId}:${block.id}`] || 0} saveTime={time => update(previous => ({ ...previous, videoTimes: { ...previous.videoTimes, [`${chapterId}:${block.id}`]: time } }))}/></div>;
    const html = annotateHtml(fragment.html || block.html || `<p>${block.text || ''}</p>`, index?.terms || [], seen, highlight);
    return <div key={fragment.anchor} data-block-id={block.id} className={`block-item prose block-${block.type}${fragment.continued ? ' continued' : ''}`} onClick={onProseClick} dangerouslySetInnerHTML={{ __html: html }}/>;
  };

  const cookieBlocked = session?.snapshot.guestCookieBlocked === true;
  const offline = session?.verified === false;
  const guideUnavailable = cookieBlocked ? '请允许本站 Cookie 后刷新，即可向 AI 提问。'
    : offline ? '联网后即可重新确认阅读身份。'
    : learning.canUseServer && health?.aiConfigured === false ? '本站暂未启用 AI 导读。' : undefined;
  const recordHelp = offline ? '当前只显示本地草稿。联网后将重新确认阅读身份。'
    : cookieBlocked ? '允许本站 Cookie 后刷新，即可使用访客记录、AI 导读和远程实验。当前仍可阅读和运行浏览器实验。'
    : learning.guest ? '访客记录跟随此浏览器。清除 Cookie 或更换设备前，可先导出备份。'
    : learning.authenticated ? '阅读位置、书签、代码和导读记录随账号保存。'
    : '允许浏览器存储即可保留本机草稿。登录同一账号可跨设备同步。';
  const saveLabels = { loading: '正在恢复记录', saved: learning.guest ? '已保存访客记录' : learning.authenticated ? '已同步到账号' : '已保存到本机', saving: '正在保存', local: learning.canUseServer ? '已保存本机 · 待同步' : '已保存到本机', unsaved: '尚未保存', conflict: '记录有冲突' };
  const loading = !index || !learning.ready;
  const visiblePages = [page, ...(single ? [] : [page + 1])];
  const pageTerms: Set<string>[] = [];

  return <main className={`book-app ${reading ? 'is-reading' : 'is-cover'} ${reduceMotion ? 'reduce-motion' : ''}`}>
    <header className="site-header">
      <button className="brand" onClick={() => { setReading(false); setDrawer(null); }} aria-label="返回书籍封面"><BookOpen size={27} strokeWidth={1.4}/><span>从零开始学 <em>AI</em></span></button>
      <nav className="header-nav" aria-label="阅读工具">
        <button aria-label="目录" title="目录" aria-expanded={drawer === 'contents'} className={drawer === 'contents' ? 'active' : ''} onClick={() => setDrawer(drawer === 'contents' ? null : 'contents')}><List size={18}/><span>目录</span></button>
        <button aria-label="搜索" title="搜索" aria-expanded={drawer === 'search'} className={drawer === 'search' ? 'active' : ''} onClick={() => setDrawer(drawer === 'search' ? null : 'search')}><Search size={18}/><span>搜索</span></button>
        <i/>
        {learning.ready && !learning.authenticated && !learning.guest && !cookieBlocked && !offline && <button onClick={() => window.location.assign(signInHref)} aria-label="登录" title="登录"><LogIn size={18}/><span>登录</span></button>}
        <button disabled={!learning.ready} onClick={() => setDrawer(drawer === 'records' ? null : 'records')} aria-label="学习记录" aria-expanded={drawer === 'records'} title="我的学习记录"><Bookmark size={18}/><span className="desktop-only">学习记录</span></button>
        <button disabled={!learning.ready} onClick={() => setDrawer(drawer === 'settings' ? null : 'settings')} aria-label="阅读设置" aria-expanded={drawer === 'settings'} title="阅读设置"><Settings2 size={18}/><span className="desktop-only">阅读设置</span></button>
      </nav>
    </header>

    {!reading ? <section className="cover-scene">
      <div className="cover-art-wrap"><div className="cover-spine"/><img className="cover-art" src="/assets/book-cover-c2964faebc49af48.webp" alt="从零开始学 AI：从会回答，到能做事。穿过绿色山丘的红线，连接早期计算机、书本与工作桌。"/><div className="cover-page-edges"/></div>
      <div className="cover-intro">
        <p className="eyebrow"><span/>一本可以动手的交互书</p>
        <h1>从会回答，<br/>到能<span className="accent-word">做事。</span></h1>
        <p className="cover-lead">如果站回 AI 历史的岔路口，<br/>你会怎样选择？</p>
        <p className="cover-description">先想一想，再亲手试一试。沿着一个资料助手的成长，理解机器如何学习，也把自己的 AI 助手一步步做出来。</p>
        <div className="cover-actions"><button className="primary-button" disabled={loading || !chapterId} onClick={() => { setReading(true); update({ chapterId, anchor: anchor.current }); }}>{loading ? <LoaderCircle className="spin" size={18}/> : <BookOpen size={18}/>} {state.chapterId ? '继续阅读' : '翻开这本书'} <ArrowRight size={17}/></button><button className="text-button" onClick={() => setDrawer('contents')}>先看看目录 <ChevronRight size={15}/></button></div>
        {state.chapterId && currentInfo && <p className="continue-note">上次读到 · {cleanTitle(currentInfo.shortTitle || currentInfo.title)}</p>}
        {indexError && <p className="inline-error">{indexError} <button onClick={() => window.location.reload()}>重试</button></p>}
        <div className="cover-volumes"><div><span className="volume-number">上册</span><strong>理解，为什么</strong><p>从规则、学习到生成与推理</p></div><div><span className="volume-number">下册</span><strong>亲手，做出来</strong><p>从一个文件夹到可用的助手</p></div></div>
        <p className="cover-footnote">AI 零基础 · 有一点 Python 基础 <span>正文 / 视频 / 实验 / AI 导读</span></p>
      </div>
      <footer className="cover-bottom"><span>回到问题发生的地方，亲手走向答案。</span><span>零基础学 AI · 交互阅读版</span></footer>
    </section> : <>
      <div className="reading-heading"><div><span>{currentInfo?.volume === 'lower' ? '下册' : '上册'}</span><span className="heading-divider">/</span><span>{cleanTitle(currentInfo?.shortTitle || currentInfo?.title || '正在打开书页')}</span></div><div className="reader-utilities"><button className={`save-state ${learning.status}`} onClick={() => (learning.status === 'local' || learning.status === 'unsaved' || learning.status === 'conflict') ? setDrawer('records') : undefined} title={learning.error || saveLabels[learning.status]}>{learning.status === 'saving' || learning.status === 'loading' ? <LoaderCircle size={12} className="spin"/> : learning.status === 'saved' ? <Check size={12}/> : <Cloud size={13}/>}<span>{saveLabels[learning.status]}</span></button><button className="guide-entry" onClick={askChapter}><Sparkles size={14}/>本章导读</button></div></div>
      <NotebookProvider onIdentityChange={recheck} originalFiles={chapter?.files} saveLabel={saveLabels[learning.status]} saveIssue={learning.status === 'unsaved' || learning.status === 'conflict'} remoteRuntimeConfigured={remoteConfigured} gpuConfigured={gpuConfigured} cacheScope={learning.cacheScope} chapterId={chapterId} files={projectFiles} cells={chapter?.blocks.filter(block => block.type === 'code').map(block => ({ block, value: state.codes?.[`${chapterId}:${block.id}`] ?? block.code ?? '' }))}>
        <div className="reading-stage">
          <button className="outer-page-button previous" aria-label="上一页" disabled={page === 0 && !prevChapter} onClick={() => turnPage(-1)}><ChevronLeft size={24}/></button>
          <div className={`book-spread ${turn ? `turn-${turn}` : ''}`}>
            {visiblePages.map((pageIndex, side) => <article key={side} className={`book-paper ${side === 0 ? 'left-paper' : 'right-paper'}`} aria-label={`第 ${pageIndex + 1} 页`}>
              <div className="paper-running-head"><span>{side === 0 ? (currentInfo?.group || volumeNames[currentInfo?.volume || 'upper']) : cleanTitle(currentInfo?.shortTitle || '')}</span>{side === 0 ? <span className="paper-edition">从零开始学 AI</span> : <button className={`ribbon-bookmark ${bookmarked ? 'is-bookmarked' : ''}`} onClick={toggleBookmark} aria-label={bookmarked ? '移除书签' : '添加书签'} title={bookmarked ? '移除书签' : '在这里夹书签'}><Bookmark size={17} fill={bookmarked ? 'currentColor' : 'none'}/></button>}</div>
              <div ref={side === 0 ? paperContent : undefined} className="paper-content" style={{ fontSize }} onMouseUp={onSelect} onTouchEnd={onSelect}>
                {chapterError ? <div className="page-loading"><CircleHelp size={28}/><p>{chapterError}</p><button onClick={() => { cache.current.delete(chapterId); setChapterId(''); setTimeout(() => setChapterId(chapterId), 0); }}>重新加载</button></div> : !chapter || !pages.length ? <div className="page-loading"><LoaderCircle size={23} className="spin"/><p>正在整理这一章的书页…</p></div> : pages[pageIndex] ? pages[pageIndex].map(fragment => renderFragment(fragment, pageTerms[side] ||= new Set())) : <div className="chapter-colophon"><BookOpen size={30} strokeWidth={1}/><p>把刚才的想法，<br/>带到下一页。</p>{nextChapter ? <button className="text-button" onClick={() => navigate(nextChapter.id, '', false)}>继续 · {cleanTitle(nextChapter.shortTitle)}<ArrowRight size={15}/></button> : <span>全书正文至此。你也可以回到目录，继续探索。</span>}</div>}
              </div>
              <div className="paper-folio"><span>{pageIndex < pages.length ? String(pageIndex + 1).padStart(2, '0') : '·'}</span><span>{side === 0 ? (currentInfo?.volume === 'lower' ? '动手搭建' : '阅读与思考') : '在问题中学习'}</span></div>
              {single && <button className={`mobile-bookmark ${bookmarked ? 'is-bookmarked' : ''}`} onClick={toggleBookmark} aria-label={bookmarked ? '移除书签' : '添加书签'}><Bookmark size={17}/></button>}
            </article>)}
          </div>
          <button className="outer-page-button next" aria-label="下一页" disabled={page + step >= pages.length && !nextChapter} onClick={() => turnPage(1)}><ChevronRight size={24}/></button>
        </div>
        <div className="reading-bottom"><div className="reading-position">本章 <strong>{Math.min(page + 1, pages.length) || '—'}{!single && page + 2 <= pages.length ? `–${page + 2}` : ''}</strong><span>/ {pages.length || '—'} 页</span></div><input className="page-slider" aria-label="本章阅读位置" type="range" min={0} max={Math.max(0, Math.ceil(pages.length / step) - 1)} value={Math.floor(page / step)} onChange={event => { const nextPage = Number(event.target.value) * step; setPage(nextPage); anchor.current = pages[nextPage]?.[0]?.anchor || ''; update({ chapterId, anchor: anchor.current }); writeReadingLocation(chapterId, anchor.current); }} style={{ '--progress': `${pages.length > step ? (page / (pages.length - 1)) * 100 : 0}%` } as CSSProperties}/><div className="bottom-actions"><button className="mobile-previous" aria-label="上一页" disabled={!page && !prevChapter} onClick={() => turnPage(-1)}><ChevronLeft size={19}/></button><button className="bottom-next" disabled={page + step >= pages.length && !nextChapter} onClick={() => turnPage(1)}>{page + step >= pages.length ? (nextChapter ? '下一章' : '已到书末') : '下一页'} <ArrowRight size={18}/></button></div></div>
        <div className="reading-subline"><span>{backLocations.length > 0 ? <button onClick={() => { const previous = backLocations[backLocations.length - 1]; setBackLocations(items => items.slice(0, -1)); navigate(previous.chapterId, previous.anchor, false); }}><ArrowLeft size={12}/>返回刚才的阅读位置</button> : <span className="key-hint">← → 翻页 <i/>点击虚线词语，随时提问</span>}</span><button onClick={() => openWorkspace()}><Code2 size={13}/>展开本章实验 · 运行 / 重置</button></div>
        {workspace && chapter && <div className="workspace-backdrop"><section className="experiment-workspace" role="dialog" aria-modal="true" aria-label="实验工作区"><header className="workspace-heading"><div><p className="eyebrow">本章实验工作区</p><h2>{cleanTitle(chapter.shortTitle || chapter.title)}</h2></div><button className="icon-button" onClick={() => setWorkspace(false)} aria-label="收起实验，回到书页"><X size={22}/></button></header><div className="workspace-toolbar"><NotebookToolbar/><span>收起后仍保留本章会话，回到同一阅读位置。</span></div><div className="workspace-tabs" role="tablist" aria-label="实验视图"><button role="tab" aria-selected={workspaceTab === 'cells'} className={workspaceTab === 'cells' ? 'selected' : ''} onClick={() => setWorkspaceTab('cells')}><Code2 size={14}/>代码单元</button><button role="tab" aria-selected={workspaceTab === 'files'} className={workspaceTab === 'files' ? 'selected' : ''} onClick={() => setWorkspaceTab('files')}><FileText size={14}/>项目文件 <span>{Object.keys(projectFiles).length}</span></button></div><div className={`workspace-body ${workspaceTab === 'files' ? 'workspace-files' : ''}`}>{workspaceTab === 'files' ? <><ProjectFiles initialFilename={workspaceTarget?.startsWith(chapterId + '-file-') ? workspaceTarget.slice(chapterId.length + 6) : undefined} files={projectFiles} originalFiles={chapter.files || {}} onChange={updateProjectFile} onRun={runProjectFile} runUnavailable={(name, code) => runtimeUnavailable(projectFileCell(chapter, name, code).runtime || 'browser', remoteConfigured, gpuConfigured)} onAsk={(filename, code) => openGuide({ chapterId, title: `解释 ${filename}`, historyKey: `file:${filename}`, code })}/>{fileRun && <div className="file-run-result"><NotebookCell expanded block={fileRun} chapterId={chapterId} value={projectFiles[fileRun.filename || ''] ?? fileRun.code ?? ''} onChange={code => updateProjectFile(fileRun.filename || 'main.py', code)} onAsk={(code, error) => openGuide({ chapterId, title: error ? '帮我理解这个报错' : '解释文件代码', historyKey: `file:${fileRun.filename}`, code, error })}/></div>}</> : chapter.blocks.filter(block => block.type === 'code').length ? chapter.blocks.filter(block => block.type === 'code').map(block => <NotebookCell expanded key={block.id} block={block} chapterId={chapterId} value={state.codes?.[`${chapterId}:${block.id}`] ?? block.code ?? ''} onChange={value => update(previous => ({ ...previous, codes: { ...previous.codes, [`${chapterId}:${block.id}`]: value } }))} onAsk={(code, error) => openGuide({ chapterId, title: error ? '帮我理解这个报错' : '解释这段代码', historyKey: `code:${block.id}`, code, error })}/>) : <div className="empty-note"><BookOpen size={32}/><p>本篇以阅读与思考为主，没有代码单元。</p><button onClick={() => setWorkspace(false)}>回到书页</button></div>}</div></section></div>}
      </NotebookProvider>
    </>}

    <div ref={measure} className="pagination-measure paper-content" aria-hidden="true"/>
    <div ref={predictionMeasure} className="pagination-measure paper-content" style={{ width: layout.width, fontSize }} aria-hidden="true" inert><PredictionMeasures blocks={readingBlocks}/></div>
    {drawer && <div className="drawer-backdrop" onClick={() => setDrawer(null)}><aside className={`reader-drawer ${drawer === 'settings' ? 'settings-drawer' : ''}`} role="dialog" aria-modal="true" aria-label={{ contents: '全书目录', search: '全文搜索', settings: '阅读设置', records: '我的学习记录' }[drawer]} onClick={event => event.stopPropagation()}><header className="drawer-header"><div><p className="eyebrow">从零开始学 AI</p><h2>{{ contents: '书的目录', search: '在书中找一找', settings: '让阅读更舒服', records: '我的学习记录' }[drawer]}</h2></div><button className="icon-button" onClick={() => setDrawer(null)} aria-label="关闭面板"><X size={21}/></button></header>
      {drawer === 'contents' && <div className="drawer-scroll"><p className="drawer-intro">循着问题往前走，也可以从任何一章开始。</p>{index && <div className="toc-meta">上下两册 <span>·</span> {index.chapters.length} 篇正文、导读与附录</div>}{(['upper', 'lower'] as const).map(volume => <details className="toc-volume" key={volume} open><summary><span>{volume === 'upper' ? '上' : '下'}</span><div><strong>{volume === 'upper' ? '理解 AI 的来路' : '做出自己的 AI 助手'}</strong><small>{volume === 'upper' ? '从规则，走向学习与推理' : '从知识库，走向真正的应用'}</small></div><ChevronDown size={16}/></summary>{index && Array.from(new Set(index.chapters.filter(item => item.volume === volume).map(item => item.group))).map(group => <div className="toc-group" key={group}><h3>{group}</h3>{index.chapters.filter(item => item.volume === volume && item.group === group).map(item => <button className={`toc-item ${chapterId === item.id && reading ? 'current' : ''}`} key={item.id} onClick={() => navigate(item.id)}><span>{cleanTitle(item.shortTitle || item.title)}</span><ChevronRight size={13}/></button>)}</div>)}</details>)}</div>}
      {drawer === 'search' && <><div className="search-box"><Search size={18}/><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索正文、术语或一行代码" aria-label="全文搜索"/>{query && <button onClick={() => setQuery('')} aria-label="清除搜索"><X size={15}/></button>}</div><div className="drawer-scroll search-results">{query ? <><p className="result-count">{searchResults.length ? `在 ${searchResults.length} 篇文档中找到「${query}」` : `没有找到「${query}」`}</p>{searchResults.map(item => <button className="search-result" key={item.id} onClick={() => void selectSearch(item)}><small>{item.volume === 'upper' ? '上册' : '下册'} · {item.group}</small><h3>{cleanTitle(item.shortTitle || item.title)}</h3><p>{snippet(item.text, query)}</p><span>翻到这一页 <ArrowRight size={13}/></span></button>)}</> : <div className="search-suggestions"><p>从一个感兴趣的问题开始</p>{['机器学习', '神经网络', 'RAG', '记忆', 'MCP'].map(term => <button key={term} onClick={() => setQuery(term)}>{term}<ArrowRight size={13}/></button>)}<small>检索全部正文与课程代码。点击结果会定位并高亮。</small></div>}</div></>}
      {drawer === 'settings' && <div className="drawer-scroll"><section className="setting-section"><h3>正文字号</h3><p>调整字号后，仍回到正在读的这一段。</p><div className="font-control"><button disabled={fontSize <= 16} onClick={() => update({ fontSize: fontSize - 1 })}>小</button><span>{fontSize} px</span><button disabled={fontSize >= 24} onClick={() => update({ fontSize: fontSize + 1 })}>大</button></div><p className="font-preview" style={{ fontSize }}>学习，从一个好问题开始。</p></section><section className="setting-section"><label className="setting-toggle"><span><strong>减少翻页动画</strong><small>让书页直接切换，保持专注。</small></span><input type="checkbox" checked={reduceMotion} onChange={event => update({ reduceMotion: event.target.checked })}/></label></section><section className="setting-section"><h3>阅读方式</h3><p>宽屏自动双页，手机自动单页。支持选择正文、键盘左右键翻页，点击虚线术语可以打开 AI 导读。</p></section><section className="setting-section"><h3>服务状态</h3><p>{health ? `AI 导读：${health.aiConfigured ? '已配置服务' : '服务尚未配置，课程释义仍可阅读'}。` : '正在确认服务配置…'}</p><p>浏览器内 Python 按需加载。{health && !health.remoteRuntimeConfigured ? 'Linux / GPU 环境尚未连接；对应实验会标明运行条件。' : '需要远端环境的实验会显示各自的运行状态。'}</p></section></div>}
      {drawer === 'records' && <div className="drawer-scroll"><div className={`records-save ${learning.status}`}><Cloud size={20}/><div><strong>{saveLabels[learning.status]}</strong>{learning.error && <p>{learning.error}</p>}<p>{recordHelp}</p>{learning.authenticated ? <a href="/signout-with-chatgpt?return_to=%2F">退出登录</a> : !cookieBlocked && !offline && <a href={signInHref}>{learning.guest ? '登录使用独立的跨设备记录' : '登录并同步学习记录'}</a>}{learning.status === 'local' && learning.canUseServer && <button onClick={() => void learning.sync()}>重试同步</button>}{learning.status === 'conflict' && <div className="conflict-actions"><button onClick={() => learning.resolveConflict(true)}>继续使用本机记录</button><button onClick={() => { const restored = learning.resolveConflict(false); if (restored?.chapterId && index?.chapters.some(item => item.id === restored.chapterId)) navigate(restored.chapterId, restored.anchor, false); }}>加载服务器记录</button></div>}</div></div><div className="record-section-title"><h3>夹在书里的书签</h3><span>{state.bookmarks?.length || 0} 枚</span></div>{state.bookmarks?.length ? state.bookmarks.map(item => <div className="bookmark-record" key={`${item.chapterId}:${item.blockId}`}><button onClick={() => navigate(item.chapterId, item.blockId)}><Bookmark size={16}/><span>{item.title}<small>{new Date(item.savedAt).toLocaleDateString('zh-CN')}</small></span></button><button aria-label="删除这枚书签" onClick={() => update(previous => ({ ...previous, bookmarks: previous.bookmarks?.filter(bookmark => bookmark !== item) }))}><X size={14}/></button></div>) : <p className="empty-record">还没有夹书签。阅读时，点击书页右上角的书签即可保存位置。</p>}{index && <ExperimentRecords key={learning.cacheScope} chapters={index.chapters} codes={state.codes} files={state.files} scope={learning.cacheScope} loadChapter={loadChapter} onOpen={openExperimentRecord}/>}<div className="record-section-title"><h3>导读对话</h3><span>{Object.values(state.chats || {}).filter(value => value.length).length} 段</span></div>{Object.entries(state.chats || {}).filter(([, history]) => history.length).map(([key, history]) => <div className="saved-chat" key={key}><button onClick={() => { const id = key.split(':')[0]; setDrawer(null); const historyKey = key.slice(id.length + 1); const term = index?.terms.find(item => item.id === historyKey); const title = term?.label || index?.chapters.find(item => item.id === id)?.shortTitle || '已保存的导读'; navigate(id); const blockId = historyKey.startsWith('code:') ? historyKey.slice(5) : ''; const code = blockId ? state.codes?.[`${id}:${blockId}`] || cache.current.get(id)?.blocks.find(block => block.id === blockId)?.code : undefined; openGuide({ chapterId: id, title, historyKey, restore: true, termId: term?.id, definition: term?.definition, code, selection: term || historyKey === 'chapter' || blockId ? undefined : historyKey }); }}><span>{history.find(message => message.role === 'user')?.content.slice(0, 45) || '导读对话'}</span><small>{history.length} 条消息</small></button><button aria-label="删除导读记录" onClick={() => update(previous => { const chats = { ...previous.chats }; delete chats[key]; return { ...previous, chats }; })}><Trash2 size={13}/></button></div>)}<div className="data-actions">{learning.guest && <LocalDraftExport/>}<button onClick={() => downloadJson(`零基础学AI-学习记录-${new Date().toISOString().slice(0, 10)}.json`, { exportedAt: new Date().toISOString(), state })}><ArrowDownToLine size={16}/>导出我的学习记录</button><label><FileText size={16}/>导入学习记录<input type="file" accept="application/json,.json" onChange={async event => { const file = event.target.files?.[0]; if (!file) return; try { if (file.size > 2 * 1024 * 1024) throw new Error('too large'); const imported = JSON.parse(await file.text()); const incoming = imported.state || imported; if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw new Error('invalid'); await restoreImportedLearning(incoming); setNotice('已导入学习记录'); } catch (error) { setNotice(error instanceof Error && error.message !== 'invalid' && error.message !== 'too large' ? error.message : '记录无法读取或超过 2 MiB，请选择本书导出的 JSON 文件'); } }}/></label><button className="delete-records" onClick={async () => { if (window.confirm('删除自己的阅读位置、书签、代码修改、实验历史和导读记录？课程原文不受影响。建议先导出一份备份。')) { const deleted = await learning.deleteRecords(); if (deleted) { clearNotebookHistory(learning.cacheScope); setFileRun(null); setGuide(null); setReading(false); setDrawer(null); anchor.current = ''; if (index?.chapters[0]) setChapterId(index.chapters[0].id); setNotice('个人学习记录已删除'); } else setNotice('暂时无法删除服务器记录，请重试'); } }}><Trash2 size={15}/>删除我的学习记录</button></div></div>}
    </aside></div>}

    {guide && <AIGuide key={chatKey} context={guide} canAsk={learning.canUseServer && !guideUnavailable} unavailableReason={guideUnavailable} cacheScope={learning.cacheScope} signInHref={signInHref} seenContextSignatures={seenGuideContexts} onIdentityChange={recheck} history={guideHistory} onHistory={history => update(previous => ({ ...previous, chats: { ...previous.chats, [chatKey]: history } }))} onClose={() => { setGuide(null); restoreFocus.current?.focus(); }} onNavigate={(id, block) => navigate(id, block)}/>}
    {selection && <button className="selection-explain" style={{ left: selection.x, top: selection.y }} onMouseDown={event => event.preventDefault()} onClick={() => { openGuide({ chapterId, title: '读懂这一段', selection: selection.text }); window.getSelection()?.removeAllRanges(); }}><Sparkles size={15}/>请 AI 解释</button>}
    {lightbox && <CourseImageViewer block={lightbox} close={() => setLightbox(null)}/>}
    {prediction && <div className="prediction-backdrop" onClick={() => setPrediction(null)}><section className="prediction-note" role="dialog" aria-modal="true" aria-label="运行前的预测" onClick={event => event.stopPropagation()}><button className="prediction-close icon-button" onClick={() => setPrediction(null)} aria-label="关闭预测"><X size={18}/></button><p className="eyebrow">先猜一猜，再亲手验证</p><h2>你觉得，会发生什么？</h2><p>记下自己的判断。运行以后，回来和真实结果对照；也可以直接去实验。</p><textarea autoFocus placeholder="我猜测这段代码会……因为……" value={state.predictions?.[`${chapterId}:${prediction}`] || ''} onChange={event => update(previous => ({ ...previous, predictions: { ...previous.predictions, [`${chapterId}:${prediction}`]: event.target.value } }))}/><PredictionReview blockId={prediction} code={state.codes?.[`${chapterId}:${prediction}`] ?? chapter?.blocks.find(block => block.id === prediction)?.code ?? ''} chapterId={chapterId} cacheScope={learning.cacheScope} onExpand={() => { setPrediction(null); openWorkspace(prediction); }}/><div><small>预测随学习记录自动保存</small><button className="primary-button" onClick={() => setPrediction(null)}>带着猜想去实验 <ArrowRight size={14}/></button></div></section></div>}
    {notice && <div className="book-toast" role="status"><Check size={15}/>{notice}</div>}
  </main>;
}
