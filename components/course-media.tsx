'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Captions, Expand, ImageOff, LoaderCircle, Play, RotateCcw, Volume2 } from 'lucide-react';
import type { CourseBlock } from '@/lib/course-types';
import { VideoReading } from './course-media-reading';
import './course-media.css';

function mediaStyle(block: CourseBlock, fallback: number, height?: number): CSSProperties {
  const ratio = block.width && block.height && block.width > 0 && block.height > 0 ? block.width / block.height : fallback;
  return { '--media-ratio': ratio, ...(height && height > 0 ? { height, '--media-height': `${height}px` } : {}) } as CSSProperties;
}

function clock(seconds: number) {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

export function CourseImage({ block, onOpen, priority = false, height }: {
  block: CourseBlock;
  onOpen: (block: CourseBlock) => void;
  priority?: boolean;
  height?: number;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [fullFallback, setFullFallback] = useState(false);
  const [retry, setRetry] = useState(0);
  const image = useRef<HTMLImageElement>(null);
  const source = fullFallback ? block.src : block.previewSrc || block.src;
  const label = block.alt || block.caption || '课程插图';
  useEffect(() => {
    setFailed(false); setFullFallback(false);
    setLoaded(Boolean(image.current?.complete && image.current.naturalWidth));
  }, [block.id, block.src, block.previewSrc]);
  const unavailable = block.available === false || !source;
  return <figure className={`block-item course-media course-media-image${height ? ' is-sized' : ''}`} data-block-id={block.id} style={mediaStyle(block, 3 / 2, height)}>
    {unavailable || failed ? <div className="course-media-frame course-media-placeholder" role="status">
      <ImageOff size={24} aria-hidden="true"/><span>{unavailable ? '这张插图暂时无法显示' : '插图加载失败'}</span>
      {failed && <button type="button" className="course-media-retry" onClick={() => { setFailed(false); setLoaded(false); setFullFallback(false); setRetry(value => value + 1); }}><RotateCcw size={13}/>重新加载</button>}
    </div> : <button type="button" className="course-media-frame course-media-image-button" onClick={() => onOpen(block)} aria-label={`放大图片：${label}`} aria-busy={!loaded}>
      <img key={`${source}:${retry}`} ref={image} src={source} srcSet={fullFallback ? undefined : block.srcSet}
        sizes="(max-width: 620px) calc(100vw - 68px), (max-width: 899px) calc(100vw - 130px), (max-width: 1370px) calc((100vw - 276px) / 2), 570px"
        width={block.width || block.previewWidth} height={block.height || block.previewHeight} alt={label}
        loading="eager" decoding="async" fetchPriority={priority ? 'high' : 'auto'}
        onLoad={() => { setLoaded(true); setFailed(false); }}
        onError={() => { if (!fullFallback && block.src && source !== block.src) { setFullFallback(true); setLoaded(false); } else setFailed(true); }}/>
      {!loaded && <span className="course-media-loading" aria-hidden="true"><LoaderCircle className="spin" size={18}/></span>}
      <span className="course-media-expand" aria-hidden="true"><Expand size={14}/></span>
    </button>}
    {block.caption && <figcaption title={block.caption}>{block.caption}</figcaption>}
  </figure>;
}

export function CourseVideo({ block, time, saveTime, height }: {
  block: CourseBlock;
  time: number;
  saveTime: (time: number) => void;
  height?: number;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const startAt = useRef<number | null>(null);
  const [reading, setReading] = useState(false);
  const saveRef = useRef(saveTime); saveRef.current = saveTime;
  const timeRef = useRef(time); timeRef.current = time;
  const lastSaved = useRef(time);
  const restoring = useRef(false);
  const disposing = useRef(false);
  const [activated, setActivated] = useState(false);
  const [error, setError] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [posterError, setPosterError] = useState(false);
  const [rate, setRate] = useState(1);
  const [retry, setRetry] = useState(0);
  const unavailable = block.available === false || !block.src;

  useEffect(() => {
    setActivated(false); setError(false); setWaiting(false); setPosterError(false); setReading(false); startAt.current = null;
    lastSaved.current = timeRef.current;
  }, [block.id, block.src]);

  useEffect(() => {
    const video = videoRef.current;
    disposing.current = false;
    return () => {
      disposing.current = true;
      if (!video) return;
      if (video.readyState >= 1 && Number.isFinite(video.currentTime)) saveRef.current(video.currentTime);
      video.pause();
      // Release both playback and in-flight media transfers when leaving a page.
      video.removeAttribute('src');
      video.load();
    };
  }, [activated, retry, block.src]);

  function savePosition(video: HTMLVideoElement, force = false) {
    if (disposing.current || restoring.current || video.readyState < 1 || !Number.isFinite(video.currentTime)) return;
    if (force || Math.abs(video.currentTime - lastSaved.current) >= 5) {
      lastSaved.current = video.currentTime;
      saveRef.current(video.currentTime);
    }
  }

  return <figure className={`course-media course-media-video${height ? ' is-sized' : ''}`} style={mediaStyle(block, 16 / 9, height)}>
    {unavailable ? <div className="course-media-frame course-media-placeholder">
      <Volume2 size={25} aria-hidden="true"/><strong>这段视频暂时无法播放</strong>
      {block.readingAlternative && <button type="button" className="course-media-text-link" onClick={() => setReading(true)}>阅读本章讲解</button>}
      <p>{block.reason || '源视频无法读取。可以先继续阅读相邻的课程讲解。'}</p>
    </div> : <>
      <div className="course-media-frame course-media-video-frame">
        {!activated ? <button type="button" className="course-media-video-start" onClick={() => { setActivated(true); setWaiting(true); setError(false); }} aria-label={`播放视频：${block.caption || block.alt || '课程视频'}`}>
          {block.poster && !posterError && <img src={block.poster} alt="" width={block.width || 16} height={block.height || 9} loading="eager" decoding="async" onError={() => setPosterError(true)}/>}
          <span className="course-media-play"><Play size={24} fill="currentColor" aria-hidden="true"/></span>
          <span className="course-media-start-label">{time > 2 ? `继续播放 · ${clock(time)}` : '播放讲解'}</span>
          {typeof block.duration === 'number' && block.duration > 0 && <span className="course-media-duration">{clock(block.duration)}</span>}
        </button> : <video key={`${block.src}:${retry}`} ref={videoRef} src={block.src} poster={block.poster} controls playsInline preload="none" autoPlay
          aria-label={block.caption || block.alt || '课程视频'}
          onLoadedMetadata={event => {
            const video = event.currentTarget;
            restoring.current = true;
            video.playbackRate = rate;
            const position = startAt.current ?? timeRef.current;
            if (position > 0) video.currentTime = Math.min(position, Number.isFinite(video.duration) ? Math.max(0, video.duration - .1) : position);
            startAt.current = null;
            restoring.current = false;
          }}
          onWaiting={() => setWaiting(true)} onCanPlay={() => setWaiting(false)} onPlaying={() => { setWaiting(false); setError(false); }}
          onPlay={event => { document.querySelectorAll('video').forEach(video => { if (video !== event.currentTarget) video.pause(); }); }}
          onTimeUpdate={event => savePosition(event.currentTarget)} onPause={event => savePosition(event.currentTarget, true)}
          onEnded={event => { savePosition(event.currentTarget, true); setWaiting(false); }}
          onError={() => { if (!disposing.current) { setWaiting(false); setError(true); } }}>
          {block.subtitleSrc && <track kind="captions" src={block.subtitleSrc} srcLang="zh-Hans" label="中文字幕"/>}
        </video>
        }
        {activated && waiting && !error && <span className="course-media-loading course-media-video-loading" role="status"><LoaderCircle className="spin" size={20}/><span>正在加载视频…</span></span>}
      </div>
      <div className="course-media-video-options">{(block.subtitleSrc || block.readingAlternative) && <button type="button" className="course-media-text-link" onClick={() => { videoRef.current?.pause(); setReading(true); }}><Captions size={14}/>视频文字稿</button>}<label>倍速 <select aria-label="视频播放速度" value={rate} onChange={event => { const next = Number(event.target.value); setRate(next); if (videoRef.current) videoRef.current.playbackRate = next; }}><option value={.75}>0.75×</option><option value={1}>1×</option><option value={1.25}>1.25×</option><option value={1.5}>1.5×</option><option value={2}>2×</option></select></label></div>
      {error && <div className="course-media-error" role="alert"><span>视频加载失败，请检查连接。</span><button type="button" className="course-media-retry" onClick={() => { setError(false); setWaiting(true); setRetry(value => value + 1); }}><RotateCcw size={12}/>重新加载</button></div>}
    </>}
    {reading && <VideoReading block={block} close={() => setReading(false)} seek={position => {
      setReading(false); const current = videoRef.current;
      if (current && !error && current.readyState >= 1) {
        current.currentTime = position; void current.play().catch(() => {}); return;
      }
      startAt.current = position; setActivated(true); setWaiting(true);
      if (error) { setError(false); setRetry(value => value + 1); }
    }}/>}
    {block.caption && <figcaption title={block.caption}>{block.excerptNotice ? '已恢复片段 · ' : ''}{block.caption}</figcaption>}
  </figure>;
}
