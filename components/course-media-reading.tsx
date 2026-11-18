'use client';

import { useEffect, useRef, useState } from 'react';
import { Maximize, Minus, Plus, X } from 'lucide-react';
import type { CourseBlock } from '@/lib/course-types';

type Cue = { start: number; text: string };

function parseCues(vtt: string): Cue[] {
  return vtt.trim().split(/\r?\n\s*\r?\n/).slice(1).map(block => {
    const [timing, ...lines] = block.split(/\r?\n/);
    const [h, m, s] = timing.split(' --> ')[0].split(':').map(Number);
    return { start: h * 3600 + m * 60 + s, text: lines.join(' ') };
  }).filter(cue => Number.isFinite(cue.start) && cue.text);
}

export function VideoReading({ block, close, seek }: { block: CourseBlock; close: () => void; seek: (time: number) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [cues, setCues] = useState<Cue[]>([]);
  const [loading, setLoading] = useState(Boolean(block.subtitleSrc));
  const [failed, setFailed] = useState(false);
  const [request, setRequest] = useState(0);
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => { el?.close(); };
  }, []);
  useEffect(() => {
    if (!block.subtitleSrc) { setLoading(false); return; }
    const controller = new AbortController();
    setFailed(false); setLoading(true);
    fetch(block.subtitleSrc, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error();
      const parsed = parseCues(await response.text());
      if (!parsed.length) throw new Error();
      if (!controller.signal.aborted) { setCues(parsed); setLoading(false); }
    }).catch(() => { if (!controller.signal.aborted) { setFailed(true); setLoading(false); } });
    return () => controller.abort();
  }, [block.subtitleSrc, request]);

  return <dialog ref={dialog} className="course-video-reading" aria-labelledby="video-reading-title"
    onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === dialog.current) close(); }}>
    <article>
      <header><div><span>视频文字稿</span><h2 id="video-reading-title">{block.caption}</h2></div>
        <button type="button" onClick={close} aria-label="关闭文字稿" autoFocus><X size={20}/></button></header>
      <div className="video-reading-body">
        {block.excerptNotice && <p className="video-reading-help">{block.excerptNotice}</p>}
        {loading && <p role="status">正在加载文字稿…</p>}
        {failed && <p role="alert">文字稿加载失败。<button type="button" onClick={() => setRequest(value => value + 1)}>重试</button></p>}
        {cues.length > 0 && <ol aria-label="按时间跳转到视频"><li className="video-reading-help">点击时间，从这一句开始播放。</li>
          {cues.map(cue => <li key={cue.start}><button type="button" onClick={() => seek(cue.start)} aria-label={`从 ${Math.floor(cue.start / 60)} 分 ${Math.floor(cue.start % 60)} 秒播放`}>{Math.floor(cue.start / 60)}:{String(Math.floor(cue.start % 60)).padStart(2, '0')}</button><p>{cue.text}</p></li>)}</ol>}
        {block.readingAlternative && <section className="video-reading-alternative"><h3>本章补读</h3>
          {block.readingAlternative.map(paragraph => <p key={paragraph}>{paragraph}</p>)}</section>}
      </div>
    </article>
  </dialog>;
}

export function CourseImageViewer({ block, close }: { block: CourseBlock; close: () => void }) {
  const view = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [intrinsic, setIntrinsic] = useState({ width: block.width || 0, height: block.height || 0 });
  const [scale, setScale] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const fit = viewport.width && intrinsic.width ? Math.min(viewport.width / intrinsic.width, viewport.height / intrinsic.height, 1) : 1;
  const current = scale ?? fit;
  const steps = [...new Set([fit, .5, .75, 1, 1.5, 2, 3, 4])].sort((a,b) => a-b);
  const next = steps.find(value => value > current + .015);
  const previous = steps.filter(value => value < current - .015 && value >= fit).pop();
  useEffect(() => {
    if (!view.current) return;
    const el = view.current;
    const measure = () => setViewport({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure); observer.observe(el);
    return () => observer.disconnect();
  }, []);
  function zoom(value: number | null) {
    const el = view.current;
    if (!el) return;
    const x = (el.scrollLeft + el.clientWidth / 2) / Math.max(el.scrollWidth, 1);
    const y = (el.scrollTop + el.clientHeight / 2) / Math.max(el.scrollHeight, 1);
    setScale(value);
    requestAnimationFrame(() => el.scrollTo(x * el.scrollWidth - el.clientWidth / 2, y * el.scrollHeight - el.clientHeight / 2));
  }
  return <div className="image-lightbox course-image-viewer" role="dialog" aria-modal="true" aria-label="查看课程插图" onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <header className="course-zoom-tools">
      <button type="button" onClick={close} aria-label="关闭图片" className="course-zoom-close"><X size={20}/></button>
      <button type="button" disabled={!previous || failed} onClick={() => zoom(previous!)} aria-label="缩小图片"><Minus size={16}/></button>
      <span aria-live="polite">{Math.round(current * 100)}%</span>
      <button type="button" disabled={!next || failed} onClick={() => zoom(next!)} aria-label="放大图片"><Plus size={16}/></button>
      <button type="button" disabled={failed} onClick={() => zoom(null)}><Maximize size={14}/>适合屏幕</button>
    </header>
    <div ref={view} className={`course-zoom-window${current > fit + .01 ? ' can-pan' : ''}`} tabIndex={0} role="region" aria-label="插图，可滚动查看放大的内容"
      onPointerDown={event => {
        if (event.pointerType !== 'mouse' || event.button !== 0 || current <= fit + .01) return;
        const el = event.currentTarget; drag.current = { x: event.clientX, y: event.clientY, left: el.scrollLeft, top: el.scrollTop };
        el.setPointerCapture(event.pointerId); event.preventDefault();
      }}
      onPointerMove={event => { const pointer = drag.current; if (pointer) event.currentTarget.scrollTo(pointer.left + pointer.x - event.clientX, pointer.top + pointer.y - event.clientY); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
      onDoubleClick={() => zoom(scale === null ? Math.max(1, fit * 2) : null)}>
      <div className="course-zoom-canvas" onClick={event => { if (event.target === event.currentTarget) close(); }}>
        {failed ? <p role="alert">原图加载失败。{block.alt}</p> : <img src={block.src} alt={block.alt || block.caption || '课程插图'} draggable={false}
          style={intrinsic.width && viewport.width ? { width: Math.round(current * intrinsic.width), height: Math.round(current * intrinsic.height) } : undefined}
          onLoad={event => setIntrinsic({ width: block.width || event.currentTarget.naturalWidth, height: block.height || event.currentTarget.naturalHeight })} onError={() => setFailed(true)}/>}
      </div>
    </div>
    <p className="course-zoom-caption">{block.caption}</p>
  </div>;
}
