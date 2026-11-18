/** Keep the address bar aligned with the logical reading anchor, not a page number. */
export function readingLocationUrl(href: string, chapterId: string, anchor: string) {
  const url = new URL(href);
  url.searchParams.set('chapter', chapterId);
  url.hash = anchor === '__last__' ? '' : anchor;
  return url;
}

export function readingAnchor(hash: string): string {
  const fragment = hash.replace(/^#/, '');
  try { return decodeURIComponent(fragment); }
  catch { return fragment; }
}
