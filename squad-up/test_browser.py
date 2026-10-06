from playwright.sync_api import sync_playwright
import subprocess, time, json, urllib.request, os, sys

env = dict(os.environ)
env["SQUAD_DB_FILE"] = "/tmp/squad_btest.json"
env["SQUAD_BASE_URL"] = "http://127.0.0.1:3901/squadup"
env["PORT"] = "3901"
if os.path.exists("/tmp/squad_btest.json"): os.remove("/tmp/squad_btest.json")
srv = subprocess.Popen(["node","server/index.js"], cwd=os.path.dirname(os.path.abspath(__file__)), env=env,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
time.sleep(1.5)

def api(path, body):
    r = urllib.request.Request("http://127.0.0.1:3901"+path,
        data=json.dumps(body).encode(), headers={"Content-Type":"application/json"})
    return json.load(urllib.request.urlopen(r))

fails=[]
def check(c,m):
    print(("  ok: " if c else "  FAIL: ")+m)
    if not c: fails.append(m)

try:
    gin = api("/squadup/api/signup", {"name":"Gin","email":"g@t.test"})
    em  = api("/squadup/api/signup", {"name":"Emily","email":"e@t.test"})
    act = api("/squadup/api/activity", {"token":gin["token"],"title":"Climbing",
          "tag_name":"Climbing","primary":"2030-04-18T18:00","backup":"2030-04-17T18:00"})
    A = act["id"]

    with sync_playwright() as p:
        b = p.chromium.launch()
        errs=[]
        pg = b.new_page(viewport={"width":400,"height":800})
        pg.on("pageerror", lambda e: errs.append(str(e)))
        # font requests fail in an offline sandbox; any other failed load still counts
        pg.on("console", lambda m: errs.append("console."+m.type+": "+m.text)
              if m.type=="error" and "Failed to load resource" not in m.text else None)
        pg.on("requestfailed", lambda r: errs.append("request failed: "+r.url)
              if "fonts.g" not in r.url else None)

        print("=== clicking RSVP in a real browser ===")
        pg.goto(f"http://127.0.0.1:3901/squadup/a/{A}?t={em['token']}")
        pg.wait_for_load_state("networkidle")
        pg.locator("[data-vote]").first.click()
        pg.wait_for_load_state("networkidle"); pg.wait_for_timeout(600)
        body = pg.content()
        check("Emily" in body, "clicking a time records the RSVP and shows the name")
        check(not errs, "no JS errors on the activity page: "+str(errs[:2]))

        print("\n=== suggest another time via the UI ===")
        errs.clear()
        pg.locator("#suggest").click()
        pg.wait_for_timeout(200)
        check(pg.locator("#sugbox").is_visible(), "the suggest panel opens")
        pg.locator("#sugwhen").fill("2030-04-19T19:00")
        pg.locator("#sugnote").fill("after work")
        pg.locator("#sugsend").click()
        pg.wait_for_load_state("networkidle"); pg.wait_for_timeout(600)
        check(not errs, "no JS errors submitting a suggestion: "+str(errs[:2]))

        print("\n=== creator approves it ===")
        errs.clear()
        pg.goto(f"http://127.0.0.1:3901/squadup/a/{A}?t={gin['token']}")
        pg.wait_for_load_state("networkidle")
        check(pg.locator("[data-approve]").count()==1, "creator sees the approve control")
        pg.locator("[data-approve]").first.click()
        pg.wait_for_load_state("networkidle"); pg.wait_for_timeout(600)
        check("Apr 19" in pg.content(), "approving puts it on the board")
        check(not errs, "no JS errors approving: "+str(errs[:2]))

        print("\n=== a stranger joins from the activity link ===")
        errs.clear()
        pg2 = b.new_page(viewport={"width":400,"height":800})
        pg2.on("pageerror", lambda e: errs.append(str(e)))
        pg2.goto(f"http://127.0.0.1:3901/squadup/a/{A}")
        pg2.wait_for_load_state("networkidle")
        check(pg2.locator("#join").count()==1, "a signed-out visitor sees the join form")
        check(pg2.locator("[data-approve]").count()==0, "and cannot see pending suggestions")
        pg2.locator("#jname").fill("Lainee")
        pg2.locator("#jemail").fill("lainee@t.test")
        pg2.locator("#join").click()
        pg2.wait_for_load_state("networkidle"); pg2.wait_for_timeout(900)
        check("/squadup/a/" in pg2.url and "t=" in pg2.url, "they land back on the activity, signed in")
        check(not errs, "no JS errors during join: "+str(errs[:2]))

        print("\n=== opening a plan from the home page ===")
        errs.clear()
        pg.goto(f"http://127.0.0.1:3901/squadup/p/{em['token']}")
        pg.wait_for_load_state("networkidle")
        pg.locator("a.bubble", has_text="Climbing").first.click()
        pg.wait_for_load_state("networkidle")
        check(pg.locator("#join").count()==0 and pg.locator("[data-vote]").count()>0,
              "tapping a plan opens it signed in, ready to vote")

        print("\n=== subscriptions toggle on the personal page ===")
        errs.clear()
        pg.goto(f"http://127.0.0.1:3901/squadup/p/{gin['token']}")
        pg.wait_for_load_state("networkidle")
        chip = pg.locator(".chip").first
        chip.click(); pg.wait_for_timeout(700)
        check("on" not in (chip.get_attribute("class") or ""), "tapping a category turns it off")
        check(not errs, "no JS errors toggling: "+str(errs[:2]))

        print("\n=== new activity form ===")
        errs.clear()
        pg.goto(f"http://127.0.0.1:3901/squadup/new?t={gin['token']}")
        pg.wait_for_load_state("networkidle")
        pg.locator("#title").fill("Beach day")
        pg.select_option("#tag","__new")
        pg.wait_for_timeout(200)
        check(pg.locator("#newtag").is_visible(), "choosing a new category reveals the name field")
        pg.locator("#tagname").fill("Beach")
        pg.locator("#p1").fill("2030-05-01T11:00")
        pg.locator("#go").click()
        pg.wait_for_load_state("networkidle"); pg.wait_for_timeout(900)
        check("/squadup/a/" in pg.url, "posting lands on the new activity")
        check("Beach day" in pg.content(), "and it shows the title")
        check(not errs, "no JS errors posting: "+str(errs[:2]))

        print("\n=== let's do this sometime ===")
        errs.clear()
        pg.goto(f"http://127.0.0.1:3901/squadup/p/{em['token']}")
        pg.wait_for_load_state("networkidle")
        pg.locator("#ideaopen").click()
        check(pg.locator("#ideabox").is_visible(), "the add form opens")
        pg.locator("#ititle").fill("Kayaking the Caloosahatchee")
        pg.select_option("#tag", "__new")
        pg.locator("#tagname").fill("Water")
        pg.locator("#inote").fill("Rentals at the park")
        pg.locator("#ideago").click()
        pg.wait_for_load_state("networkidle"); pg.wait_for_timeout(900)
        card = pg.locator(".bubble.idea", has_text="Kayaking")
        check(card.count() == 1, "the new idea appears on the list")
        check(card.locator(".orb b").inner_text() == "1", "with the poster already in")
        check(not errs, "no JS errors adding an idea: "+str(errs[:2]))

        errs.clear()
        pg.goto(f"http://127.0.0.1:3901/squadup/p/{gin['token']}")
        pg.wait_for_load_state("networkidle")
        card = pg.locator(".bubble.idea", has_text="Kayaking")
        card.locator("[data-join]").click()
        pg.wait_for_load_state("networkidle"); pg.wait_for_timeout(900)
        card = pg.locator(".bubble.idea", has_text="Kayaking")
        check(card.locator(".orb b").inner_text() == "2" and "You're in" in card.inner_text(),
              "tapping I'm in adds your name")
        pg.once("dialog", lambda d: d.accept())
        card.locator("[data-nudge]").click()
        pg.wait_for_load_state("networkidle"); pg.wait_for_timeout(900)
        card = pg.locator(".bubble.idea", has_text="Kayaking")
        check("Next nudge" in card.inner_text(), "the nudge goes out and the button retires for the week")
        check(not errs, "no JS errors joining and nudging: "+str(errs[:2]))
        pg.set_viewport_size({"width":390,"height":844})
        pg.locator("#ideas").scroll_into_view_if_needed()
        pg.screenshot(path="/tmp/squadup_ideas_mobile.png", full_page=True)

        errs.clear()
        card.locator("a.pill", has_text="Pick a time").click()
        pg.wait_for_load_state("networkidle")
        check(pg.locator("#title").input_value() == "Kayaking the Caloosahatchee",
              "Pick a time opens the form pre-filled")
        pg.locator("#p1").fill("2030-06-06T09:00")
        pg.locator("#go").click()
        pg.wait_for_load_state("networkidle"); pg.wait_for_timeout(900)
        check("/squadup/a/" in pg.url, "posting it lands on the new activity")
        pg.goto(f"http://127.0.0.1:3901/squadup/p/{gin['token']}")
        pg.wait_for_load_state("networkidle")
        check(pg.locator(".bubble.idea", has_text="Kayaking").count() == 0,
              "and the idea is off the list")
        check(pg.locator("a.bubble", has_text="Kayaking").count() == 1,
              "replaced by the scheduled activity above it")
        check(not errs, "no JS errors scheduling an idea: "+str(errs[:2]))

        b.close()
finally:
    srv.terminate()

print("\n"+("BROWSER FAILURES:\n - "+"\n - ".join(fails) if fails else "ALL BROWSER CHECKS PASSED"))
sys.exit(1 if fails else 0)
