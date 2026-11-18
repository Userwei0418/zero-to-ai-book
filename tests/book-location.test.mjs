import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readingLocationUrl } from '../lib/book-location.ts';
import { resolvePageLocation } from '../components/book-pagination.ts';

test('turning from a search result replaces its old URL anchor for a subsequent refresh', () => {
  const searched = 'https://book.example/?chapter=upper-01&display=book#search-match::12';
  const next = readingLocationUrl(searched, 'upper-01', 'following-paragraph::203');
  assert.equal(next.hash, '#following-paragraph::203');
  assert.equal(next.searchParams.get('chapter'), 'upper-01');
  assert.equal(next.searchParams.get('display'), 'book');
  const reopened = new URL(next.href);
  const pages = [[{ anchor: 'beginning', block: { id: 'beginning' } }], [{ anchor: 'following-paragraph::0', block: { id: 'following-paragraph' } }], [{ anchor: 'following-paragraph::203', block: { id: 'following-paragraph' } }]];
  assert.equal(resolvePageLocation(pages, decodeURIComponent(reopened.hash.slice(1)), 1).page, 2);
});

test('reflow keeps the same logical URL anchor and returning restores the saved location', () => {
  const previous = { chapterId: 'upper-01', anchor: 'paragraph::203' };
  const saved = { ...previous };
  let url = readingLocationUrl('https://book.example/', previous.chapterId, previous.anchor);
  const pages = [[{ anchor: 'paragraph', block: { id: 'paragraph' } }], [{ anchor: 'paragraph::150', block: { id: 'paragraph' } }], [{ anchor: 'paragraph::300', block: { id: 'paragraph' } }]];
  const reflow = resolvePageLocation(pages, previous.anchor, 2);
  url = readingLocationUrl(url.href, previous.chapterId, reflow.anchor);
  assert.equal(url.hash, '#paragraph::203', 'reflow must not replace the anchor with the spread start');
  url = readingLocationUrl(url.href, 'lower-02', 'new-chapter');
  url = readingLocationUrl(url.href, saved.chapterId, saved.anchor);
  assert.deepEqual(previous, saved, 'URL replacement must not mutate the return location');
  assert.equal(url.searchParams.get('chapter'), 'upper-01');
  assert.equal(url.hash, '#paragraph::203');
});
