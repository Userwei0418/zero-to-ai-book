import { isSampleOutput } from '../lib/sample-output.ts';
import type { CourseBlock } from '@/lib/course-types';

export type PageFragment = { block: CourseBlock; html?: string; anchor: string; continued?: boolean; height: number };
export type BookPage = PageFragment[];
export const PAGE_BLOCK_GAP = 14;

/** The browser supplies actual typeset heights; the packing policy is independently testable. */
export type MeasuredBlock = {
  block: CourseBlock;
  text: string;
  lineHeight: number;
  measure: (start: number, end: number) => number;
  slice: (start: number, end: number) => string;
  breaks?: number[];
  /** Table row ends are mandatory unless a single row exceeds an entire page. */
  hardBreaks?: number[];
  atomic?: { preferred: number; minimum: number };
};

function safeTextEnd(text: string, offset: number) {
  if (offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset])) return offset - 1;
  return offset;
}

export function paginateMeasuredBlocks(items: MeasuredBlock[], contentHeight: number): BookPage[] {
  const pages: BookPage[] = [];
  let current: BookPage = [];
  let used = 0;
  const pageHeight = Math.max(120, Math.floor(contentHeight) - 2);
  const space = () => pageHeight - used - (current.length ? PAGE_BLOCK_GAP : 0);
  const flush = () => { if (current.length) pages.push(current); current = []; used = 0; };
  const place = (item: MeasuredBlock, start: number, end: number, height: number) => {
    used += (current.length ? PAGE_BLOCK_GAP : 0) + height;
    current.push({ block: item.block, html: item.atomic ? undefined : item.slice(start, end), anchor: start ? `${item.block.id}::${start}` : item.block.id, continued: start > 0, height });
  };
  const minimumStart = (item: MeasuredBlock) => item.atomic?.minimum ?? (item.hardBreaks?.length ? Math.min(pageHeight, item.measure(0, item.hardBreaks[0])) : Math.min(item.measure(0, item.text.length), item.measure(0, Math.min(1, item.text.length)) + item.lineHeight));

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (item.block.type === 'heading') {
      // Keep a heading with two lines of its following paragraph, or the next media card.
      let together = item.measure(0, item.text.length);
      for (let next = index + 1; next < items.length; next++) {
        together += PAGE_BLOCK_GAP + (items[next].block.type === 'heading' ? items[next].measure(0, items[next].text.length) : minimumStart(items[next]));
        if (items[next].block.type !== 'heading') break;
      }
      if (current.length && together <= pageHeight && together > space()) flush();
    }

    if (item.atomic) {
      const preferred = Math.min(pageHeight, item.atomic.preferred);
      const minimum = Math.min(preferred, item.atomic.minimum);
      if (current.length && space() < minimum) flush();
      place(item, 0, 0, Math.min(preferred, space()));
      continue;
    }

    let start = 0;
    if (!item.text.length) {
      const height = item.measure(0, 0);
      if (current.length && height > space()) flush();
      place(item, 0, 0, height);
      continue;
    }
    while (start < item.text.length) {
      const fullHeight = item.measure(start, item.text.length);
      if (fullHeight <= space()) { place(item, start, item.text.length, fullHeight); break; }
      let splitLimit = item.text.length;
      if (item.hardBreaks?.length) {
        const ends = item.hardBreaks.filter(end => end > start);
        const completeEnd = ends.filter(end => item.measure(start, end) <= space()).at(-1);
        if (completeEnd) {
          place(item, start, completeEnd, item.measure(start, completeEnd));
          start = completeEnd;
          if (start < item.text.length) flush();
          continue;
        }
        // Do not cut a row just to fill a previous page's leftover space.
        if (current.length) { flush(); continue; }
        // Only a row taller than the empty page may continue across pages.
        splitLimit = ends[0] ?? item.text.length;
      }
      const minimum = Math.min(fullHeight, item.measure(start, Math.min(start + 1, item.text.length)) + item.lineHeight);
      if (current.length && space() < minimum) { flush(); continue; }
      let low = start + 1, high = splitLimit, best = start;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (item.measure(start, middle) <= space()) { best = middle; low = middle + 1; }
        else high = middle - 1;
      }
      best = safeTextEnd(item.text, best);
      if (best <= start) {
        if (current.length) { flush(); continue; }
        // Preserve even an unusual unbreakable element rather than dropping its text.
        best = start + (item.text.codePointAt(start)! > 0xffff ? 2 : 1);
      } else {
        const structural = item.breaks?.filter(end => end > start && end <= best).at(-1);
        if (structural && item.measure(start, structural) >= space() - item.lineHeight * 2) best = structural;
        else {
          const tail = item.text.slice(Math.max(start, best - 36), best);
          const boundary = Math.max(...['。', '！', '？', '；', ' ', '\n'].map(mark => tail.lastIndexOf(mark)));
          const natural = best - tail.length + boundary + 1;
          if (boundary >= 0 && natural > start && item.measure(start, natural) >= space() - item.lineHeight) best = natural;
        }
      }
      best = safeTextEnd(item.text, best);
      const height = item.measure(start, best);
      place(item, start, best, height);
      start = best;
      if (start < item.text.length) flush();
    }
  }
  flush();
  return pages.length ? pages : [[]];
}

