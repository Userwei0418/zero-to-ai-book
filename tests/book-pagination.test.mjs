import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paginateMeasuredBlocks, findAnchorPage, resolvePageLocation, PAGE_BLOCK_GAP } from '../components/book-pagination.ts';

// These exercise packing/offset contracts with deterministic line metrics.
// Actual font, HTML, and responsive rendering are checked in the browser acceptance pass.
const prose = (id, text, chars = 20, line = 20, type = 'prose') => ({
  block: { id, type }, text, lineHeight: line,
  measure: (start, end) => Math.ceil(Array.from(text.slice(start, end)).length / chars) * line,
  slice: (start, end) => text.slice(start, end),
});
const atomic = (id, type, preferred, minimum) => ({
  block: { id, type }, text: '', lineHeight: 20,
  measure: () => preferred, slice: () => '', atomic: { preferred, minimum },
});
const used = page => page.reduce((height, fragment) => height + fragment.height, 0) + Math.max(0, page.length - 1) * PAGE_BLOCK_GAP;

test('a paragraph shorter than a page uses remaining space instead of moving wholesale', () => {
  const items = [prose('first', '甲'.repeat(180)), prose('second', '乙'.repeat(200)), prose('third', '丙'.repeat(100))];
  const pages = paginateMeasuredBlocks(items, 302);
  assert.deepEqual(pages[0].map(item => item.block.id), ['first', 'second']);
  assert.ok(pages[0][1].html.length > 0 && pages[0][1].html.length < 200);
  assert.ok(used(pages[0]) >= 280, 'first page is filled to within one line');
  assert.equal(pages.flat().map(item => item.html).join(''), items.map(item => item.text).join(''));
});

test('heading stays with at least two following lines', () => {
  const pages = paginateMeasuredBlocks([
    prose('opening', '甲'.repeat(240)),
    prose('title', '下一节', 20, 35, 'heading'),
    prose('body', '乙'.repeat(100)),
  ], 302);
  assert.deepEqual(pages[0].map(item => item.block.id), ['opening']);
  assert.deepEqual(pages[1].map(item => item.block.id), ['title', 'body']);
  assert.ok(pages[1][1].height >= 40);
});

test('media uses available height without an unnecessary page break', () => {
  const pages = paginateMeasuredBlocks([prose('lead', '甲'.repeat(100)), atomic('image', 'image', 250, 150)], 302);
  assert.equal(pages.length, 1);
  assert.equal(pages[0][1].height, 186);
  assert.equal(used(pages[0]), 300);
});

test('media below its readable minimum moves together to the next page', () => {
  const pages = paginateMeasuredBlocks([prose('lead', '甲'.repeat(180)), atomic('video', 'video', 250, 180)], 302);
  assert.equal(pages.length, 2);
  assert.equal(pages[1][0].height, 250);
});

test('character offsets survive narrow pages, font changes, and emoji at a boundary', () => {
  const text = '中文，English words。👩‍💻🚀 阅读测试！'.repeat(100);
  const original = [prose('long', text, 24, 20), prose('tail', '结尾'.repeat(70), 24, 20)];
  const wide = paginateMeasuredBlocks(original, 502);
  for (const [chars, line, height] of [[12, 28, 282], [19, 34, 450], [38, 18, 682]]) {
    const items = original.map(item => prose(item.block.id, item.text, chars, line));
    const pages = paginateMeasuredBlocks(items, height);
    assert.equal(pages.flat().map(item => item.html).join(''), original.map(item => item.text).join(''));
    assert.ok(pages.every(page => used(page) <= height - 2));
    for (const fragment of pages.flat()) {
      assert.doesNotMatch(fragment.html, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u, 'no UTF-16 surrogate is split');
      const offset = Number(fragment.anchor.split('::')[1] || 0);
      assert.equal(items.find(item => item.block.id === fragment.block.id).text.slice(offset, offset + fragment.html.length), fragment.html);
    }
    for (const previous of wide.flat()) {
      const page = pages[findAnchorPage(pages, previous.anchor)];
      const offset = Number(previous.anchor.split('::')[1] || 0);
      assert.ok(page.some(fragment => fragment.block.id === previous.block.id && Number(fragment.anchor.split('::')[1] || 0) <= offset));
    }
  }
});

