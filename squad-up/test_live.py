"""Live updates in real browsers: two people with the same pages open.
   python3 test_live.py"""
from playwright.sync_api import sync_playwright
import subprocess, time, json, urllib.request, os, sys

PORT = 3902
H = f"http://127.0.0.1:{PORT}"
DB = "/tmp/squad_livetest.json"
SHOTS = os.environ.get("SHOTS", "/tmp/")
env = dict(os.environ, SQUAD_DB_FILE=DB, SQUAD_BASE_URL=H + "/squadup", PORT=str(PORT))
for k in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY", "RESEND_API_KEY", "TWILIO_AUTH_TOKEN"): env.pop(k, None)
if os.path.exists(DB): os.remove(DB)
srv = subprocess.Popen(["node", "server/index.js"], cwd=os.path.dirname(os.path.abspath(__file__)), env=env,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
time.sleep(1.5)

def api(path, body):
    if path == "/squadup/api/signup": body = {"agree": True, "sms_consent": True, **body}
    r = urllib.request.Request(H + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r))

def confirm(tok):
    d = json.load(open(DB))
    for p in d["people"]:
        if p["personal_token"] == tok: p["email_confirmed_at"] = p.get("email_confirmed_at") or "2026-01-01T00:00:00Z"
    json.dump(d, open(DB, "w"))

fails = []
def check(c, m):
    print(("  ok: " if c else "  FAIL: ") + m)
    if not c: fails.append(m)