function escapeHtml(text: string) { return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
function textPoint(root: Node, offset: number, forward = false) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null, remaining = offset;
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length || 0;
    if (remaining < length || (!forward && remaining === length)) return { node, offset: remaining };
    remaining -= length;
  }
  return { node: root, offset: root.childNodes.length };
}

function rangeHtml(root: HTMLElement, from: number, to: number) {
  const range = document.createRange();
  const start = from === 0 ? { node: root as Node, offset: 0 } : textPoint(root, from, true);
  const end = to >= (root.textContent?.length || 0) ? { node: root as Node, offset: root.childNodes.length } : textPoint(root, to);
  range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
  const result = document.createElement('div'); result.appendChild(range.cloneContents());
  // A Range inside one paragraph otherwise returns bare text and loses its wrappers.
  let ancestor = range.commonAncestorContainer;
  if (ancestor.nodeType === Node.TEXT_NODE) ancestor = ancestor.parentNode!;
  while (ancestor !== root && root.contains(ancestor)) {
    const wrapper = ancestor.cloneNode(false);
    while (result.firstChild) wrapper.appendChild(result.firstChild);
    result.replaceChildren(wrapper);
    ancestor = ancestor.parentNode!;
  }
  result.querySelectorAll<HTMLTableElement>('table[data-page-table]').forEach(table => {
    const original = root.querySelector<HTMLTableElement>(`table[data-page-table="${table.dataset.pageTable}"]`);
    const columns = original?.querySelector('colgroup[data-page-columns]');
    if (columns && !table.querySelector('colgroup')) table.insertBefore(columns.cloneNode(true), table.firstChild);
    table.querySelectorAll<HTMLTableRowElement>('tr[data-page-row]').forEach(row => {
      const originalRow = original?.querySelector<HTMLTableRowElement>(`tr[data-page-row="${row.dataset.pageRow}"]`);
      if (!originalRow) return;
      // A continued cell must remain in its original column. Empty cells preserve
      // the row grid without repeating any source text or header labels.
      Array.from(originalRow.cells).forEach((cell, index) => {
        if (Array.from(row.cells).some(candidate => candidate.dataset.pageCell === String(index))) return;
        const empty = cell.cloneNode(false) as HTMLTableCellElement;
        empty.setAttribute('aria-hidden', 'true');
        const following = Array.from(row.cells).find(candidate => Number(candidate.dataset.pageCell) > index);
        row.insertBefore(empty, following || null);
      });
    });
  });
  // Preserve list numbering; a split list item must not get a second bullet.
  result.querySelectorAll<HTMLElement>('li[data-page-start]').forEach(li => {
    if (Number(li.dataset.pageStart) < from) li.classList.add('continued-list-item');
    li.removeAttribute('data-page-start');
  });
  result.querySelectorAll<HTMLElement>('[data-page-table],[data-page-row],[data-page-cell],[data-page-columns]').forEach(element => {
    ['data-page-table', 'data-page-row', 'data-page-cell', 'data-page-columns'].forEach(attribute => element.removeAttribute(attribute));
  });
  return result.innerHTML;
}

