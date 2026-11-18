'use client';

import { useRef } from 'react';
import { ChevronRight, Terminal, X } from 'lucide-react';
import type { CourseBlock } from '@/lib/course-types';
import './sample-output.css';

export function SampleOutput({ block }: { block: CourseBlock }) {
  const dialog = useRef<HTMLDialogElement>(null);
  return <div className="block-item sample-output-link" data-block-id={block.id}>
    <button type="button" className="sample-output-trigger" aria-haspopup="dialog" onClick={() => dialog.current?.showModal()}>
      <Terminal size={15} aria-hidden="true" /><span>查看课程示例输出</span><ChevronRight size={15} aria-hidden="true" />
    </button>
    <dialog ref={dialog} className="sample-output-dialog" aria-label="课程示例输出" onClick={event => {
      if (event.target === event.currentTarget) event.currentTarget.close();
    }}>
      <section><header><h2>课程示例输出</h2><button aria-label="关闭示例输出" type="button" onClick={() => dialog.current?.close()}><X size={18}/></button></header>
        <pre tabIndex={0}>{block.code ?? block.text}</pre>
      </section>
    </dialog>
  </div>;
}
