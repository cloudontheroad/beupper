import html
import ctypes
import json
import importlib.util
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

import httpx


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SOCIAL_PROFILE_ROOT = PROJECT_ROOT / "data" / "social-browser"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
SOCIAL_DEBUG_PORTS = {"xueqiu": 9331, "twitter": 9332}


def _foreground_browser_window(pid):
    """Restore and foreground the visible top-level window owned by pid."""
    if os.name != "nt":
        return False
    user32 = ctypes.windll.user32
    found = []
    enum_proc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

    def visit(hwnd, _):
        owner = ctypes.c_ulong()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == pid and user32.IsWindowVisible(hwnd):
            found.append(hwnd)
            return False
        return True

    user32.EnumWindows(enum_proc(visit), 0)
    if not found:
        return False
    hwnd = found[0]
    user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    user32.BringWindowToTop(hwnd)
    user32.SetForegroundWindow(hwnd)
    return True


def _browser_executable():
    candidates = [
        Path(os.environ.get("PROGRAMFILES", "")) / "Google" / "Chrome" / "Application" / "chrome.exe",
        Path(os.environ.get("PROGRAMFILES(X86)", "")) / "Microsoft" / "Edge" / "Application" / "msedge.exe",
    ]
    return next((item for item in candidates if item.is_file()), None)


def _profile_dir(platform):
    target = SOCIAL_PROFILE_ROOT / platform
    target.mkdir(parents=True, exist_ok=True)
    return target