export function paginateChapter(blocks: CourseBlock[], measure: HTMLDivElement, contentHeight: number, predictionMeasure: HTMLDivElement): BookPage[] {
  const fontSize = Number.parseFloat(getComputedStyle(measure).fontSize) || 18;
  const width = measure.getBoundingClientRect().width;
  const pageHeight = Math.max(120, contentHeight - 2);
  // Use the same parent/child cascade as the visible page, including callout font size.
  measure.className = 'pagination-measure paper-content';
  const probe = document.createElement('div'); measure.replaceChildren(probe);
  const predictionHeights = new Map(Array.from(predictionMeasure.querySelectorAll<HTMLElement>('[data-measure-prediction]'), card =>
    [card.dataset.measurePrediction!, Math.ceil(card.getBoundingClientRect().height)] as const));
  const items: MeasuredBlock[] = blocks.map(block => {
    if (block.type === 'prediction') {
      const preferred = Math.min(pageHeight, predictionHeights.get(block.id) ?? pageHeight);
      return { block, text: '', lineHeight: fontSize * 1.9, measure: () => preferred, slice: () => '', atomic: { preferred, minimum: preferred } };
    }
    if (block.type === 'code' || block.type === 'image' || block.type === 'video') {
      const lines = (block.code || '').split('\n').length;
      const caption = block.caption ? 38 : 0;
      const ratio = block.width && block.height ? block.width / block.height : block.type === 'video' ? 16 / 9 : 4 / 3;
      // Leave a readable output line even alongside an edited/history notice and the editor.
      // The reference toggle has a separate, one-line footprint.
      const codeHeight = isSampleOutput(block) ? 38 : block.runnable
        ? Math.max(198, 102 + Math.min(lines, 7) * 21)
        : 31 + Math.min(140, Math.max(65, lines * 21 + 16)) + 42 + 23;
      const preferred = block.type === 'code' ? Math.min(pageHeight, codeHeight)
        : Math.min(pageHeight * .72, width / ratio + caption + (block.type === 'video' ? 22 : 0));
      const minimum = block.type === 'code' ? Math.min(preferred, block.runnable ? 198 : 155) : Math.min(preferred, block.type === 'video' ? 180 : 150);
      return { block, text: '', lineHeight: fontSize * 1.9, measure: () => preferred, slice: () => '', atomic: { preferred, minimum } };
    }
    const html = block.html || (block.type === 'heading' ? `<h${Math.min(block.level || 2, 4)}>${escapeHtml(block.text || '')}</h${Math.min(block.level || 2, 4)}>` : `<p>${escapeHtml(block.text || '')}</p>`);
    const source = document.createElement('div'); source.innerHTML = html;
    const text = source.textContent || '';
    const breaks: number[] = [];
    const offsetAt = (element: Element, after: boolean) => {
      const range = document.createRange(); range.selectNodeContents(source);
      if (after) range.setEndAfter(element); else range.setEndBefore(element);
      return range.toString().length;
    };
    source.querySelectorAll('p,li,tr,blockquote').forEach(element => breaks.push(offsetAt(element, true)));
    source.querySelectorAll<HTMLOListElement>('ol').forEach(list => {
      let ordinal = list.hasAttribute('start') ? list.start : list.reversed ? list.children.length : 1;
      Array.from(list.children).forEach(child => {
        if (child.tagName !== 'LI') return;
        const li = child as HTMLLIElement;
        if (li.hasAttribute('value')) ordinal = li.value;
        li.value = ordinal; ordinal += list.reversed ? -1 : 1;
      });
    });
    source.querySelectorAll<HTMLElement>('li').forEach(li => { li.dataset.pageStart = String(offsetAt(li, false)); });
    let hardBreaks: number[] | undefined;
    const sourceTables = source.querySelectorAll<HTMLTableElement>('table');
    if (sourceTables.length) {
      probe.className = `block-item prose block-${block.type}`;
      probe.innerHTML = source.innerHTML;
      const renderedTables = probe.querySelectorAll<HTMLTableElement>('table');
      sourceTables.forEach((table, tableIndex) => {
        table.dataset.pageTable = String(tableIndex);
        const rendered = renderedTables[tableIndex];
        const columnCount = Math.max(...Array.from(table.rows).map(row => Array.from(row.cells).reduce((count, cell) => count + cell.colSpan, 0)));
        const sample = Array.from(rendered.rows).find(row => row.cells.length === columnCount);
        if (sample) {
          const columns = document.createElement('colgroup'); columns.dataset.pageColumns = 'true';
          Array.from(sample.cells).forEach(cell => {
            const column = document.createElement('col'); column.style.width = `${cell.getBoundingClientRect().width}px`; columns.appendChild(column);
          });
          table.insertBefore(columns, table.firstChild);
        }
        Array.from(table.rows).forEach((row, rowIndex) => {
          row.dataset.pageRow = String(rowIndex);
          Array.from(row.cells).forEach((cell, cellIndex) => { cell.dataset.pageCell = String(cellIndex); });
        });
      });
      if (source.children.length === 1 && source.firstElementChild?.tagName === 'TABLE') {
        const table = sourceTables[0];
        const rows = Array.from(table.rows);
        // Keep the header with its first data row; whitespace after the last row
        // belongs to that fragment rather than becoming a separate blank page.
        hardBreaks = rows.filter(row => row.parentElement?.tagName !== 'THEAD').map(row => offsetAt(row, true));
        if (!hardBreaks.length) hardBreaks = rows.map(row => offsetAt(row, true));
        if (hardBreaks.length) hardBreaks[hardBreaks.length - 1] = text.length;
      }
    }
    const slices = new Map<string, string>();
    const heights = new Map<string, number>();
    const slice = (start: number, end: number) => {
      const key = `${start}:${end}`;
      if (!slices.has(key)) slices.set(key, rangeHtml(source, start, end));
      return slices.get(key)!;
    };
    const measurePart = (start: number, end: number) => {
      const key = `${start}:${end}`;
      if (!heights.has(key)) {
        probe.className = `block-item prose block-${block.type}`;
        probe.innerHTML = slice(start, end);
        heights.set(key, Math.ceil(probe.getBoundingClientRect().height));
      }
      return heights.get(key)!;
    };
    return { block, text, lineHeight: fontSize * 1.9, breaks: breaks.sort((a, b) => a - b), hardBreaks, measure: measurePart, slice };
  });
  const pages = paginateMeasuredBlocks(items, contentHeight);
  measure.replaceChildren();
  return pages;
}

export function findAnchorPage(pages: BookPage[], anchor?: string) {
  if (!anchor) return 0;
  const exact = pages.findIndex(page => page.some(fragment => fragment.anchor === anchor));
  if (exact >= 0) return exact;
  const [block, offsetRaw] = anchor.split('::'); const offset = Number(offsetRaw || 0);
  let result = 0, nearest = -1;
  pages.forEach((page, pageIndex) => page.forEach(fragment => {
    if (fragment.block.id !== block) return;
    const partOffset = Number(fragment.anchor.split('::')[1] || 0);
    if (partOffset <= offset && partOffset > nearest) { result = pageIndex; nearest = partOffset; }
  }));
  return result;
}

export function resolvePageLocation(pages: BookPage[], anchor: string | undefined, step: number) {
  const found = anchor === '__last__' ? Math.max(0, pages.length - 1) : findAnchorPage(pages, anchor);
  const page = Math.floor(found / Math.max(1, step)) * Math.max(1, step);
  const exists = anchor && anchor !== '__last__' && pages.some(items => items.some(fragment => fragment.block.id === anchor.split('::')[0]));
  return { page, anchor: exists ? anchor : pages[page]?.[0]?.anchor || '' };
}