test('mixed content retains source order and accounts for margins only between blocks', () => {
  const items = [prose('a', '甲'.repeat(150)), atomic('code', 'code', 282, 214), prose('b', '乙'.repeat(350)), atomic('image', 'image', 230, 150), prose('c', '丙'.repeat(100))];
  const pages = paginateMeasuredBlocks(items, 402);
  const ids = pages.flat().map(item => item.block.id).filter((id, index, all) => index === 0 || id !== all[index - 1]);
  assert.deepEqual(ids, items.map(item => item.block.id));
  assert.ok(pages.every(page => used(page) <= 400));
  assert.deepEqual(paginateMeasuredBlocks([], 402), [[]]);
});

test('repeated font increases and decreases retain the exact reading anchor', () => {
  const text = '甲'.repeat(16000);
  const pagesAt = font => paginateMeasuredBlocks([prose('long', text, Math.floor(420 / font), font * 1.9)], 500);
  const initialAnchor = pagesAt(18)[10][0].anchor;
  let anchor = initialAnchor;
  for (const font of [19, 20, 21, 22, 23, 24, 23, 22, 21, 20, 19, 18]) {
    const pages = pagesAt(font);
    const location = resolvePageLocation(pages, anchor, 2);
    const containingPage = findAnchorPage(pages, initialAnchor);
    assert.equal(location.anchor, initialAnchor, `font ${font} must not save the earlier spread boundary`);
    assert.ok(containingPage >= location.page && containingPage < location.page + 2);
    anchor = location.anchor;
  }
  const finalPages = pagesAt(18);
  assert.equal(resolvePageLocation(finalPages, anchor, 2).page, 10);
});

test('empty and end-of-chapter destinations receive a usable reading anchor', () => {
  const pages = paginateMeasuredBlocks([prose('long', '甲'.repeat(2000))], 302);
  const beginning = resolvePageLocation(pages, '', 2);
  assert.deepEqual(beginning, { page: 0, anchor: pages[0][0].anchor });
  const last = resolvePageLocation(pages, '__last__', 2);
  assert.equal(last.page, Math.floor((pages.length - 1) / 2) * 2);
  assert.equal(last.anchor, pages[last.page][0].anchor);
});

test('table fragments break only between complete rows when each row fits a page', () => {
  const text = '行'.repeat(400);
  const boundaries = [80, 160, 240, 320, 400];
  const table = { ...prose('table', text, 10, 20), breaks: boundaries, hardBreaks: boundaries };
  // The first page has room for one row and part of the next. The second row must
  // remain intact even though accepting it partially would fill more of the page.
  const pages = paginateMeasuredBlocks([prose('lead', '引言'), table], 302);
  const fragments = pages.flat().filter(fragment => fragment.block.id === 'table');
  assert.equal(fragments[0].html.length, 80);
  assert.equal(fragments.map(fragment => fragment.html).join(''), text);
  for (const fragment of fragments) {
    const start = Number(fragment.anchor.split('::')[1] || 0);
    assert.equal(start % 80, 0, 'a continuation starts at the beginning of a table row');
    assert.ok(boundaries.includes(start + fragment.html.length), 'a fragment ends at a row boundary');
  }
  assert.ok(pages.every(page => used(page) <= 300));
});

test('a table row taller than a complete page still makes progress without losing text', () => {
  const text = '长'.repeat(700);
  const table = { ...prose('tall-table', text, 10, 20), breaks: [500, 700], hardBreaks: [500, 700] };
  const pages = paginateMeasuredBlocks([table], 302);
  const fragments = pages.flat();
  assert.ok(pages.length > 1);
  assert.equal(fragments.map(fragment => fragment.html).join(''), text);
  assert.ok(fragments.every(fragment => fragment.html.length > 0));
  assert.ok(pages.every(page => used(page) <= 300));
  for (const fragment of fragments) {
    const start = Number(fragment.anchor.split('::')[1] || 0);
    assert.equal(text.slice(start, start + fragment.html.length), fragment.html);
  }
});
