'use client';

import { createPortal } from 'react-dom';
import { useMemo, useRef, useSyncExternalStore } from 'react';
import { ArrowUpRight, Check, ChevronRight, Expand, FlaskConical, Play, Square, X } from 'lucide-react';
import type { CourseBlock, CoursePrediction } from '@/lib/course-types';
import { getNotebookKernel } from '@/lib/notebook-runtime';
import { comparePrediction, type PredictionComparison } from '@/lib/course-predictions';
import './prediction-card.css';

type FrameProps = {
  exercise: CoursePrediction;
  id?: string;
  measureId?: string;
  choice?: string;
  comparison?: PredictionComparison;
  running?: boolean;
  disabled?: boolean;
  unavailable?: string;
  saveLabel?: string;
  maxHeight?: number;
  onChange?: (value: string) => void;
  onRun?: () => void;
  onDetail?: () => void;
};

// The offscreen copy and the live card have identical typography, wrapping and controls.
// Result details occupy a native dialog so a run never pushes the next paragraph off the page.
function PredictionFrame({ exercise, id, measureId, choice, comparison, running, disabled, unavailable, saveLabel, maxHeight, onChange, onRun, onDetail }: FrameProps) {
  const showResult = comparison && !['waiting', 'running'].includes(comparison.kind);
  return <section className={`block-item prediction-frame ${id ? 'prediction-card' : 'prediction-sizer'}`} data-block-id={id} data-measure-prediction={measureId} style={maxHeight ? { maxHeight } : undefined} aria-label="实验预测">
    <header>
      <span className={`prediction-badge is-${comparison?.kind ?? 'waiting'}`} role={id ? 'status' : undefined} title={choice && !showResult ? saveLabel : undefined}><FlaskConical size={13}/><span>{comparison?.badge ?? '先猜一猜'}</span></span>
      <button className="prediction-detail" type="button" onClick={onDetail} aria-label={showResult ? '查看预测对照与独立挑战' : '展开对应实验'}>{showResult ? '看对照' : '看代码'}<ChevronRight size={12}/></button>
    </header>
    <fieldset>
      <legend>{exercise.question}</legend>
      <div className="prediction-controls">
        <div className="prediction-choices">{exercise.options.map(option => <label key={option.value} className={choice === option.value ? 'selected' : ''}>
          <input type="radio" name={id} value={option.value} checked={choice === option.value} onChange={() => onChange?.(option.value)} aria-label={option.label}/>
          <span>{option.label}</span>{choice === option.value && <Check className="prediction-check" size={11} aria-hidden="true"/>}
        </label>)}</div>
        <button type="button" className="prediction-run" title={unavailable} disabled={disabled} onClick={onRun}>
          {running ? <Square size={11}/> : <Play size={11}/>}<span>{running ? '停止' : '运行验证'}</span>
        </button>
      </div>
    </fieldset>
  </section>;
}

export function PredictionMeasures({ blocks }: { blocks: CourseBlock[] }) {
  return blocks.map(block => block.prediction ? <PredictionFrame key={block.id} measureId={block.id} exercise={block.prediction}/> : null);
}

export function PredictionCard({ id, exercise, block, code, choice, onChange, onExpand, chapterId, cacheScope, height, saveLabel }: {
  id: string; exercise: CoursePrediction; block: CourseBlock; code: string; choice: string;
  onChange: (choice: string) => void; onExpand: () => void; chapterId: string; cacheScope?: string; height?: number; saveLabel: string;
}) {
  const kernel = useMemo(() => getNotebookKernel(chapterId, cacheScope), [chapterId, cacheScope]);
  const state = useSyncExternalStore(kernel.subscribe, kernel.getSnapshot, kernel.getSnapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  const busy = Boolean(state.activeCell || state.batch);
  const running = state.activeCell === exercise.cellId;
  const result = state.results[exercise.cellId];
  const comparison = comparePrediction(exercise, choice, code, result);
  const showResult = !['waiting', 'running'].includes(comparison.kind);
  const unavailable = kernel.unavailableReason(block);
  return <>
    <PredictionFrame {...{ id, exercise, choice, comparison, running, unavailable, saveLabel, onChange }} maxHeight={height} disabled={(busy && !running) || Boolean(unavailable)}
      onRun={running ? () => kernel.stop() : () => void kernel.execute({ block, value: code })}
      onDetail={showResult ? () => dialog.current?.showModal() : onExpand}/>
    {typeof document !== 'undefined' && createPortal(<dialog ref={dialog} className="prediction-comparison-dialog" aria-labelledby={`${id}-detail-title`} onKeyDown={event => event.stopPropagation()} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div className="prediction-dialog-inner">
        <header><span className="prediction-dialog-kicker"><FlaskConical size={14}/>实验对照</span><button aria-label="关闭对照" type="button" onClick={() => dialog.current?.close()}><X size={18}/></button></header>
        <h2 id={`${id}-detail-title`}>{exercise.question}</h2>
        <p className="prediction-dialog-summary" role="status">{comparison.message}</p>
        {comparison.kind === 'actual' && <><h3>为什么会这样？</h3><p>{exercise.reflect}</p><h3>自己改一次</h3><p>{exercise.challenge}</p></>}
        <button className="prediction-open-code" type="button" onClick={() => { dialog.current?.close(); onExpand(); }}>打开代码与完整输出<ArrowUpRight size={14}/></button>
      </div>
    </dialog>, document.body)}
  </>;
}

export function PredictionReview({ blockId, code, chapterId, cacheScope, onExpand }: { blockId: string; code: string; chapterId: string; cacheScope?: string; onExpand: () => void }) {
  const kernel = useMemo(() => getNotebookKernel(chapterId, cacheScope), [chapterId, cacheScope]);
  const state = useSyncExternalStore(kernel.subscribe, kernel.getSnapshot, kernel.getSnapshot);
  const result = state.results[blockId];
  if (!result) return null;
  const stale = result.code !== code || result.inputsChanged;
  const label = result.status === 'running' ? '正在执行' : result.historical ? '历史结果，变量尚未恢复' : stale ? '修改前的结果，请重新运行' : result.status === 'ok' ? '本次真实运行结果' : result.status === 'interrupted' ? '执行已中断' : '本次真实报错';
  const text = [result.stdout, result.stderr, result.error].filter(Boolean).join('\n');
  return <section className="prediction-review" aria-label="预测与运行结果对照"><strong>{label}</strong>{text ? <pre>{text.slice(0, 1200)}{text.length > 1200 ? '\n…完整输出见实验区' : ''}</pre> : <p>{result.status === 'running' ? '等待运行输出…' : result.images.length ? `已生成 ${result.images.length} 张图像，请展开查看。` : '没有文本输出，请展开查看完整结果。'}</p>}<button type="button" onClick={onExpand}>展开代码与完整结果 <Expand size={12}/></button></section>;
}