def _stop_headless_profile_browser(platform):
    """Stop only stale headless Chrome roots using this project's profile."""
    if os.name != "nt":
        return 0
    profile = str(_profile_dir(platform)).replace("'", "''")
    script = (
        "$targets = Get-CimInstance Win32_Process | Where-Object { "
        f"$_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*{profile}*' "
        "-and $_.CommandLine -match '--headless' -and $_.CommandLine -notmatch '--type=' }; "
        "$count = @($targets).Count; "
        "$targets | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; "
        "$count"
    )
    completed = subprocess.run(
        ["powershell.exe", "-NoProfile", "-Command", script],
        capture_output=True, text=True, timeout=12,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    try:
        count = int((completed.stdout or "0").strip().splitlines()[-1])
    except (ValueError, IndexError):
        count = 0
    if count:
        time.sleep(1.2)
    return count


def _close_dedicated_browser(platform):
    """Close only this platform's CDP browser, preserving its profile/cookies."""
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(
                f"http://127.0.0.1:{SOCIAL_DEBUG_PORTS[platform]}", timeout=1800
            )
            browser.close()
        time.sleep(0.8)
        return True
    except Exception:
        return False


def open_social_login(platform):
    if platform not in ("xueqiu", "twitter"):
        return {"ok": False, "status": 400, "error": "不支持的社交平台"}
    browser = _browser_executable()
    if not browser:
        return {"ok": False, "status": 500, "error": "没有找到 Chrome 或 Edge"}
    closed = _close_dedicated_browser(platform)
    stopped = _stop_headless_profile_browser(platform)
    url = "https://xueqiu.com/" if platform == "xueqiu" else "https://x.com/home"
    process = subprocess.Popen(
        [
            str(browser), f"--user-data-dir={_profile_dir(platform)}",
            f"--remote-debugging-port={SOCIAL_DEBUG_PORTS[platform]}",
            "--remote-debugging-address=127.0.0.1",
            "--no-first-run", "--no-default-browser-check", "--new-window",
            "--window-position=80,80", "--window-size=1280,900", url,
        ],
        cwd=str(PROJECT_ROOT),
        # DETACHED_PROCESS prevents a GUI child launched by the hidden gateway
        # from reliably attaching to the interactive desktop on Windows.
        creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
    )
    time.sleep(0.8)
    if process.poll() not in (None, 0):
        return {"ok": False, "status": 500, "error": f"专属浏览器启动失败（退出码 {process.returncode}）"}
    # Chrome may create the window successfully but leave it behind the dashboard.
    # Give its top-level window a moment to appear, then restore and foreground it.
    foregrounded = False
    for _ in range(12):
        if _foreground_browser_window(process.pid):
            foregrounded = True
            break
        time.sleep(0.25)
    return {
        "ok": True, "platform": platform,
        "message": ("已重置残留专属会话，登录窗口已重新打开。" if (closed or stopped) else "登录窗口已打开。")
        + ("窗口已置前。" if foregrounded else "窗口已创建；如未置前，请在任务栏选择该专属 Chrome 窗口。")
        + "完成登录后可直接回到页面检查状态，无需关闭窗口。",
    }


def _with_browser(platform, callback):
    from playwright.sync_api import sync_playwright
    executable = _browser_executable()
    if not executable:
        raise RuntimeError("没有找到 Chrome 或 Edge")
    with sync_playwright() as playwright:
        browser = None
        try:
            browser = playwright.chromium.connect_over_cdp(
                f"http://127.0.0.1:{SOCIAL_DEBUG_PORTS[platform]}", timeout=2500
            )
        except Exception:
            pass
        if browser and browser.contexts:
            return callback(browser.contexts[0])
        context = playwright.chromium.launch_persistent_context(
            str(_profile_dir(platform)), executable_path=str(executable), headless=True,
            args=["--disable-gpu", "--no-first-run"], viewport={"width": 1280, "height": 900},
        )
        try:
            return callback(context)
        finally:
            context.close()


def social_login_status(platform):
    if platform not in ("xueqiu", "twitter"):
        return {"ok": False, "status": 400, "error": "不支持的社交平台"}
    try:
        def probe(context):
            cookies = context.cookies()
            cookie_names = {item.get("name", "") for item in cookies}
            # xq_a_token is also issued to anonymous visitors. Only Xueqiu's
            # non-zero user id cookie proves an authenticated account session.
            xueqiu_user_cookie = next((item for item in cookies if item.get("name") == "u"), None)
            xueqiu_authenticated = bool(
                xueqiu_user_cookie and str(xueqiu_user_cookie.get("value") or "").strip() not in ("", "0")
            )
            if platform == "twitter" and "auth_token" in cookie_names:
                return {"ok": True, "platform": platform, "loggedIn": True, "verifiedBy": "session-cookie"}

            page = context.pages[0] if context.pages else context.new_page()
            page.goto("https://xueqiu.com/" if platform == "xueqiu" else "https://x.com/home", wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(3500)
            cookies = context.cookies()
            cookie_names = {item.get("name", "") for item in cookies}
            if platform == "xueqiu":
                xueqiu_user_cookie = next((item for item in cookies if item.get("name") == "u"), None)
                signed_in = bool(
                    xueqiu_user_cookie and str(xueqiu_user_cookie.get("value") or "").strip() not in ("", "0")
                ) or (
                    page.locator("a[href*='/u/'], .user-name, [class*='avatar']").count() > 0
                    and page.locator("text=登录").count() == 0
                )
            else:
                signed_in = "auth_token" in cookie_names or (
                    "/login" not in page.url
                    and page.locator("[data-testid='SideNav_AccountSwitcher_Button'], a[data-testid='AppTabBar_Home_Link'], a[href='/home']").count() > 0
                )
            result = {
                "ok": True,
                "platform": platform,
                "loggedIn": signed_in,
                "verifiedBy": "session-cookie-or-account-ui" if signed_in else "none",
                "message": "已检测到专用浏览器登录会话" if signed_in else "专用浏览器中尚未发现有效登录会话；请确认是在弹出的窗口里完成登录并已关闭窗口",
            }
            if platform == "xueqiu" and signed_in:
                capability = page.evaluate("""async () => {
                  const response = await fetch('/query/v1/search/status.json?q=%E8%8B%B1%E4%BC%9F%E8%BE%BE&count=1&page=1', {credentials: 'include', headers: {'Accept': 'application/json'}});
                  const text = await response.text();
                  return {status: response.status, json: text.trim().startsWith('{')};
                }""")
                result["searchReady"] = bool(capability.get("json"))
                if not result["searchReady"]:
                    result["message"] = "账号已登录，但雪球搜索接口返回安全页/网页壳；请在专属窗口完成手机号、账号安全或验证码提示后再检查"
            return result
        return _with_browser(platform, probe)
    except Exception as error:
        message = str(error)
        lowered = message.lower()
        if (
            "user data directory is already in use" in lowered
            or "processsingleton" in lowered
            or "target page, context or browser has been closed" in lowered
        ):
            message = "当前登录窗口由旧版本方式打开。请关闭该专属窗口，重新点一次“打开浏览器登录”，之后无需关闭即可检查状态"
        return {"ok": True, "platform": platform, "loggedIn": False, "error": message[:220], "message": message[:220]}


def _clean_text(value):
    text = re.sub(r"<[^>]+>", "", str(value or ""))
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def _iso_time(value):
    try:
        number = float(value)
        if number > 10_000_000_000:
            number /= 1000
        return datetime.fromtimestamp(number, timezone.utc).isoformat()
    except (TypeError, ValueError, OSError):
        return ""


def search_xueqiu(query, cookie, limit=20):
    if not cookie:
        try:
            def fetch_in_session(context):
                page = context.pages[0] if context.pages else context.new_page()
                page.goto("https://xueqiu.com/", wait_until="domcontentloaded", timeout=30000)
                cookies = context.cookies()
                user_cookie = next((item for item in cookies if item.get("name") == "u"), None)
                # Public search may work without a signed-in account. Test the
                # capability rather than treating a cookie as proof of access.
                targets = [
                    f"https://xueqiu.com/query/v1/search/status.json?q={quote(query)}&count={min(limit, 20)}&page=1",
                    f"https://xueqiu.com/statuses/search.json?source=all&q={quote(query)}&count={min(limit, 20)}&page=1&sort=time",
                ]
                try:
                    result = page.evaluate("""async (urls) => {
                  const attempts = [];
                  for (const url of urls) {
                    try {
                    const response = await fetch(url, {credentials: 'include', signal: AbortSignal.timeout(10000), headers: {'Accept': 'application/json'}});
                    const text = await response.text();
                    attempts.push({status: response.status, text: text.slice(0, 160)});
                    if (response.ok && text.trim().startsWith('{')) {
                      const payload = JSON.parse(text);
                      if (Array.isArray(payload.list)) return {ok: true, payload};
                      attempts.push({error: 'JSON does not contain a post list'});
                    }
                    } catch (error) { attempts.push({error: String(error)}); }
                  }
                  return {ok: false, attempts};
                    }""", targets)
                except Exception as error:
                    result = {"ok": False, "attempts": [{"error": str(error)[:120]}]}
                if not result.get("ok") or not result.get("payload", {}).get("list"):
                    # Some Xueqiu accounts receive an HTML shell from both JSON
                    # endpoints. Fall back to the signed-in search page instead.
                    page.goto(f"https://xueqiu.com/k?q={quote(query)}", wait_until="domcontentloaded", timeout=30000)
                    page.wait_for_timeout(3500)
                    cards = page.locator(".timeline__item, [class*='timeline__item'], article")
                    rows = []
                    for index in range(min(cards.count(), limit)):
                        card = cards.nth(index)
                        text = _clean_text(card.inner_text())
                        links = card.locator("a[href]")
                        href = ""
                        for link_index in range(links.count()):
                            candidate = links.nth(link_index).get_attribute("href") or ""
                            if re.search(r"/\d+/\d+", candidate):
                                href = candidate
                                break
                        if text and href:
                            rows.append({
                                "id": href.rstrip("/").split("/")[-1],
                                "text": text,
                                "source_link": f"https://xueqiu.com{href}" if href.startswith("/") else href,
                                "user": {"screen_name": text.split(" ", 1)[0][:40]},
                            })
                    if rows:
                        return {"list": rows}
                    attempts = result.get("attempts") or []
                    statuses = ",".join(str(item.get("status")) for item in attempts)
                    errors = "; ".join(str(item.get("error", "")) for item in attempts if item.get("error"))
                    page_hint = _clean_text(page.locator("body").inner_text())[:120]
                    if re.search(r"安全策略拦截|安全验证|访问异常|验证码", page_hint):
                        raise RuntimeError("雪球安全策略拦截了搜索页；需要在雪球专属登录窗口完成正常验证后重试，当前不能取得用户观点")
                    raise RuntimeError(f"接口及搜索页均未取得帖子（HTTP {statuses or 'unknown'}；{errors[:60]}）；页面：{page_hint or '空白或未渲染'}")
                return result["payload"]
            payload = _with_browser("xueqiu", fetch_in_session)
            return _xueqiu_rows(payload, limit), ""
        except Exception as error:
            return [], f"雪球浏览器会话不可用：{str(error)[:180]}"
    headers = {"User-Agent": USER_AGENT, "Referer": "https://xueqiu.com/", "Cookie": cookie}
    try:
        with httpx.Client(headers=headers, timeout=18, follow_redirects=True) as client:
            client.get("https://xueqiu.com/")
            response = client.get(
                "https://xueqiu.com/statuses/search.json",
                params={"source": "all", "q": query, "count": min(limit, 20), "page": 1, "sort": "time"},
            )
            response.raise_for_status()
            payload = response.json()
        return _xueqiu_rows(payload, limit), ""
    except Exception as error:
        return [], f"雪球直连失败：{type(error).__name__}: {str(error)[:180]}"


def _xueqiu_rows(payload, limit):
    results = []
    for row in (payload.get("list") or [])[:limit]:
        user = row.get("user") or {}
        text = _clean_text(row.get("text") or row.get("description"))
        if not text:
            continue
        post_id = str(row.get("id") or "")
        user_id = str(user.get("id") or "")
        url = row.get("source_link") or (f"https://xueqiu.com/{user_id}/{post_id}" if user_id and post_id else "")
        author = user.get("screen_name") or "雪球用户"
        results.append({
            "title": f"{author}：{text[:72]}", "snippet": text[:600], "url": url,
            "website": "雪球", "published_time": _iso_time(row.get("created_at")),
            "social": True, "platform": "xueqiu", "author": author,
            "engagement": {"likes": row.get("like_count", 0), "comments": row.get("reply_count", 0), "shares": row.get("retweet_count", 0)},
        })
    return results


def _twitter_executable():
    candidates = [
        shutil.which("twitter"),
        PROJECT_ROOT / ".runtime" / "venv" / "Scripts" / "twitter.exe",
        PROJECT_ROOT / ".runtime" / "venv" / "Scripts" / "twitter-script.py",
    ]
    executable = next((str(item) for item in candidates if item and Path(item).is_file()), "")
    if executable:
        return [executable]
    if importlib.util.find_spec("twitter_cli.cli"):
        return [sys.executable, "-m", "twitter_cli.cli"]
    return []


def search_twitter(query, auth_token, ct0, limit=20):
    if not auth_token or not ct0:
        try:
            def scrape_session(context):
                page = context.pages[0] if context.pages else context.new_page()
                page.goto(f"https://x.com/search?q={quote(query)}&src=typed_query&f=live", wait_until="domcontentloaded", timeout=35000)
                page.wait_for_timeout(3500)
                results = []
                for article in page.locator("article").all()[:limit]:
                    text = _clean_text(article.inner_text())
                    links = article.locator("a[href*='/status/']").all()
                    href = links[0].get_attribute("href") if links else ""
                    times = article.locator("time").all()
                    published = times[0].get_attribute("datetime") if times else ""
                    author_match = re.search(r"@([A-Za-z0-9_]+)", text)
                    author = author_match.group(1) if author_match else "X用户"
                    if text and href:
                        results.append({"title": f"@{author}：{text[:72]}", "snippet": text[:600], "url": f"https://x.com{href}", "website": "X/Twitter", "published_time": published or "", "social": True, "platform": "twitter", "author": author, "engagement": {}})
                return results
            return _with_browser("twitter", scrape_session), ""
        except Exception as error:
            return [], f"X浏览器会话不可用：{str(error)[:180]}"
    executable = _twitter_executable()
    if not executable:
        return [], "twitter-cli 未安装"
    env = os.environ.copy()
    env.update({"TWITTER_AUTH_TOKEN": auth_token, "TWITTER_CT0": ct0, "OUTPUT": "json"})
    try:
        command = [*executable, "search", query, "--type", "Latest", "--max", str(min(limit, 30)), "--json"]
        completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", env=env, timeout=45)
        if completed.returncode:
            return [], f"X 直连失败：{(completed.stderr or completed.stdout).strip()[:220]}"
        payload = json.loads(completed.stdout)
        rows = payload.get("data", payload if isinstance(payload, list) else [])
        results = []
        for row in rows[:limit]:
            author_data = row.get("author") or row.get("user") or {}
            author = author_data.get("screenName") or author_data.get("screen_name") or row.get("author") or "X用户"
            text = _clean_text(row.get("text") or row.get("full_text"))
            if not text:
                continue
            tweet_id = str(row.get("id") or row.get("id_str") or "")
            metrics = row.get("metrics") or {}
            results.append({
                "title": f"@{author}：{text[:72]}", "snippet": text[:600],
                "url": f"https://x.com/{author}/status/{tweet_id}" if tweet_id else "",
                "website": "X/Twitter", "published_time": row.get("createdAtISO") or row.get("createdAt") or row.get("created_at") or row.get("time") or "",
                "social": True, "platform": "twitter", "author": author,
                "engagement": {"likes": metrics.get("likes", row.get("favorite_count", 0)), "comments": metrics.get("replies", row.get("reply_count", 0)), "shares": metrics.get("retweets", row.get("retweet_count", 0)), "views": metrics.get("views", row.get("view_count", 0))},
            })
        return results, ""
    except Exception as error:
        return [], f"X 直连失败：{type(error).__name__}: {str(error)[:180]}"


def collect_social_sources(request_data):
    queries = list(dict.fromkeys(str(item).strip() for item in request_data.get("queries", []) if str(item).strip()))[:8]
    if not queries:
        queries = ["全球股市 财报"]
    all_results = []
    statuses = {"xueqiu": {"ok": False, "count": 0, "error": ""}, "twitter": {"ok": False, "count": 0, "error": ""}}
    for query in queries:
        clean_query = re.sub(r"雪球|X/Twitter|Twitter|投资者讨论|分歧|热议", " ", query, flags=re.I)
        clean_query = re.sub(r"\s+", " ", clean_query).strip()[:80]
        xq_items, xq_error = search_xueqiu(clean_query, request_data.get("xueqiuCookie", ""), 15)
        tw_items, tw_error = search_twitter(clean_query, request_data.get("twitterAuthToken", ""), request_data.get("twitterCt0", ""), 15)
        for item in xq_items + tw_items:
            item["query"] = clean_query
            all_results.append(item)
        statuses["xueqiu"]["count"] += len(xq_items)
        statuses["twitter"]["count"] += len(tw_items)
        statuses["xueqiu"]["error"] = xq_error or statuses["xueqiu"]["error"]
        statuses["twitter"]["error"] = tw_error or statuses["twitter"]["error"]
    statuses["xueqiu"]["ok"] = statuses["xueqiu"]["count"] > 0
    statuses["twitter"]["ok"] = statuses["twitter"]["count"] > 0
    unique = {item.get("url") or f"{item.get('platform')}:{item.get('title')}": item for item in all_results}
    failed = [name for name, state in statuses.items() if state["error"] and not state["count"]]
    success = any(state["count"] > 0 or not state["error"] for state in statuses.values())
    return {"ok": success, "status": 200 if success else 502,
            "partial": bool(failed) and success,
            "error": "；".join(state["error"] for state in statuses.values() if state["error"]) if not success else "",
            "references": list(unique.values()), "channels": statuses}
