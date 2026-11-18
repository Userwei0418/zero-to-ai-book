"""Verify ordinary reader interactions on the disposable CI site's real HTTPS entry."""
import json
import re
import shutil
import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


ORIGIN = "https://localhost"
GUEST_COOKIE = "__Host-book_guest"
CHROME = shutil.which("google-chrome") or shutil.which("chromium")
# Caddy issues its own runner-local certificate. Scope the exception to loopback.
CHROME_ARGS = ["--allow-insecure-localhost"]
VIEWPORT = {"width": 1280, "height": 900}


def watch_page(context, errors):
    page = context.new_page()
    page.on("pageerror", lambda error: errors.append(str(error)))
    return page


def open_chapter(page, chapter):
    page.goto(f"{ORIGIN}/?chapter={chapter}", wait_until="domcontentloaded")
    expect(page.get_by_role("button", name="添加书签", exact=True)).to_be_visible()
    expect(page.get_by_text("正在整理这一章的书页…")).to_have_count(0)


def records(page):
    page.get_by_role("button", name="学习记录", exact=True).click()
    return page.get_by_role("dialog", name="我的学习记录")


def check_guest_records(page, titles):
    panel = records(page)
    expect(panel.get_by_text("访客记录跟随此浏览器", exact=False)).to_be_visible()
    expect(panel.get_by_text("已保存访客记录", exact=True)).to_be_visible()
    expect(panel.locator(".bookmark-record")).to_have_count(len(titles))
    for title in titles:
        expect(panel.locator(".bookmark-record").get_by_text(title, exact=False)).to_be_visible()
    expect(page.get_by_role("button", name="登录", exact=True)).to_have_count(0)
    panel.get_by_role("button", name="关闭面板").click()


def server_state(page):
    return page.evaluate("""async () => {
      const response = await fetch('/api/state', {cache:'no-store'});
      if (!response.ok) throw Error('State HTTP ' + response.status);
      return response.json();
    }""")


def save_bookmark(page, chapter):
    page.get_by_role("button", name="添加书签", exact=True).click()
    expect(page.get_by_role("button", name="移除书签", exact=True)).to_be_visible()
    expect(page.locator(".save-state")).to_have_text("已保存访客记录")
    saved = server_state(page)
    bookmarks = saved["state"]["bookmarks"]
    assert saved["revision"] > 0 and len(bookmarks) == 1
    assert bookmarks[0]["chapterId"] == chapter
    return bookmarks[0]["title"]


def verify_guests(chromium, errors):
    with chromium.launch(executable_path=CHROME, args=CHROME_ARGS) as browser:
        scopes, titles, pages, cookies = [], [], [], []
        for chapter in ["upper-01", "upper-02"]:
            context = browser.new_context(viewport=VIEWPORT, locale="zh-CN")
            page = watch_page(context, errors)
            open_chapter(page, chapter)
            check_guest_records(page, [])
            identity = server_state(page)
            assert identity["identityKind"] == "guest" and identity["recognized"]
            assert not identity["authenticated"]
            scopes.append(identity["cacheScope"])
            guest, = [cookie for cookie in context.cookies() if cookie["name"] == GUEST_COOKIE]
            assert guest["httpOnly"] and guest["secure"] and guest["sameSite"] == "Lax"
            assert guest["path"] == "/"
            cookies.append(guest["value"])
            titles.append(save_bookmark(page, chapter))
            pages.append(page)
        first, second = pages
        assert first.evaluate("navigator.userAgent") == second.evaluate("navigator.userAgent")
        assert scopes[0] != scopes[1] and cookies[0] != cookies[1] and titles[0] != titles[1]
        for page, scope, title in zip(pages, scopes, titles):
            page.reload(wait_until="domcontentloaded")
            check_guest_records(page, [title])
            assert server_state(page)["cacheScope"] == scope
        print("PASS · Two Chrome guests saved different bookmarks and recovered only their own after refresh.", flush=True)

        first.evaluate("localStorage.clear()")
        first.reload(wait_until="domcontentloaded")
        check_guest_records(first, [titles[0]])
        first.context.clear_cookies(name=GUEST_COOKIE)
        first.reload(wait_until="domcontentloaded")
        check_guest_records(first, [])
        assert server_state(first)["cacheScope"] not in scopes
        check_guest_records(second, [titles[1]])
        print("PASS · The cookie restored the server bookmark after local cache loss. Clearing it began a new guest.", flush=True)


def verify_blocked_cookies(chromium, errors):
    with tempfile.TemporaryDirectory() as profile:
        prefs = Path(profile) / "Default" / "Preferences"
        prefs.parent.mkdir()
        prefs.write_text(json.dumps({"profile": {"default_content_setting_values": {"cookies": 2}}}))
        with chromium.launch_persistent_context(
            profile, executable_path=CHROME, args=CHROME_ARGS, viewport=VIEWPORT, locale="zh-CN",
        ) as context:
            page = watch_page(context, errors)
            page.goto(ORIGIN, wait_until="domcontentloaded")
            panel = records(page)
            expect(panel.get_by_text(re.compile("允许本站 Cookie"))).to_be_visible()
            assert not any(cookie["name"] == GUEST_COOKIE for cookie in context.cookies())
            assert server_state(page)["identityKind"] == "anonymous"
            panel.get_by_role("button", name="关闭面板").click()
            open_chapter(page, "upper-01")
            page.get_by_role("button", name="添加书签", exact=True).click()
            expect(records(page).locator(".bookmark-record")).to_have_count(1)
            assert not server_state(page)["state"].get("bookmarks")
            print("PASS · Chrome with site cookies blocked explained the fallback and allowed reading and an in-page bookmark.", flush=True)


if __name__ == "__main__":
    if not CHROME:
        raise SystemExit("This test requires Google Chrome or Chromium.")
    expect.set_options(timeout=15000)
    errors = []
    with sync_playwright() as playwright:
        verify_guests(playwright.chromium, errors)
        verify_blocked_cookies(playwright.chromium, errors)
    assert not errors, errors