try:
    gin = api("/squadup/api/signup", {"name": "Gin", "email": "gin@l.test"})
    seb = api("/squadup/api/signup", {"name": "Sebastian", "email": "seb@l.test"})
    dan = api("/squadup/api/signup", {"name": "Danielle", "email": "dan@l.test"})
    # the file database is read once at start-up: restart after confirming emails by hand
    srv.terminate(); srv.wait()
    for t in (gin["token"], seb["token"], dan["token"]): confirm(t)
    srv = subprocess.Popen(["node", "server/index.js"], cwd=os.path.dirname(os.path.abspath(__file__)), env=env,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    time.sleep(1.5)
    plan = api("/squadup/api/activity", {"token": gin["token"], "title": "Taco night", "tag_name": "Tacos",
               "primary": "2031-05-02T19:00", "backup": "2031-05-03T19:00"})
    P = plan["id"]

    with sync_playwright() as p:
        b = p.chromium.launch()
        def phone(tok):
            c = b.new_context(viewport={"width": 390, "height": 760}, device_scale_factor=2)
            pg = c.new_page(); errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            pg.goto(f"{H}/squadup/a/{P}?t={tok}"); pg.wait_for_load_state("networkidle")
            pg.wait_for_function("window.LIVE_ID")
            pg.evaluate("window.__noReload = 1")
            return c, pg, errs
        gc, g, gerr = phone(gin["token"])
        sc, s, serr = phone(seb["token"])

        print("=== answers show up live ===")
        check(g.evaluate("!!window.LIVE_ID") and s.evaluate("!!window.LIVE_ID"), "both pages connect once loaded")
        t0 = time.time()
        s.locator("[data-vote]").first.click()
        g.wait_for_function("document.querySelector('#opts').innerText.includes('Sebastian')", timeout=8000)
        check(True, f"Sebastian's answer appears on Gin's open page in {time.time() - t0:.1f}s, no reload")
        check(g.evaluate("window.__noReload") == 1, "Gin's page never reloaded")

        # Gin is mid-tap when Sebastian answers: Gin's taps are never undone
        was = g.evaluate("[...document.querySelectorAll('[data-vote]')].map(b => b.classList.contains('on'))")
        g.locator("[data-vote]").nth(0).click(); g.locator("[data-vote]").nth(1).click()
        s.locator("[data-vote]").nth(1).click()
        g.wait_for_timeout(4500)
        now = g.evaluate("[...document.querySelectorAll('[data-vote]')].map(b => b.classList.contains('on'))")
        check(now[0] == (not was[0]) and now[1] == (not was[1]), "Gin's own quick taps stay put while Sebastian's answer lands")
        mine = [r for r in json.load(open(DB))["responses"] if r["activity_id"] == P and r["person_id"] != None]
        check("Sebastian" in g.locator("#opts").inner_text(), "and Sebastian's answers still show")
        saved = [r for r in json.load(open(DB))["responses"] if r["activity_id"] == P]
        check(len(saved) == 2, "both answers saved")

        print("\n=== comments, typing dots, and the box you're typing in ===")
        # Gin's comments are closed: a new one bumps the count and marks it new
        s.locator("#comments summary").click()
        s.locator("#cmtin").fill("I'll bring guac"); s.locator("#cmtsend").click()
        g.wait_for_function("document.querySelector('#comments .cmtcount') && document.querySelector('#comments .cmtcount').innerText==='1'", timeout=8000)
        check("fresh" in (g.locator("#comments").get_attribute("class") or ""), "a closed Comments line shows the new count and a 'new' marker")
        g.locator("#comments summary").click(); g.wait_for_timeout(150)
        check("I'll bring guac" in g.locator("#commentlist").inner_text() and "fresh" not in (g.locator("#comments").get_attribute("class") or ""),
              "opening it shows the comment and clears the marker")
        # Gin starts a comment; Sebastian types and posts; Gin's half-written text is untouched
        g.locator("#cmtin").fill("Should we also")
        s.locator("#cmtin").press_sequentially("Salsa too", delay=40)
        g.wait_for_selector("#cmttyping:not(.hidden)", timeout=5000)
        check("Sebastian is typing" in g.locator("#cmttyping").inner_text(), "Gin sees 'Sebastian is typing' with dots")
        g.locator("#comments").scroll_into_view_if_needed()
        g.locator("#comments").screenshot(path=SHOTS + "squad-up-typing.png")
        s.locator("#cmtsend").click()
        g.wait_for_function("document.querySelectorAll('#commentlist .cmt').length === 2", timeout=8000)
        check(g.locator("#cmtin").input_value() == "Should we also", "Gin's unsent comment is untouched when Sebastian's arrives")
        g.wait_for_timeout(300)
        check(g.locator("#cmttyping").is_hidden(), "the dots go away once Sebastian posts")
        check("Sebastian" not in s.locator("#cmttyping").inner_text(), "Sebastian never sees his own dots (he sees Gin's, she's mid-comment)")

        # Gin scrolled up in a long thread: new ones don't yank the view; a button offers to jump
        for i in range(10):
            s.locator("#cmtin").fill(f"Filler {i}"); s.locator("#cmtsend").click()
            s.wait_for_function(f"document.querySelectorAll('#commentlist .cmt').length === {i + 3}")
        g.wait_for_function("document.querySelectorAll('#commentlist .cmt').length === 12", timeout=10000)
        g.evaluate("document.getElementById('commentlist').scrollTop = 0")
        g.wait_for_timeout(300)
        s.locator("#cmtin").fill("Newest one"); s.locator("#cmtsend").click()
        g.wait_for_function("document.querySelectorAll('#commentlist .cmt').length === 13", timeout=8000)
        check(g.evaluate("document.getElementById('commentlist').scrollTop") < 5, "reading back up the thread, Gin's place is kept")
        check(g.locator("#cmtnew").is_visible(), "and a 'New comments' button appears")
        g.locator("#cmtnew").click()
        check(g.evaluate("(()=>{const l=document.getElementById('commentlist');return l.scrollTop+l.clientHeight>=l.scrollHeight-24})()"),
              "tapping it goes to the newest")

        print("\n=== the page doesn't jump ===")
        g.evaluate("window.scrollTo(0, document.getElementById('comments').getBoundingClientRect().top + window.scrollY - 100)")
        g.wait_for_timeout(300)
        before = g.evaluate("document.getElementById('comments').getBoundingClientRect().top")
        api("/squadup/api/rsvp", {"token": dan["token"], "activity_id": P, "option_ids": []})
        api("/squadup/api/rsvp", {"token": dan["token"], "activity_id": P, "cant": True})
        g.wait_for_function("document.querySelector('#opts').innerText.includes('Danielle')", timeout=8000)
        after = g.evaluate("document.getElementById('comments').getBoundingClientRect().top")
        check(abs(after - before) <= 2, f"something above changes size and what Gin is looking at stays put ({before:.0f} -> {after:.0f})")

        print("\n=== home pages ===")
        hc = b.new_context(viewport={"width": 390, "height": 760})
        h = hc.new_page(); herr = []
        h.on("pageerror", lambda e: herr.append(str(e)))
        h.goto(f"{H}/squadup/p/{dan['token']}"); h.wait_for_load_state("networkidle"); h.wait_for_function("window.LIVE_ID")
        h.evaluate("window.__noReload = 1")
        n0 = h.locator("#homeplans").inner_text()
        api("/squadup/api/comment", {"token": gin["token"], "activity_id": P, "body": "See you there"})
        h.wait_for_function("document.querySelector('#homeplans .cmtn') && document.querySelector('#homeplans .cmtn').innerText.trim()==='14'", timeout=8000)
        check(True, "the comment count on Danielle's home card goes up live")
        # Activities: Gin taps I'm interested, Danielle's card updates; Danielle tapping at the same time isn't undone
        tid = json.load(open(DB))["tags"][0]["id"]
        api("/squadup/api/interest", {"token": gin["token"], "tag_id": tid, "on": True})
        h.wait_for_function(f"document.getElementById('act-{tid}').textContent.includes('Gin')", timeout=8000)
        check(True, "Gin's 'I'm interested' shows on Danielle's Activities card live")
        h.locator(f"#act-{tid} [data-int]").click()
        api("/squadup/api/interest", {"token": seb["token"], "tag_id": tid, "on": True})
        h.wait_for_timeout(4500)
        check("Interested ✓" in h.locator(f"#act-{tid} [data-int]").inner_text(), "Danielle's own tap stays on while others' arrive")
        check(h.evaluate("window.__noReload") == 1, "the home page never reloads")

        print("\n=== a deleted plan, and reconnecting ===")
        api("/squadup/api/cancel", {"token": gin["token"], "activity_id": P, "reason": "Rain", "notify": False})
        s.wait_for_selector("#livebar", timeout=8000)
        check("This just changed" in s.locator("#livebar").inner_text(), "Sebastian's open page offers 'This just changed. Show me'")
        s.locator("#livebar").screenshot(path=SHOTS + "squad-up-livebar.png")
        check(not gerr and not serr and not herr, "no JS errors: " + str((gerr + serr + herr)[:2]))
        b.close()
finally:
    srv.terminate()

print("\n" + ("LIVE FAILURES:\n - " + "\n - ".join(fails) if fails else "ALL LIVE CHECKS PASSED"))
sys.exit(1 if fails else 0)
