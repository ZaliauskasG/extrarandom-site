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
    if path == "/squadup/api/signup": body = {"agree": True, "sms_consent": True, **body}
    r = urllib.request.Request("http://127.0.0.1:3901"+path,
        data=json.dumps(body).encode(), headers={"Content-Type":"application/json"})
    return json.load(urllib.request.urlopen(r))

fails=[]
def check(c,m):
    print(("  ok: " if c else "  FAIL: ")+m)
    if not c: fails.append(m)

try:
    gin = api("/squadup/api/signup", {"name":"Gin","email":"g@t.test"})
    em  = api("/squadup/api/signup", {"name":"Danielle","email":"e@t.test"})
    act = api("/squadup/api/activity", {"token":gin["token"],"title":"Climbing",
          "tag_name":"Climbing","primary":"2030-04-18T18:00","backup":"2030-04-17T18:00"})
    A = act["id"]

    with sync_playwright() as p:
        b = p.chromium.launch()
        # Most checks below are about what's inside Host tools and Invite, so
        # those start open here; the folding itself has its own checks at the end.
        UNFOLD = "document.addEventListener('DOMContentLoaded',()=>{['hosttools','invited'].forEach(id=>{const d=document.getElementById(id); if(d) d.open=true;});});"
        _np, _nc = b.new_page, b.new_context
        def _new_page(**kw):
            x = _np(**kw); x.add_init_script(UNFOLD); return x
        def _new_context(**kw):
            x = _nc(**kw); x.add_init_script(UNFOLD); return x
        b.new_page, b.new_context = _new_page, _new_context
        errs=[]
        pg = b.new_page(viewport={"width":400,"height":800})
        pg.on("pageerror", lambda e: errs.append(str(e)))
        # font requests fail in an offline sandbox; any other failed load still counts
        pg.on("console", lambda m: errs.append("console."+m.type+": "+m.text)
              if m.type=="error" and "Failed to load resource" not in m.text else None)
        pg.on("requestfailed", lambda r: errs.append("request failed: "+r.url)
              if "fonts.g" not in r.url and "tour.mp4" not in r.url else None)

        print("=== clicking RSVP in a real browser ===")
        pg.goto(f"http://127.0.0.1:3901/squadup/a/{A}?t={em['token']}")
        pg.wait_for_load_state("networkidle")
        pg.evaluate("window.__noReload = 1")
        votes = pg.locator("[data-vote]")
        votes.nth(0).click(); votes.nth(1).click()
        check(pg.locator("[data-vote].on").count() == 2, "quick taps light up right away, no waiting")
        pg.wait_for_timeout(1800)
        body = pg.content()
        check("Danielle" in body, "clicking a time records the RSVP and shows the name")
        check(pg.evaluate("window.__noReload") == 1, "the page never reloads between taps")
        check(pg.locator("[data-vote].on").count() == 2, "both stay selected after the save refreshes the counts")
        votes.nth(1).click(); pg.wait_for_timeout(1800)
        resp = [r for r in json.load(open("/tmp/squad_btest.json"))["responses"] if r["activity_id"] == A]
        check(any(len(r["option_ids"]) == 1 for r in resp), "untapping one saves too")
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
        check(pg.locator(".askbox").is_visible() and "Add it and ask everyone" in pg.locator(".askbox").inner_text() and "Just add it" in pg.locator(".askbox").inner_text(),
              "adding a suggested time asks whether to ask everyone")
        pg.locator(".askbox button", has_text="Add it and ask everyone").click()
        pg.wait_for_load_state("networkidle"); pg.wait_for_timeout(600)
        check("Apr 19" in pg.content(), "approving puts it on the board")
        check(not errs, "no JS errors approving: "+str(errs[:2]))

        print("\n=== a stranger opens the plan link ===")
        errs.clear()
        SHOTS0 = "/tmp/claude-0/-home-claude/db9fdcab-d90c-5c91-90ad-49dfc5134cf7/scratchpad/"
        pg2 = b.new_page(viewport={"width":390,"height":844})
        pg2.on("pageerror", lambda e: errs.append(str(e)))
        pg2.goto(f"http://127.0.0.1:3901/squadup/a/{A}")
        pg2.wait_for_load_state("networkidle")
        check(pg2.locator("#ujoin").is_visible() and not pg2.locator("#gguest").is_visible() and "invited you" in pg2.content(),
              "a stranger starts at the welcome screen, with joining as the main choice")
        check(pg2.locator("[data-vote]").count()==0 and pg2.locator("[data-approve]").count()==0,
              "with nothing to tap until they say who they are")
        pg2.screenshot(path=SHOTS0+"squad-up-welcome.png", full_page=True)
        check(pg2.locator("#updbox").is_visible() and pg2.locator("#usms").is_visible() and not pg2.locator("#usms").is_checked(),
              "the join form shows phone/email, with the text box unticked")
        pg2.screenshot(path=SHOTS0+"squad-up-get-updates.png", full_page=True)
        pg2.locator("#loginopen").click()
        check(pg2.locator("#loginbox").is_visible() and not pg2.locator("#guestbox").is_visible(),
              "I already have an account opens the log-in box")
        pg2.locator("#lcontact").fill("nobody@t.test"); pg2.locator("#lsend").click(); pg2.wait_for_timeout(500)
        check("on its way" in pg2.locator("#lmsg").inner_text(), "and it answers the same whether or not the account exists")
        pg2.locator("#guestopen").click()
        check(pg2.locator("#gname").is_visible() and not pg2.locator("#loginbox").is_visible(), "Continue as a guest opens the name box")
        pg2.locator("#gname").fill("Lainee"); pg2.locator("#gguest").click()
        pg2.wait_for_load_state("networkidle"); pg2.wait_for_timeout(600)
        check("Answering as" in pg2.content() and pg2.locator("[data-vote]").count() > 0,
              "Continue as a guest opens the plan, answering as Lainee")
        check(not "t=" in pg2.url, "the address bar never shows a key")
        pg2.locator("[data-vote]").nth(0).click(); pg2.wait_for_timeout(1500)
        check("Lainee" in pg2.locator("#opts").inner_text(), "a guest's tap saves, with their name on the time")
        pg2.reload(); pg2.wait_for_load_state("networkidle")
        check(pg2.locator("[data-vote].on").count() == 1, "the browser remembers them after a reload")
        pg2.screenshot(path=SHOTS0+"squad-up-guest-plan.png", full_page=True)
        pg2.locator(".guestbar a", has_text="Get updates").click(); pg2.wait_for_load_state("networkidle")
        check(pg2.locator("#uname").input_value() == "Lainee", "Get updates starts with their name filled in")
        pg2.locator("#uemail").fill("lainee@t.test")
        pg2.locator("#ujoin").click(); pg2.wait_for_timeout(500)
        check("Terms" in pg2.locator("#umsg").inner_text(), "joining without the Terms box ticked is refused, with a clear message")
        pg2.locator("#uagree").check(); pg2.locator("#ujoin").click()
        pg2.wait_for_load_state("networkidle"); pg2.wait_for_timeout(900)
        check(f"/squadup/a/{A}" in pg2.url and "Answering as" not in pg2.content() and pg2.locator("[data-vote].on").count() == 1,
              "they land back on the plan as a member, with the time they picked as a guest")
        check(pg2.locator("#logout").count() == 1, "and Log out at the bottom")
        check(not errs, "no JS errors for a stranger: "+str(errs[:2]))
        pg2.close()

        print("\n=== opening a plan from the home page ===")
        errs.clear()
        pg.goto(f"http://127.0.0.1:3901/squadup/p/{em['token']}")
        pg.wait_for_load_state("networkidle")
        pg.locator("a.bubble", has_text="Climbing").first.click()
        pg.wait_for_load_state("networkidle")
        check(pg.locator("#join").count()==0 and pg.locator("[data-vote]").count()>0,
              "tapping a plan opens it signed in, ready to vote")

        print("\n=== the bell on an activity ===")
        errs.clear()
        pg.goto(f"http://127.0.0.1:3901/squadup/p/{gin['token']}")
        pg.wait_for_load_state("networkidle")
        climb = pg.locator(".act", has_text="Climbing")
        bell = climb.locator("[data-bell]")
        check(climb.count() == 1 and "on" in (bell.get_attribute("class") or ""), "posting a plan makes you interested, bell on")
        bell.click(); pg.wait_for_timeout(700)
        check("on" not in (bell.get_attribute("class") or "") and "still on the list" in climb.locator(".bellnote").inner_text(),
              "tapping the bell turns messages off, and says you're still on the list")
        pg.reload(); pg.wait_for_load_state("networkidle")
        climb = pg.locator(".act", has_text="Climbing")
        check("on" not in (climb.locator("[data-bell]").get_attribute("class") or "") and climb.locator("[data-int]").inner_text() == "Interested ✓",
              "it stays off after a reload, and you're still interested")
        climb.locator("[data-bell]").click(); pg.wait_for_timeout(700)
        check("on" in (climb.locator("[data-bell]").get_attribute("class") or ""), "tapping again turns it back on")
        check(not errs, "no JS errors with the bell: "+str(errs[:2]))

        print("\n=== new activity form ===")
        errs.clear()
        pg.goto(f"http://127.0.0.1:3901/squadup/new?t={gin['token']}")
        pg.wait_for_load_state("networkidle")
        pg.locator("#title").fill("Beach day")
        pg.select_option("#tag","__new")
        pg.wait_for_timeout(200)
        check(pg.locator("#newtag").is_visible(), "choosing a new activity reveals the name field")
        pg.locator("#tagname").fill("Beach")
        pg.locator("#p1").fill("2030-05-01T11:00")
        pg.locator("#go").click()
        pg.wait_for_load_state("networkidle"); pg.wait_for_timeout(900)
        check("/squadup/a/" in pg.url, "posting lands on the new activity")
        check("Beach day" in pg.content(), "and it shows the title")
        check(not errs, "no JS errors posting: "+str(errs[:2]))

        print("\n=== activities ===")
        errs.clear()
        pg.goto(f"http://127.0.0.1:3901/squadup/p/{em['token']}")
        pg.wait_for_load_state("networkidle")
        pg.locator("#actopen").click()
        check(pg.locator("#actbox").is_visible(), "+ New activity opens the form")
        pg.locator("#aname").fill("Kayaking the Caloosahatchee")
        pg.locator("#anote").fill("Rentals at the park")
        pg.locator("#actgo").click()
        pg.wait_for_load_state("networkidle"); pg.wait_for_timeout(900)
        card = pg.locator(".act", has_text="Kayaking")
        check(card.count() == 1 and card.locator("[data-int]").inner_text() == "Interested ✓" and "1 interested" in card.inner_text(),
              "the new activity appears, with you interested")
        check("Rentals at the park" in card.inner_text(), "and its note")
        check(not errs, "no JS errors adding an activity: "+str(errs[:2]))
        card.locator("[data-actedit]").click()
        check(pg.locator("#aname").input_value() == "Kayaking the Caloosahatchee" and pg.locator("#anote").input_value() == "Rentals at the park"
              and pg.locator("#actgo").inner_text() == "Save" and pg.locator("#actdel").is_visible(),
              "Edit opens its name and note, with Save and Take it off the list")
        pg.locator("#anote").fill("Rentals at Koreshan"); pg.locator("#actgo").click()
        pg.wait_for_load_state("networkidle"); pg.wait_for_timeout(900)
        check(pg.locator(".act", has_text="Koreshan").count() == 1 and pg.locator(".act", has_text="Rentals at the park").count() == 0,
              "saving changes it in place")
        pg.locator("#actopen").click(); pg.locator("#aname").fill("Goat yoga"); pg.locator("#actgo").click()
        pg.wait_for_load_state("networkidle"); pg.wait_for_timeout(900)
        pg.once("dialog", lambda d: d.accept())
        pg.locator(".act", has_text="Goat yoga").locator("[data-actedit]").click()
        pg.locator("#actdel").click()
        pg.wait_for_load_state("networkidle"); pg.wait_for_timeout(900)
        check(pg.locator(".act", has_text="Goat yoga").count() == 0, "Take it off the list removes it")
        check(not errs, "no JS errors editing an activity: "+str(errs[:2]))

        errs.clear()
        pg.goto(f"http://127.0.0.1:3901/squadup/p/{gin['token']}")
        pg.wait_for_load_state("networkidle")
        card = pg.locator(".act", has_text="Kayaking")
        check(card.locator(".newtag").count() == 1 and card.locator("[data-bell]").count() == 0, "to everyone else it's New, with no bell yet")
        card.locator("[data-int]").click()
        pg.wait_for_load_state("networkidle"); pg.wait_for_timeout(900)
        card = pg.locator(".act", has_text="Kayaking")
        check("Interested ✓" in card.inner_text() and card.locator("summary").inner_text() == "2 interested" and card.locator("[data-bell]").count() == 1,
              "tapping I'm interested adds you, with a bell")
        check(not card.locator(".people").is_visible(), "the names are tucked away")
        card.locator("summary").click(); pg.wait_for_timeout(200)
        check(card.locator(".people").is_visible() and "Danielle" in card.locator(".people").inner_text() and "Gin" in card.locator(".people").inner_text(),
              "the dropdown shows who's interested")
        check(not errs, "no JS errors joining: "+str(errs[:2]))
        pg.set_viewport_size({"width":390,"height":844})
        card.scroll_into_view_if_needed(); pg.evaluate("window.scrollBy(0,-120)")
        pg.screenshot(path="/tmp/claude-0/-home-claude/db9fdcab-d90c-5c91-90ad-49dfc5134cf7/scratchpad/squad-up-activities.png", full_page=False)

        errs.clear()
        card.locator("a.pill", has_text="Schedule it").click()
        pg.wait_for_load_state("networkidle")
        check(pg.locator("a.choice").count() == 2 and "Schedule Kayaking" in pg.locator("h1").inner_text(),
              "Schedule it asks: a date now, or find one together")
        pg.locator("a.choice", has_text="I know when").click()
        pg.wait_for_load_state("networkidle")
        check(pg.locator("#title").input_value() == "Kayaking the Caloosahatchee" and
              pg.locator("#tag option:checked").inner_text() == "Kayaking the Caloosahatchee",
              "the plan form opens with the activity picked")
        check("Interested:" in pg.locator(".sub").first.inner_text() and "Danielle" in pg.locator(".sub").first.inner_text(),
              "and says who's interested")
        pg.locator("#p1").fill("2030-06-06T09:00")
        pg.locator("#go").click()
        pg.wait_for_load_state("networkidle"); pg.wait_for_timeout(900)
        check("/squadup/a/" in pg.url, "posting it lands on the new plan")
        pg.goto(f"http://127.0.0.1:3901/squadup/p/{gin['token']}")
        pg.wait_for_load_state("networkidle")
        check(pg.locator("a.bubble", has_text="Kayaking").count() == 1 and pg.locator(".act", has_text="Kayaking").count() == 1,
              "the plan shows up top, and the activity stays on the list for next time")
        check(not errs, "no JS errors scheduling an activity: "+str(errs[:2]))

        print("\n=== location, edit, one-tap, delete, past plans ===")
        H = "http://127.0.0.1:3901"
        SHOTS = "/tmp/claude-0/-home-claude/db9fdcab-d90c-5c91-90ad-49dfc5134cf7/scratchpad/"
        errs.clear()
        pg.goto(f"{H}/squadup/new?t={gin['token']}")
        pg.wait_for_load_state("networkidle")
        pg.locator("#title").fill("Pickleball")
        check(not pg.locator("#loc").is_visible() and not pg.locator("#p2").is_visible() and not pg.locator("#note").is_visible(),
              "the form starts with just What, Activity and When")
        pg.locator("[data-reveal=locwrap]").click()
        check(pg.locator("#loc").is_visible() and not pg.locator("[data-reveal=locwrap]").is_visible(), "+ Where opens the Where box")
        pg.locator("#loc").fill("Josh's place on the far side of the river by the old mill")
        pg.select_option("#tag", "__new"); pg.locator("#tagname").fill("Pickleball")
        pg.locator("#p1").fill("2030-06-06T18:00")
        pg.locator("#bkadd").click()
        check(pg.locator("#p2").is_visible() and pg.locator("#bkdel").is_visible(),
              "+ Backup opens the backup box, with a Remove")
        pg.locator("#p2").blur(); pg.locator("#p2").focus()
        check(pg.locator("#p2").input_value() == "2030-06-06T18:00", "the backup starts from the main time")
        pg.locator("#p2").fill("2030-06-07T18:00")
        pg.locator("#go").click()
        pg.wait_for_url("**/squadup/a/**"); pg.wait_for_load_state("networkidle")
        PK = pg.url.split("/squadup/a/")[1].split("?")[0]
        check("at Josh" in pg.locator("h1").inner_text(), "the place shows in the plan's title")
        check(pg.locator("[data-vote].on").count() == 2, "the creator is already in for both times")
        check(not errs, "no JS errors posting with a place: "+str(errs[:2]))

        pg.goto(f"{H}/squadup/p/{em['token']}")
        pg.wait_for_load_state("networkidle")
        h3 = pg.locator(".row-card h3", has_text="Pickleball").first
        box = h3.bounding_box()
        check(box and box["height"] < 60, "a long title is cut to two lines on the card")
        check(pg.locator("#activities").count() == 1, "the home page has Activities")
        pg.screenshot(path=SHOTS+"home.png", full_page=True)

        errs.clear()
        pg.goto(f"{H}/squadup/a/{PK}?t={gin['token']}")
        pg.locator("a.pill", has_text="Edit").click()
        pg.wait_for_url("**/squadup/edit/**"); pg.wait_for_load_state("networkidle")
        check(pg.locator("#loc").input_value().startswith("Josh"), "Edit opens the form filled in")
        pg.locator("#loc").fill("Josh's place")
        pg.locator("#p1").fill("2030-06-13T18:00")
        pg.locator("#go").click()
        check(pg.locator(".askbox").is_visible() and "changes the day and place" in pg.locator(".askbox").inner_text(),
              "saving a new day and place asks whether to tell everyone")
        pg.locator(".askbox").scroll_into_view_if_needed()
        pg.screenshot(path=SHOTS+"squad-up-ask-send.png", full_page=False)
        pg.locator(".askbox button", has_text="Save and tell everyone").click()
        pg.wait_for_url("**/squadup/a/**"); pg.wait_for_load_state("networkidle")
        check("Jun 13" in pg.content(), "saving lands back on the plan with the new time")
        check(not errs, "no JS errors editing: "+str(errs[:2]))

        errs.clear()
        pg.goto(f"{H}/squadup/r/{PK}?t={em['token']}&do=all")
        pg.wait_for_url("**saved=in**"); pg.wait_for_load_state("networkidle")
        check(pg.locator(".bubble.saved").count() == 1, "a one-tap email link saves and confirms")
        check(pg.locator("[data-vote].on").count() == 2, "both times are marked")
        check(not errs, "no JS errors on the one-tap page: "+str(errs[:2]))
        pg.screenshot(path=SHOTS+"plan.png", full_page=True)

        errs.clear()
        pg.goto(f"{H}/squadup/edit/{PK}?t={gin['token']}")
        pg.wait_for_load_state("networkidle")
        pg.locator("#del").click()
        check(pg.locator(".askbox").is_visible() and "Delete quietly" in pg.locator(".askbox").inner_text(), "Delete plan asks whether to tell everyone")
        pg.once("dialog", lambda d: d.accept("Rain"))
        pg.locator(".askbox button", has_text="Delete and tell everyone").click()
        pg.wait_for_url("**/squadup/a/**"); pg.wait_for_load_state("networkidle")
        check("deleted" in pg.content(), "Delete plan marks it deleted")
        deleted_url = pg.url
        pg.goto(f"{H}/squadup/p/{gin['token']}")
        pg.locator("a.pill", has_text="Past plans").click()
        pg.wait_for_url("**/squadup/past**"); pg.wait_for_load_state("networkidle")
        check(pg.locator(".bubble.past", has_text="Pickleball").count() == 0, "a deleted plan isn't on Past plans")
        pg.screenshot(path=SHOTS+"past.png", full_page=True)
        pg.goto(deleted_url); pg.wait_for_load_state("networkidle")
        pg.locator("a.pill", has_text="Do it again").click()
        pg.wait_for_url("**again=**"); pg.wait_for_load_state("networkidle")
        check(pg.locator("#title").input_value() == "Pickleball" and pg.locator("#p1").input_value() == "",
              "Do it again opens a fresh form with the details filled in")
        check(not errs, "no JS errors deleting or on past plans: "+str(errs[:2]))

        print("\n=== backup left blank, and getting home ===")
        errs.clear()
        def post_plan(title, add_then_remove):
            pg.goto(f"{H}/squadup/new?t={gin['token']}")
            pg.wait_for_load_state("networkidle")
            pg.locator("#title").fill(title)
            pg.select_option("#tag", "__new"); pg.locator("#tagname").fill("Climbing")
            pg.locator("#p1").fill("2030-09-01T09:00")
            if add_then_remove:
                pg.locator("#bkadd").click()
                pg.locator("#p2").fill("2030-09-02T09:00"); pg.locator("#bkdel").click()
                check(pg.locator("#bkadd").is_visible(), "after Remove, + Backup brings it back")
            pg.locator("#go").click()
            pg.wait_for_url("**/squadup/a/**"); pg.wait_for_load_state("networkidle")
            return pg.locator(".bubble.opt").count()
        check(post_plan("No backup", False) == 1, "leaving the backup blank posts just one time")
        check(post_plan("Backup removed", True) == 1, "filling in a backup then removing it posts just one time")
        home_btn = pg.locator("header a.homebtn")
        check(home_btn.count() == 1 and "Home" in home_btn.inner_text(), "plan pages have a Home button up top")
        home_btn.click(); pg.wait_for_url("**/squadup/p/**"); pg.wait_for_load_state("networkidle")
        check(pg.locator("header a.homebtn").count() == 0, "it goes home, where it isn't needed")
        pg.goto(f"{H}/squadup/past?t={gin['token']}")
        check(pg.locator("header a.homebtn").count() == 1, "Past plans has it too")
        pg.goto(f"{H}/squadup/new?t={gin['token']}")
        pg.wait_for_load_state("networkidle")
        pg.screenshot(path=SHOTS+"newform.png")
        check(not errs, "no JS errors: "+str(errs[:2]))

        print("\n=== invites ===")
        errs.clear()
        CT = api("/squadup/api/activity", {"token":gin["token"],"title":"Catan","location":"Gin's",
              "tag_name":"Board games","primary":"2030-08-01T19:00","backup":"2030-08-02T19:00"})["id"]
        api("/squadup/api/signup", {"name":"Will","email":"w@t.test"})
        pg.goto(f"{H}/squadup/a/{CT}?t={gin['token']}")
        pg.wait_for_load_state("networkidle")
        pg.locator("#inviteopen").click()
        check(pg.locator("#invitebox").is_visible(), "Invite people opens the picker")
        check(pg.locator("#invitesend").is_disabled(), "the send button waits until you pick someone")
        pg.locator("[data-invitee]", has_text="Danielle").click()
        pg.locator("[data-invitee]", has_text="Will").click()
        check(pg.locator("#invitesend").inner_text() == "Send 2 invites", "the button counts who you picked")
        # these test accounts never confirmed their email, so nothing can reach them yet
        check("Sends nothing now. 2 can't be messaged" in pg.locator("#invnote").inner_text(),
              "and says exactly what goes out, including who can't be reached")
        pg.locator("#invitebox").scroll_into_view_if_needed()
        pg.screenshot(path=SHOTS+"squad-up-invite-send.png", full_page=False)
        pg.locator("#invitesend").click()
        pg.wait_for_url("**invited=**"); pg.wait_for_load_state("networkidle")
        check("Invited 2." in pg.content(), "it confirms")
        check(pg.locator(".person", has_text="Danielle").count() == 1 and pg.locator(".person", has_text="Will").count() == 1,
              "both show under Invited")
        check(pg.locator("[data-invitee]", has_text="Danielle").count() == 0, "and they drop out of the picker")
        check(not errs, "no JS errors inviting: "+str(errs[:2]))
        errs.clear()
        pg.goto(f"{H}/squadup/a/{CT}?t={gin['token']}")
        pg.wait_for_load_state("networkidle")
        check(pg.locator("#newopen").count() == 0 and pg.locator("#nphone").count() == 0,
              "there's no form for typing in someone else's phone or email any more")
        check(pg.locator("#shareurl").inner_text() == f"{H}/squadup/a/{CT}", "instead there's the plan's public link")
        pg.context.grant_permissions(["clipboard-read", "clipboard-write"])
        pg.locator("#copy").click(); pg.wait_for_timeout(300)
        check("Copied" in pg.locator("#cmsg").inner_text() or "Selected" in pg.locator("#cmsg").inner_text(),
              "Copy link copies it")
        api("/squadup/api/reply", {"token":em["token"],"activity_id":CT,"do":"all"})
        pg.goto(f"{H}/squadup/a/{CT}?t={gin['token']}#invited")
        pg.wait_for_load_state("networkidle")
        pg.locator("#invited").scroll_into_view_if_needed()
        pg.screenshot(path=SHOTS+"squad-up-invite-box.png", full_page=False)
        check(not errs, "no JS errors in the invite box: "+str(errs[:2]))

        print("\n=== filling in for others on a plan ===")
        errs.clear()
        pg.goto(f"{H}/squadup/a/{CT}?t={gin['token']}"); pg.wait_for_load_state("networkidle")
        mine_before = pg.locator("[data-vote].on").count()
        pg.locator("#pname").fill("Sebastian"); pg.locator("#padd").click(); pg.wait_for_timeout(900)
        if pg.locator("#pclaim [data-pick]").count(): pg.locator("#pclaim [data-pick]").first.click(); pg.wait_for_timeout(900)
        check(pg.locator("#proxy").is_visible() and pg.locator("[data-vote].on").count() == 0,
              "+ Add starts a blank answer for Sebastian")
        pg.locator("[data-vote]").nth(1).click(); pg.wait_for_timeout(1500)
        check("Sebastian" in pg.locator("#opts").inner_text() and pg.locator("#guestlist [data-edit]", has_text="Sebastian").count() == 1,
              "tapping a time saves it for him")
        pg.screenshot(path=SHOTS+"squad-up-plan-fill-in.png", full_page=False)
        pg.locator("#proxydone").click(); pg.wait_for_timeout(400)
        check(pg.locator("[data-vote].on").count() == mine_before, "Done goes back to the organizer's own times")
        pg.locator("#guestlist [data-edit]", has_text="Sebastian").click()
        pg.locator("#cant").click(); pg.wait_for_timeout(900)
        check("Can't make it: Sebastian" in pg.locator("#opts").inner_text() and pg.locator("#cant").inner_text() == "They're out",
              "Can't make it works for him too")
        pg.locator("#proxydone").click(); pg.wait_for_timeout(300)
        pg.reload(); pg.wait_for_load_state("networkidle")
        ans = json.loads(pg.locator("#answersjson").inner_text())
        check(any(x["name"] == "Sebastian" and x["guest"] and not x["can_make_it"] for x in ans), "and it's saved")
        check(not errs, "no JS errors filling in on a plan: "+str(errs[:2]))

        print("\n=== edit your info, and the header ===")
        errs.clear()
        pg.goto(f"{H}/squadup/p/{gin['token']}"); pg.wait_for_load_state("networkidle")
        check("with Gin" in pg.locator("header .brand").inner_text(), "the header reads Squad Up with Gin")
        check(not pg.locator(".acctmenu").is_visible(), "the account menu starts closed")
        pg.locator("details.acct summary").click(); pg.wait_for_timeout(200)
        check(pg.locator(".acctmenu").is_visible() and "Gin" in pg.locator(".acctwho").inner_text(), "tapping your initial opens your menu")
        pg.screenshot(path=SHOTS+"squad-up-menu.png", full_page=False)
        pg.locator("main h1").click(); pg.wait_for_timeout(200)
        check(not pg.locator(".acctmenu").is_visible(), "tapping elsewhere closes it")
        pg.locator("details.acct summary").click(); pg.locator(".acctmenu a", has_text="Squad members").click()
        pg.wait_for_load_state("networkidle")
        check("/squadup/members" in pg.url and pg.locator("details.mem").count() >= 2, "Squad members lists everyone")
        pg.locator("details.mem", has_text="Danielle").locator("summary").click(); pg.wait_for_timeout(200)
        check(pg.locator("details.mem", has_text="Danielle").locator(".chip", has_text="Kayaking").is_visible(),
              "tapping a name shows what they're into")
        pg.screenshot(path=SHOTS+"squad-up-members.png", full_page=False)
        pg.locator("details.acct summary").click(); pg.locator(".acctmenu a", has_text="Your account").click()
        pg.wait_for_load_state("networkidle")
        check("/squadup/account" in pg.url, "Your account opens from the menu")
        pg.locator("#meopen").click()
        check(pg.locator("#mebox").is_visible() and pg.locator("#mname").input_value() == "Gin", "Edit your info opens, filled in")
        check(not pg.locator("#msmsrow").is_visible(), "no Text me box until a new number is typed")
        pg.locator("#mphone").fill("239 555 0177")
        check(pg.locator("#msmsrow").is_visible() and not pg.locator("#msms").is_checked(), "a new number shows the unchecked Text me box")
        pg.screenshot(path=SHOTS+"editinfo.png", full_page=False)
        pg.locator("#mname").fill("Gin Z")
        pg.locator("#mesave").click(); pg.wait_for_timeout(500)
        check("Text me" in pg.locator("#memsg").inner_text(), "saving a new number without the box is refused")
        pg.locator("#msms").check(); pg.locator("#mesave").click()
        pg.wait_for_load_state("networkidle"); pg.wait_for_timeout(600)
        check("Gin Z" in pg.locator("main h1").first.inner_text(), "after saving, the page shows the new name")
        people = json.load(open("/tmp/squad_btest.json"))["people"]
        check(any(x["name"] == "Gin Z" and x["phone"] == "+12395550177" for x in people), "and it's saved")
        pg.screenshot(path=SHOTS+"header.png", full_page=False)
        check(not errs, "no JS errors editing info: "+str(errs[:2]))

        print("\n=== join page, terms and privacy ===")
        errs.clear()
        pj = b.new_page(viewport={"width":400,"height":900})
        pj.on("pageerror", lambda e: errs.append(str(e)))
        pj.goto(f"{H}/squadup/join"); pj.wait_for_load_state("networkidle")
        check(pj.locator("#uagree").count()==1 and pj.locator("#usms").count()==1 and pj.locator("#updbox").is_visible(),
              "the join page opens straight to the form, with both checkboxes")
        check(not pj.locator("#uagree").is_checked() and not pj.locator("#usms").is_checked(), "neither is pre-checked")
        txt = pj.locator(".consent").inner_text()
        check("Text me about Squad Up plans I'm invited to" in txt and "invites, times, confirmations, reminders" in txt,
              "the text box says exactly what the texts are")
        check("msg & data rates may apply" in txt and "HELP" in txt and "STOP" in txt and "Msg frequency varies" in txt,
              "the consent text has rates, HELP, STOP and frequency")
        check(pj.locator(".consent a[href='/squadup/terms']").count()==1 and pj.locator(".consent a[href='/squadup/privacy']").count()==1,
              "and links to the Terms and Privacy Policy")
        pj.screenshot(path=SHOTS+"join-consent.png", full_page=True)
        pj.goto(f"{H}/squadup/terms"); pj.wait_for_load_state("networkidle")
        check("Terms of Service" in pj.locator("h1").inner_text(), "the Terms page opens without a login")
        pj.screenshot(path=SHOTS+"terms.png", full_page=False)
        pj.goto(f"{H}/squadup/privacy"); pj.wait_for_load_state("networkidle")
        check("Privacy Policy" in pj.locator("h1").inner_text(), "the Privacy page opens without a login")
        check(pj.locator("footer.legal a").count()==3, "pages carry a Terms / Privacy / Contact footer")
        check(not errs, "no JS errors on the join or legal pages: "+str(errs[:2]))

        print("\n=== find a time ===")
        errs.clear()
        pg.goto(f"{H}/squadup/p/{gin['token']}")
        pg.locator("a.pill.go", has_text="New plan").click()
        pg.wait_for_load_state("networkidle")
        check("Find a time" in pg.content(), "+ New plan shows the chooser")
        pg.screenshot(path=SHOTS+"chooser.png", full_page=True)
        pg.locator("a.choice", has_text="Find a time").click()
        pg.wait_for_load_state("networkidle")
        pg.locator("#title").fill("Trivia night")
        pg.locator("#loc").fill("The Pub")
        pg.locator("[data-cal=next]").first.click()
        days = pg.locator("#cal [data-day]:not([disabled])")
        for i in (2, 4, 9):
            days.nth(i).click()
        check(pg.locator(".slot").count() == 3, "tapping days lists them below the calendar")
        pg.locator(".slot input").nth(0).fill("19:30")
        pg.locator(".slot [data-more]").nth(1).click()
        check(pg.locator(".slot").count() == 4, "+ time adds a second time on the same day")
        pg.locator(".slot input").nth(2).fill("12:00")
        pg.screenshot(path=SHOTS+"findform.png", full_page=True)
        pg.locator("#go").click()
        pg.wait_for_url("**/squadup/f/**"); pg.wait_for_load_state("networkidle")
        poll_url = pg.locator("#shareurl").inner_text()
        check("/squadup/f/" in poll_url and pg.locator("#copy").is_visible(), "making it shows the link to share")
        check(pg.locator(".opt").count() == 4, "with all four dates")
        check(not errs, "no JS errors making a poll: "+str(errs[:2]))

        guest = b.new_context(viewport={"width":390,"height":844})
        gp = guest.new_page()
        gerrs=[]
        gp.on("pageerror", lambda e: gerrs.append(str(e)))
        gp.goto(poll_url.replace("http://127.0.0.1:3901", H)); gp.wait_for_load_state("networkidle")
        check(gp.locator("[data-pick]").count() == 0 and gp.locator("#ujoin").is_visible(),
              "someone opening the poll link sees the welcome screen first, before any dates")
        gp.screenshot(path=SHOTS+"squad-up-welcome-poll.png", full_page=True)
        gp.locator("#guestopen").click()
        gp.locator("#gname").fill("Kayla")
        gp.locator("#gguest").click()
        gp.wait_for_load_state("networkidle"); gp.wait_for_timeout(400)
        check("Answering as Kayla" in gp.locator(".guestbar").inner_text(), "then it says who's answering")
        gp.evaluate("window.__noReload = 1")
        gp.locator("[data-pick]").nth(0).click()
        gp.locator("[data-pick]").nth(2).click()
        gp.locator("[data-maybe]").nth(1).click()
        check(gp.locator("[data-pick].on").count() == 2 and gp.locator("[data-maybe].on").count() == 1,
              "three quick taps on the dates all light up at once")
        gp.wait_for_timeout(1800)
        check(gp.evaluate("window.__noReload") == 1 and "Kayla" in gp.locator("#pollopts").inner_text(), "they save and the counts update with no reload")
        gp.reload(); gp.wait_for_load_state("networkidle")
        check(gp.locator("[data-maybe].on").count() == 1 and "if need be" in gp.content(), "If need be saves and shows")
        on = gp.locator("[data-pick].on")
        check(on.count() == 2 and "Kayla" in gp.content(), "their picks stick after a reload, on the same phone")
        gp.screenshot(path=SHOTS+"pollguest.png", full_page=True)
        gp.goto(f"{H}/squadup"); gp.wait_for_load_state("networkidle")
        check("You're here as a guest" in gp.content() and gp.locator("a.bubble.poll").count() >= 1,
              "the front door shows a guest what's going on, including the poll")
        gp.screenshot(path=SHOTS+"squad-up-guest-home.png", full_page=True)
        check(not gerrs, "no JS errors for a guest: "+str(gerrs[:2]))
        guest.close()

        # Kayla again, on a new phone: "Are you Kayla?"
        guest = b.new_context(viewport={"width":390,"height":844})
        gp = guest.new_page(); gerrs=[]
        gp.on("pageerror", lambda e: gerrs.append(str(e)))
        gp.goto(poll_url.replace("http://127.0.0.1:3901", H)); gp.wait_for_load_state("networkidle")
        gp.locator("#guestopen").click(); gp.locator("#gname").fill("kayla"); gp.locator("#gguest").click(); gp.wait_for_timeout(700)
        check(gp.locator("#claim").is_visible() and "Are you" in gp.locator("#claim").inner_text(),
              "typing a name that's already answered asks \"Are you Kayla?\"")
        gp.screenshot(path=SHOTS+"squad-up-returning.png", full_page=False)
        gp.locator("[data-claim]").click(); gp.wait_for_load_state("networkidle"); gp.wait_for_timeout(500)
        check("Answering as Kayla" in gp.locator(".guestbar").inner_text() and gp.locator("[data-pick].on").count() == 2,
              "\"Yes, that's me\" loads her answers")
        gp.locator("[data-pick]").nth(1).click(); gp.wait_for_timeout(1500)
        gp.reload(); gp.wait_for_load_state("networkidle")
        check(gp.locator("[data-pick].on").count() == 3, "and she can change them from the new phone")
        gp.locator(".guestbar a", has_text="Not you?").click(); gp.wait_for_load_state("networkidle"); gp.wait_for_timeout(400)
        check(gp.locator("#ujoin").is_visible(), "Not you? logs out and goes back to the welcome screen")
        gp.locator("#guestopen").click(); gp.locator("#gname").fill("Kayla"); gp.locator("#gguest").click(); gp.wait_for_timeout(700)
        gp.locator("#claim [data-other]").click()
        check(gp.locator("#gname").input_value().strip() == "Kayla" and "last initial" in gp.locator("#gmsg").inner_text(),
              "\"No, I'm someone else\" asks for a last initial")
        gp.locator("#gguest").click()
        check("last initial" in gp.locator("#gmsg").inner_text() and not gp.locator("#claim").is_visible(),
              "and won't take the same name again")
        gp.locator("#gname").fill("Kayla M."); gp.locator("#gguest").click()
        gp.wait_for_load_state("networkidle"); gp.wait_for_timeout(400)
        check("Answering as Kayla M." in gp.locator(".guestbar").inner_text(), "Kayla M. answers as a new person")
        gp.locator("[data-pick]").nth(3).click(); gp.wait_for_timeout(1500)
        check(not gerrs, "no JS errors for a returning guest: "+str(gerrs[:2]))
        guest.close()

        # the organizer fills in for someone who texted
        errs.clear()
        pg.reload(); pg.wait_for_load_state("networkidle")
        check(pg.locator("#others").is_visible() and pg.locator("#guestlist [data-edit]").count() == 2,
              "the organizer sees Fill in for others, with the guests")
        pg.locator("#pname").fill("Sebastian"); pg.locator("#padd").click(); pg.wait_for_timeout(900)
        if pg.locator("#pclaim [data-pick]").count(): pg.locator("#pclaim [data-pick]").first.click(); pg.wait_for_timeout(900)
        check(pg.locator("#proxy").is_visible() and pg.locator("#proxyname").inner_text() == "Sebastian",
              "+ Add shows who they're filling in for")
        pg.locator("[data-pick]").nth(0).click(); pg.locator("[data-maybe]").nth(2).click()
        pg.wait_for_timeout(1500)
        check(pg.locator("#guestlist [data-edit]", has_text="Sebastian").count() == 1 and "Sebastian" in pg.locator("#pollopts").inner_text(),
              "his dates save and he joins the list")
        pg.screenshot(path=SHOTS+"squad-up-fill-in.png", full_page=False)
        pg.locator("#proxydone").click(); pg.wait_for_timeout(300)
        check(not pg.locator("#proxy").is_visible() and pg.locator("[data-pick].on").count() == 0,
              "Done goes back to the organizer's own answers")
        pg.locator("#guestlist [data-edit]", has_text="Sebastian").click()
        check(pg.locator("[data-pick].on").count() == 1 and pg.locator("[data-maybe].on").count() == 1, "tapping his name loads his dates")
        pg.locator("[data-pick]").nth(1).click(); pg.locator("#proxydone").click(); pg.wait_for_timeout(800)
        pg.reload(); pg.wait_for_load_state("networkidle")
        PID = poll_url.rstrip("/").split("/f/")[1].split("?")[0]
        sebs = [v for v in json.loads(pg.locator("#votesjson").inner_text()) if v["name"] == "Sebastian"]
        check(len(sebs) == 1 and len(sebs[0]["option_ids"]) == 2, "Done saves the last change before switching back")

        # a long list folds up and opens
        for n in ["Ana", "Bo", "Cy", "Dee", "Eli", "Fay"]:
            api("/squadup/api/poll-guest", {"token":gin["token"],"poll_id":PID,"name":n,"option_ids":[sebs[0]["option_ids"][0]]})
        pg.reload(); pg.wait_for_load_state("networkidle")
        more = pg.locator("[data-expand]").first
        check(more.is_visible() and more.inner_text().startswith("+") and not pg.locator(".rest").first.is_visible(),
              "a date with lots of names shows \"+N\"")
        more.click()
        check(pg.locator(".rest").first.is_visible() and more.inner_text() == "less", "tapping it shows everyone")
        pg.screenshot(path=SHOTS+"squad-up-names-open.png", full_page=False)
        more.click()
        check(not pg.locator(".rest").first.is_visible() and more.inner_text().startswith("+"), "and tapping again folds it back")
        check(not errs, "no JS errors filling in for others: "+str(errs[:2]))

        errs.clear()
        pg.reload(); pg.wait_for_load_state("networkidle")
        pg.locator("a.pill", has_text="Edit").first.click()
        pg.wait_for_load_state("networkidle")
        check(pg.locator(".erow").count() == 4, "Edit lists every date")
        pg.locator(".erow [data-f=time]").nth(0).fill("20:00")
        pg.once("dialog", lambda d: d.accept())
        pg.locator(".erow [data-rm]").nth(3).click()
        pg.locator("#title").fill("Trivia night!")
        pg.screenshot(path=SHOTS+"polledit.png", full_page=True)
        pg.locator("#go").click()
        pg.wait_for_url("**saved=1**"); pg.wait_for_load_state("networkidle")
        body = pg.content()
        check("Trivia night!" in body and "8pm" in body and pg.locator(".opt").count() == 3,
              "saving the edit renames, moves the time, and drops the removed date")
        check("Kayla" in body, "and Kayla's answers stayed on the moved date")
        pg.locator("#inviteopen").click()
        pg.locator("[data-invitee]", has_text="Danielle").click()
        pg.locator("#invitesend").click()
        pg.wait_for_url("**invited=1**"); pg.wait_for_load_state("networkidle")
        check(pg.locator(".person", has_text="Danielle").count() == 1, "the invite picker works on a poll")
        check(not errs, "no JS errors editing and inviting: "+str(errs[:2]))
        pg.screenshot(path=SHOTS+"pollorganizer.png", full_page=True)
        pg.locator(".opt.plan a", has_text="Make it the plan").first.click()
        pg.wait_for_load_state("networkidle")
        check("Make it a plan" in pg.content(), "Make it the plan opens the plan form, filled in")
        pg.locator("#tag").select_option("__new")
        pg.locator("#tagname").fill("Trivia")
        pg.locator("#go").click()
        pg.wait_for_url("**/squadup/a/**"); pg.wait_for_load_state("networkidle")
        check("Trivia night" in pg.content(), "and posting it makes the plan")
        check(not errs, "no JS errors making it a plan: "+str(errs[:2]))

        print("\n=== v1.1: tidying guests, calendars, time zones, accounts ===")
        errs.clear()
        pg.set_viewport_size({"width":400,"height":860})
        pg.goto(f"{H}/squadup/a/{CT}?t={gin['token']}"); pg.wait_for_load_state("networkidle")
        pg.locator("#pname").fill("Robin"); pg.locator("#padd").click(); pg.wait_for_timeout(900)
        check(pg.locator("#proxy").is_visible() and pg.locator("#proxytools").is_visible(),
              "adding a guest shows Rename and Same person as… in the bar")
        pg.locator("[data-vote]").nth(0).click(); pg.wait_for_timeout(1500)
        pg.once("dialog", lambda d: d.accept("Robin K."))
        pg.locator("#prename").click(); pg.wait_for_timeout(1300)
        check(pg.locator("#proxyname").inner_text() == "Robin K." and pg.locator("#guestlist .gchip", has_text="Robin K.").count() == 1,
              "Rename fixes the name")
        check(pg.locator("#opts .gname", has_text="Robin").count() >= 1, "guest names show in navy italics on the plan")
        pg.screenshot(path=SHOTS+"squad-up-guest-tools.png", full_page=False)
        pg.locator("#pmergeopen").click()
        pg.locator("#pmergeinto").select_option(label="Danielle")
        pg.once("dialog", lambda d: d.accept())
        pg.locator("#pmergego").click(); pg.wait_for_load_state("networkidle"); pg.wait_for_timeout(900)
        check(pg.locator("#guestlist", has_text="Robin").count() == 0, "Same person as… merges them into the real person")
        pg.locator("#pname").fill("Lee"); pg.locator("#padd").click(); pg.wait_for_timeout(900)
        pg.locator("#proxydone").click(); pg.wait_for_timeout(400)
        pg.once("dialog", lambda d: d.accept())
        pg.locator(".gchip-w", has_text="Lee").locator("[data-remove]").click(); pg.wait_for_timeout(1200)
        check(pg.locator(".gchip-w", has_text="Lee").count() == 0, "× takes a guest off the plan")
        pg.locator("#calopen").click()
        check(pg.locator("#calmenu").is_visible() and pg.locator("#calmenu a", has_text="Google").count() == 1,
              "Add to calendar offers Apple / Outlook and Google")
        pg.locator(".title-row").scroll_into_view_if_needed()
        pg.screenshot(path=SHOTS+"squad-up-calendar.png", full_page=False)
        check(not errs, "no JS errors tidying guests: "+str(errs[:2]))

        # adding several people back to back, no waiting
        errs.clear()
        pg.goto(f"{H}/squadup/a/{CT}?t={gin['token']}"); pg.wait_for_load_state("networkidle")
        pg.evaluate("window.__noReload = 1")
        t0 = time.time()
        quick_ok = True
        for n, i in [("Ava", 0), ("Ben", 1), ("Cal", 0)]:
            pg.locator("#pname").fill(n); pg.locator("#pname").press("Enter")
            quick_ok = quick_ok and pg.locator("#proxyname").inner_text() == n
            pg.locator("[data-vote]").nth(i).click()
        pg.locator("#proxydone").click()
        took = time.time() - t0
        check(quick_ok and took < 2.5, f"+ Add switches people instantly, three in a row ({took:.1f}s)")
        pg.wait_for_timeout(3000)
        ans = {x["name"]: x for x in json.loads(pg.locator("#answersjson").inner_text())}
        check(all(n in ans and len(ans[n]["option_ids"]) == 1 for n in ["Ava", "Ben", "Cal"]), "and every one of them saves in the background")
        check(pg.evaluate("window.__noReload") == 1 and pg.locator("#guestlist .gchip", has_text="Ben").count() == 1,
              "without reloading the page")
        pg.locator(".gchip", has_text="Ava").click()
        check(pg.locator("[data-vote].on").count() == 1 and pg.locator("#proxyname").inner_text() == "Ava", "tapping a name brings their times right back")
        pg.locator("[data-vote]").nth(1).click(); pg.locator(".gchip", has_text="Ben").click(); pg.locator("[data-vote]").nth(0).click()
        pg.locator("#proxydone").click(); pg.wait_for_timeout(3000)
        ans = {x["name"]: x for x in json.loads(pg.locator("#answersjson").inner_text())}
        check(len(ans["Ava"]["option_ids"]) == 2 and len(ans["Ben"]["option_ids"]) == 2, "quick changes for two people both stick")
        check(not errs, "no JS errors filling in quickly: "+str(errs[:2]))
        QP = api("/squadup/api/poll", {"token": gin["token"], "title": "Bowling", "tag_name": "Bowling",
                 "options": [{"day": "2030-09-01"}, {"day": "2030-09-02"}]})["id"]
        pg.goto(f"{H}/squadup/f/{QP}?t={gin['token']}"); pg.wait_for_load_state("networkidle")
        pg.evaluate("window.__noReload = 1")
        t0 = time.time()
        for n, i in [("Dot", 0), ("Eve", 1), ("Fin", 0)]:
            pg.locator("#pname").fill(n); pg.locator("#pname").press("Enter")
            pg.locator("[data-pick]").nth(i).click()
        pg.locator("[data-maybe]").nth(1).click()
        pg.locator("#proxydone").click()
        took = time.time() - t0
        pg.wait_for_timeout(3000)
        vs = {v["name"]: v for v in json.loads(pg.locator("#votesjson").inner_text())}
        check(took < 2.5 and all(n in vs for n in ["Dot", "Eve", "Fin"]) and len(vs["Fin"]["option_ids"]) == 1 and len(vs["Fin"]["maybe_ids"]) == 1,
              f"the same on a poll: three names, no waiting, all saved ({took:.1f}s)")
        check(not errs, "no JS errors filling in a poll quickly: "+str(errs[:2]))

        # someone in another time zone
        den = b.new_context(viewport={"width":400,"height":860}, timezone_id="America/Denver")
        dp = den.new_page(); derrs=[]
        dp.on("pageerror", lambda e: derrs.append(str(e)))
        dp.goto(f"{H}/squadup/a/{A}?t={em['token']}"); dp.wait_for_load_state("networkidle")
        check("4pm your time" in dp.locator("#opts").inner_text(), "someone in Denver sees their own time next to it")
        dp.screenshot(path=SHOTS+"squad-up-your-time.png", full_page=False)
        dp.goto(f"{H}/squadup/new?t={em['token']}"); dp.wait_for_load_state("networkidle")
        check(dp.locator("#tzsel").is_visible() and dp.locator("#tzsel option").count() == 2,
              "making a plan from another zone asks which zone the times are in")
        dp.locator("#title").fill("Ski trip"); dp.locator("#tag").select_option("__new"); dp.locator("#tagname").fill("Skiing")
        dp.locator("#p1").fill("2030-01-12T09:00")
        dp.locator("#tzsel").select_option(index=1)
        dp.locator("#go").click(); dp.wait_for_url("**/squadup/a/**"); dp.wait_for_load_state("networkidle")
        ski = dp.url.split("/squadup/a/")[1].split("?")[0]
        check(any(a["id"] == ski and a["timezone"] == "America/Denver" for a in json.load(open("/tmp/squad_btest.json"))["activities"]),
              "picking their phone's zone saves it with the plan")
        check("MST" in dp.locator("#opts").inner_text() and "your time" not in dp.locator("#opts").inner_text(),
              "the plan shows its zone, and no conversion for someone already in it")
        check(not derrs, "no JS errors across time zones: "+str(derrs[:2]))
        den.close()

        # the welcome screen knows names from anywhere in the squad
        st = b.new_context(viewport={"width":390,"height":844}); sp = st.new_page(); serrs=[]
        sp.on("pageerror", lambda e: serrs.append(str(e)))
        sp.goto(f"{H}/squadup/a/{A}"); sp.wait_for_load_state("networkidle")
        sp.locator("#guestopen").click(); sp.locator("#gname").fill("Kayla"); sp.locator("#gguest").click(); sp.wait_for_timeout(700)
        check("Are you" in sp.locator("#claim").inner_text(), "a guest from a poll is recognized on a plan link too")
        sp.locator("[data-claim]").click(); sp.wait_for_load_state("networkidle"); sp.wait_for_timeout(500)
        check("Answering as Kayla" in sp.locator(".guestbar").inner_text(), "and \"Yes, that's me\" picks them up")
        api("/squadup/api/tag-new", {"token": em["token"], "name": "Beach bonfire"})
        sp.goto(f"{H}/squadup"); sp.wait_for_load_state("networkidle")
        idea = sp.locator(".act", has_text="Beach bonfire")
        check(idea.count() == 1 and idea.locator("[data-int]").count() == 1 and idea.locator("a.pill", has_text="Schedule it").count() == 0
              and idea.locator("[data-bell]").count() == 0, "a guest's home has Activities, with I'm interested (no Schedule it, no bell)")
        idea.locator("[data-int]").click(); sp.wait_for_load_state("networkidle"); sp.wait_for_timeout(700)
        idea = sp.locator(".act", has_text="Beach bonfire"); idea.locator("summary").click()
        check(idea.locator(".gname", has_text="Kayla").count() >= 1, "and their name goes on in navy italics")
        check(sp.locator("details.acct .avatar.guest").count() == 1, "a guest's menu icon is navy italics too")
        idea.scroll_into_view_if_needed()
        sp.screenshot(path=SHOTS+"squad-up-guest-activities.png", full_page=False)
        check(not serrs, "no JS errors for a returning guest: "+str(serrs[:2]))
        st.close()

        # joining with a name a guest already used
        jn = b.new_context(viewport={"width":390,"height":844}); jp = jn.new_page(); jerrs=[]
        jp.on("pageerror", lambda e: jerrs.append(str(e)))
        jp.goto(f"{H}/squadup/a/{CT}"); jp.wait_for_load_state("networkidle")
        jp.locator("#uname").fill("Sebastian"); jp.locator("#uemail").fill("seb@t.test"); jp.locator("#uagree").check()
        jp.locator("#ujoin").click(); jp.wait_for_timeout(800)
        check(jp.locator("#uclaim").is_visible() and "Yes, I'm Sebastian" in jp.locator("#uclaim").inner_text(),
              "joining with a guest's name asks if that's them")
        jp.locator("#uclaim").scroll_into_view_if_needed(); jp.evaluate("window.scrollBy(0,120)")
        jp.screenshot(path=SHOTS+"squad-up-join-claim.png", full_page=False)
        jp.locator("[data-uclaim]").click(); jp.wait_for_load_state("networkidle"); jp.wait_for_timeout(800)
        check(f"/squadup/a/{CT}" in jp.url and jp.locator(".guestbar").count() == 0, "yes makes the account and goes back to the plan")
        jp.goto(f"{H}/squadup"); jp.wait_for_load_state("networkidle")
        check(jp.locator("#confirmbox").is_visible() and "Confirm your email" in jp.locator("#confirmbox").inner_text(),
              "an email-only account is asked to confirm its email")
        jp.locator("#resend").click(); jp.wait_for_timeout(600)
        check("Sent" in jp.locator("#cmsg2").inner_text(), "Send it again works")
        jp.goto(f"{H}/squadup/account"); jp.wait_for_load_state("networkidle")
        jp.locator("#delopen").click()
        check(jp.locator("#delbox").is_visible() and "Delete your account?" in jp.locator("#delbox").inner_text(), "Delete my account asks first")
        jp.screenshot(path=SHOTS+"squad-up-delete.png", full_page=False)
        jp.locator("#delgo").click(); jp.wait_for_load_state("networkidle"); jp.wait_for_timeout(900)
        check(jp.locator("#ujoin").count() == 1 and not any(x["name"] == "Sebastian" and x.get("email") for x in json.load(open("/tmp/squad_btest.json"))["people"]),
              "deleting lands back on the welcome screen, account gone")
        check(not jerrs, "no JS errors joining and deleting: "+str(jerrs[:2]))
        jn.close()

        # log out everywhere else
        errs.clear()
        pg.goto(f"{H}/squadup/account?t={gin['token']}"); pg.wait_for_load_state("networkidle")
        pg.locator(".account-x").scroll_into_view_if_needed()
        pg.screenshot(path=SHOTS+"squad-up-account.png", full_page=False)
        pg.once("dialog", lambda d: d.accept())
        pg.locator("#reset").click(); pg.wait_for_timeout(700)
        check("logged out" in pg.locator("#resetmsg").inner_text(), "Log out of all other devices confirms it's done")
        pg.reload(); pg.wait_for_load_state("networkidle")
        check(pg.locator("#reset").count() == 1, "and this browser is still logged in")
        check(not errs, "no JS errors on the account controls: "+str(errs[:2]))

        print("\n=== tapping down the Activities list (no reloads) ===")
        lm = api("/squadup/api/signup", {"name": "Lister", "email": "lister@t.test"})
        mk = api("/squadup/api/signup", {"name": "Maker", "email": "maker@t.test"})
        for n in ["Archery", "Bocce", "Canoeing", "Darts", "Euchre", "Fencing", "Golf", "Hula hoop"]:
            api("/squadup/api/tag-new", {"token": mk["token"], "name": n})
        lc2 = b.new_context(viewport={"width": 390, "height": 700})
        lp2 = lc2.new_page(); lerrs = []
        lp2.on("pageerror", lambda e: lerrs.append(str(e)))
        lp2.goto(f"{H}/squadup/p/{lm['token']}"); lp2.wait_for_load_state("networkidle")
        if lp2.locator("#tourskip").count(): lp2.locator("#tourskip").click(); lp2.wait_for_timeout(400)
        lp2.evaluate("window.__noReload = 1")
        names = ["Archery", "Bocce", "Canoeing", "Darts", "Euchre", "Fencing"]
        lp2.locator(".act", has_text="Archery").scroll_into_view_if_needed()
        y0 = None
        for n in names:
            btn = lp2.locator(".act", has_text=n).locator("[data-int]")
            btn.scroll_into_view_if_needed()
            if y0 is None: y0 = lp2.evaluate("scrollY")
            btn.click()
        check(all("Interested" in lp2.locator(".act", has_text=n).locator("[data-int]").inner_text() for n in names),
              "six quick taps all show Interested right away")
        y1 = lp2.evaluate("scrollY")
        lp2.wait_for_timeout(2500)
        check(lp2.evaluate("window.__noReload") == 1, "the page never reloads while tapping down the list")
        y2 = lp2.evaluate("scrollY")
        check(abs(y2 - y1) < 40, f"and it stays where you are ({y1:.0f} -> {y2:.0f})")
        dbj = json.load(open("/tmp/squad_btest.json"))
        lid = [x for x in dbj["people"] if x["name"] == "Lister"][0]["id"]
        tid = {t["name"]: t["id"] for t in dbj["tags"]}
        mine = {x["tag_id"] for x in dbj["subscriptions"] if x["person_id"] == lid}
        check(all(tid[n] in mine for n in names), "all six are saved")
        check(lp2.locator(".act", has_text="Archery").locator("[data-bell]").count() == 1
              and "Lister" in lp2.locator(".act", has_text="Archery").locator("details.actwho").text_content(),
              "each card fills in from the save: the bell, and your name on its list")
        # change your mind fast: on, off, on, off on one; off on two others
        arc = lambda: lp2.locator(".act", has_text="Archery").locator("[data-int]")
        for _ in range(3): arc().click(); lp2.wait_for_timeout(60)
        lp2.locator(".act", has_text="Bocce").locator("[data-int]").click()
        lp2.locator(".act", has_text="Canoeing").locator("[data-int]").click()
        lp2.wait_for_timeout(2500)
        dbj = json.load(open("/tmp/squad_btest.json"))
        mine = {x["tag_id"] for x in dbj["subscriptions"] if x["person_id"] == lid}
        check(tid["Archery"] not in mine and tid["Bocce"] not in mine and tid["Canoeing"] not in mine and tid["Darts"] in mine,
              "quick on/off taps end up saved as the last tap")
        check("I'm interested" in arc().inner_text(), "and the button agrees with what was saved")
        # bells, quickly, down the list
        for n in ["Darts", "Euchre", "Fencing"]:
            lp2.locator(".act", has_text=n).locator("[data-bell]").click()
        lp2.wait_for_timeout(2000)
        dbj = json.load(open("/tmp/squad_btest.json"))
        muted = {x["tag_id"] for x in dbj["subscriptions"] if x["person_id"] == lid and x.get("muted")}
        check(all(tid[n] in muted for n in ["Darts", "Euchre", "Fencing"]) and lp2.evaluate("window.__noReload") == 1,
              "three bell taps in a row all save, no reload")
        check(lp2.locator(".act", has_text="Darts").locator(".bellnote").is_visible(), "each shows Messages off")
        # an open interested list stays open when the card redraws
        d = lp2.locator(".act", has_text="Golf").locator("details.actwho summary")
        if d.count():
            d.click(); lp2.locator(".act", has_text="Golf").locator("[data-int]").click(); lp2.wait_for_timeout(1500)
            check(lp2.locator(".act", has_text="Golf").locator("details.actwho").get_attribute("open") is not None,
                  "an open interested list stays open after the tap")
        lp2.locator(".act", has_text="Hula hoop").locator("[data-actedit]").count() == 0 or True
        # a page that does have to reload (approving a time, editing) comes back where you were
        lp2.evaluate("window.scrollTo(0, 1500)"); ya = lp2.evaluate("scrollY")
        lp2.evaluate("stayReload()"); lp2.wait_for_load_state("load"); lp2.wait_for_timeout(500)
        yb = lp2.evaluate("scrollY")
        check(abs(ya - yb) < 30, f"a page that reloads after a change comes back to the same spot ({ya:.0f} -> {yb:.0f})")
        check(not lerrs, "no JS errors tapping down the list: " + str(lerrs[:2]))
        lc2.close()

        print("\n=== the first-run tour (v1.5) ===")
        tu = api("/squadup/api/signup", {"name": "Tourist", "email": "tourist@t.test"})
        tc = b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        tp = tc.new_page(); terrs = []
        tp.on("pageerror", lambda e: terrs.append(str(e)))
        tp.goto(f"{H}/squadup/p/{tu['token']}"); tp.wait_for_load_state("networkidle"); tp.wait_for_timeout(700)
        card = tp.locator("#tourcard")
        check(card.is_visible(), "a new account sees the tour card on top of their home page")
        vb = tp.locator("#tourcard video").bounding_box()
        check(vb["height"] <= 844 * 0.71 and abs(vb["width"] / vb["height"] - 9 / 16) < 0.02,
              f"the video keeps its shape and stays under ~70% of the screen ({vb['width']:.0f}x{vb['height']:.0f})")
        sk = tp.locator("#tourskip").bounding_box()
        check(sk["y"] + sk["height"] <= 844, "Skip is on screen without scrolling")
        foot = tp.locator(".tourfoot").bounding_box()
        check(foot["y"] + foot["height"] <= 844, "the bottom of the card (where Got it appears) fits on screen too")
        can = tp.evaluate("document.createElement('video').canPlayType('video/mp4; codecs=\"avc1.64001f\"')")
        state = tp.evaluate("(()=>{const v=document.querySelector('#tourcard video');return {paused:v.paused, muted:v.muted, loop:v.loop, btn:!document.querySelector('#tourcard .tourplay').hidden}})()")
        check(state["muted"] and not state["loop"], "it's muted and plays once")
        tp.wait_for_timeout(3200)
        if not can:
            # this test browser has no H.264 (phones and real Chrome do): it must say so, not sit on a dead still
            check("noplay" in tp.locator("#tourcard .tour").get_attribute("class") and tp.locator("#tourcard .noplaynote").is_visible()
                  and not tp.locator("#tourcard .tourplay").is_visible(),
                  "a browser that can't play MP4 keeps the still and points to How Squad Up works")
        else:
            check(tp.evaluate("document.querySelector('#tourcard video').currentTime") > 0, "the video autoplays")
        tp.screenshot(path=SHOTS + "squad-up-tourcard.png", full_page=False)
        # the end of the video: Skip gives way to Got it, and it's marked seen
        tp.evaluate("document.querySelector('#tourcard video').dispatchEvent(new Event('ended'))")
        tp.wait_for_timeout(500)
        check(tp.locator("#tourgot").is_visible() and not tp.locator("#tourskip").is_visible(), "at the end, Skip turns into Got it")
        dbp = [x for x in json.load(open("/tmp/squad_btest.json"))["people"] if x["name"] == "Tourist"][0]
        check(dbp.get("tour") == "seen", "watching to the end marks it seen without a tap")
        tp.locator("#tourgot").click(); tp.wait_for_timeout(500)
        check(tp.locator("#tourcard").count() == 0, "Got it closes the card")
        tp.reload(); tp.wait_for_load_state("networkidle")
        check(tp.locator("#tourcard").count() == 0, "and it doesn't come back")
        check(not terrs, "no JS errors in the tour card: " + str(terrs[:2]))
        tc.close()

        # a phone in Low Power Mode refuses autoplay: the play button shows
        lc = b.new_context(viewport={"width": 390, "height": 844})
        lc.add_init_script("""HTMLMediaElement.prototype.play=function(){return Promise.reject(new DOMException('no','NotAllowedError'));};
            HTMLMediaElement.prototype.canPlayType=function(){return 'probably';};
            Object.defineProperty(HTMLMediaElement.prototype,'networkState',{get(){return 1;}});
            const ael=HTMLSourceElement.prototype.addEventListener;
            HTMLSourceElement.prototype.addEventListener=function(t,f,o){ if(t!=='error') ael.call(this,t,f,o); };""")
        lu = api("/squadup/api/signup", {"name": "Lowpower", "email": "low@t.test"})
        lp = lc.new_page()
        lp.goto(f"{H}/squadup/p/{lu['token']}"); lp.wait_for_timeout(800)
        check(lp.locator("#tourcard .tourplay").is_visible(), "when the phone won't autoplay, a play button sits on the still")
        lc.close()

        # Skip, with Reduce Motion on: no autoplay, play button instead
        tu2 = api("/squadup/api/signup", {"name": "Stillwater", "email": "still@t.test"})
        rc = b.new_context(viewport={"width": 390, "height": 844}, reduced_motion="reduce")
        rp = rc.new_page()
        rp.goto(f"{H}/squadup/p/{tu2['token']}"); rp.wait_for_load_state("networkidle"); rp.wait_for_timeout(500)
        check(rp.evaluate("document.querySelector('#tourcard video').paused") and rp.locator("#tourcard .tourplay").is_visible(),
              "with Reduce Motion on it waits on the still with a play button")
        rp.locator("#tourskip").click(); rp.wait_for_timeout(600)
        check(rp.locator("#tourcard").count() == 0, "Skip closes it")
        dbp = [x for x in json.load(open("/tmp/squad_btest.json"))["people"] if x["name"] == "Stillwater"][0]
        check(dbp.get("tour") == "seen", "and Skip marks it seen")
        rc.close()

        # How Squad Up works: phone and laptop
        hc = b.new_context(viewport={"width": 390, "height": 844})
        hp = hc.new_page(); herrs = []
        hp.on("pageerror", lambda e: herrs.append(str(e)))
        hp.goto(f"{H}/squadup/how?t={tu['token']}"); hp.wait_for_load_state("networkidle"); hp.wait_for_timeout(400)
        check(hp.evaluate("document.documentElement.scrollWidth") <= 390, "How Squad Up works fits a phone, no sideways scroll")
        check(hp.evaluate("document.querySelector('.tour video').loop"), "the help page video loops")
        check(hp.locator(".howsteps li").count() == 6, "the steps are written out beside it")
        hp.screenshot(path=SHOTS + "squad-up-how-phone.png", full_page=True)
        hp.set_viewport_size({"width": 1280, "height": 800}); hp.wait_for_timeout(300)
        vb = hp.locator(".tour video").bounding_box(); lb = hp.locator(".howsteps").bounding_box()
        check(lb["x"] > vb["x"] + vb["width"] and vb["height"] <= 800 * 0.79,
              f"on a laptop the steps sit beside the video, which stays short of the screen ({vb['height']:.0f}px tall)")
        hp.screenshot(path=SHOTS + "squad-up-how-laptop.png", full_page=False)
        hp.goto(f"{H}/squadup/p/{tu['token']}"); hp.set_viewport_size({"width": 390, "height": 844})
        hp.locator("details.acct summary").click()
        check(hp.locator(".acctmenu a", has_text="How Squad Up works").is_visible(), "the account menu has How Squad Up works")
        check(hp.locator(".howline a").count() == 1, "and so does a small line at the bottom of the home page")
        check(not herrs, "no JS errors on How Squad Up works: " + str(herrs[:2]))
        hc.close()

        # Comments (v1.6): post a few, a long link, delete one, all without reloading
        print("\n=== comments on a plan ===")
        cu = api("/squadup/api/signup", {"name": "Sebastian", "email": "seb@t.test"})
        cc = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
        cp = cc.new_page(); cerrs = []
        cp.on("pageerror", lambda e: cerrs.append(str(e)))
        cp.on("dialog", lambda d: d.accept())
        cp.goto(f"{H}/squadup/a/{A}?t={cu['token']}"); cp.wait_for_load_state("networkidle")
        cp.evaluate("window.__noReload = 1")
        check(not cp.locator("#cmtin").is_visible() and cp.locator("#comments summary").inner_text().strip() == "Comments",
              "comments start closed, as one 'Comments' line")
        cp.locator("#comments summary").click()
        try: cp.wait_for_function("document.activeElement && document.activeElement.id === 'cmtin'", timeout=2000)
        except Exception: pass
        check(cp.locator("#cmtin").is_visible() and cp.evaluate("document.activeElement.id") == "cmtin",
              "tapping it opens the box, ready to type when there's nothing yet")
        check(cp.locator("#commentlist .cmtnone").count() == 1, "an empty plan says there are no comments yet")
        box = cp.locator("#cmtin")
        box.fill("I can drive, room for 3 👍"); cp.locator("#cmtsend").click()
        cp.wait_for_selector("#commentlist .cmt")
        check(cp.locator("#commentlist .cmt").count() == 1 and box.input_value() == "", "posting adds it and clears the box")
        box.fill("Parking info: https://www.example.com/a-really-long-link-that-keeps-going-and-going/parking?lot=north&level=2")
        box.press("Control+Enter"); cp.wait_for_function("document.querySelectorAll('#commentlist .cmt').length === 2")
        check(cp.locator("#comments .cmtcount").inner_text() == "2", "the heading counts them")
        check(cp.locator(".ctext a").get_attribute("href").startswith("https://www.example.com/"), "links are tappable")
        check(cp.evaluate("document.documentElement.scrollWidth") <= 390, "a long link doesn't push the page sideways")
        check(cp.evaluate("window.__noReload") == 1, "no reload while commenting")
        # a long thread scrolls inside its own box, starting at the newest
        for i in range(12):
            box.fill(f"Message number {i+3} about the plan"); cp.locator("#cmtsend").click()
            cp.wait_for_function(f"document.querySelectorAll('#commentlist .cmt').length === {i+3}")
        sc = cp.evaluate("(() => { const l = document.getElementById('commentlist'); return [l.scrollHeight, l.clientHeight, l.scrollTop]; })()")
        check(sc[0] > sc[1] + 100 and sc[1] <= 430, f"a long thread scrolls inside its own box ({sc[1]}px tall, {sc[0]}px of comments)")
        check(sc[2] + sc[1] >= sc[0] - 2, "showing the newest at the bottom")
        cp.evaluate("document.getElementById('commentlist').scrollTop = 0")
        check(cp.locator("#commentlist .cmt").first.is_visible() or cp.evaluate("document.getElementById('commentlist').scrollTop") == 0,
              "and you can scroll all the way back to the first one")
        cp.evaluate("window.scrollTo(0, 0)"); cp.evaluate("stayReload()"); cp.wait_for_load_state("load"); cp.wait_for_timeout(400)
        check(cp.evaluate("document.getElementById('comments').open"), "after a reload the comments stay open")
        sc2 = cp.evaluate("(() => { const l = document.getElementById('commentlist'); return [l.scrollHeight, l.clientHeight, l.scrollTop]; })()")
        check(sc2[2] + sc2[1] >= sc2[0] - 2, "and start at the newest again")
        cp.evaluate("window.__noReload = 1")
        cp.evaluate("document.getElementById('commentlist').scrollTop = 0")
        cp.locator("#comments").scroll_into_view_if_needed(); cp.wait_for_timeout(200)
        cp.locator(".cmts").screenshot(path=SHOTS + "squad-up-comments-top.png")
        cp.evaluate("document.getElementById('commentlist').scrollTop = 1e6"); cp.wait_for_timeout(150)
        cp.locator(".cmts").screenshot(path=SHOTS + "squad-up-comments.png")
        cp.locator("#comments summary").click(); cp.wait_for_timeout(150)
        check(not cp.locator("#cmtin").is_visible() and "14" in cp.locator("#comments summary").inner_text(),
              "closing it again leaves 'Comments 14'")
        cp.locator("#comments").screenshot(path=SHOTS + "squad-up-comments-closed.png")
        cp.locator("#comments summary").click()
        cp.locator("[data-cdel]").last.click()
        cp.wait_for_function("document.querySelectorAll('#commentlist .cmt').length === 13")
        check(cp.locator("#comments .cmtcount").inner_text() == "13", "deleting one updates the list and the count")
        cp.goto(f"{H}/squadup/p/{cu['token']}"); cp.wait_for_load_state("networkidle")
        check(cp.locator(".row-card .cmtn").count() >= 1, "the home card shows a comment count")
        cp.locator(".row-card", has=cp.locator(".cmtn")).first.screenshot(path=SHOTS + "squad-up-comment-card.png")
        check(not cerrs, "no JS errors with comments: " + str(cerrs[:2]))
        cc.close()

        # Simplicity (v1.9): host tools and invites fold away; folds remember; tips explain
        print("\n=== folds and tips ===")
        fc = _nc(viewport={"width": 390, "height": 844}); fp = fc.new_page(); ferrs = []
        fp.on("pageerror", lambda e: ferrs.append(str(e)))
        fh = api("/squadup/api/signup", {"name": "Folder", "email": "folder@t.test"})
        fresh = api("/squadup/api/activity", {"token": fh["token"], "title": "Fold test", "tag_name": "Folds", "primary": "2031-02-02T18:00"})
        fp.goto(f"{H}/squadup/a/{fresh['id']}?t={fh['token']}"); fp.wait_for_load_state("networkidle")
        check(not fp.evaluate("document.getElementById('hosttools').open"), "Host tools starts folded")
        check(fp.evaluate("document.getElementById('invited').open"), "Invite starts open while nobody's answered")
        fp.locator("#hosttools summary").click()
        check(fp.locator("#hosttools a.pill", has_text="Edit plan").is_visible() and fp.locator("#msgopen").is_visible(),
              "Host tools has Edit plan and Message the group")
        fp.locator("#invited summary").click()
        fp.reload(); fp.wait_for_load_state("networkidle")
        check(fp.evaluate("[document.getElementById('hosttools').open, document.getElementById('invited').open]") == [True, False],
              "each fold stays the way you left it")
        check(not fp.locator("#shareurl").is_visible(), "the share link itself stays out of sight (Copy link copies it)")
        fp.locator("#others [data-tip]").click()
        check(fp.locator(".tippop").is_visible() and fp.locator(".tippop a", has_text="How Squad Up works").count() == 1,
              "an i tip opens a short note with a link to the video")
        fp.locator("h1").click()
        check(fp.locator(".tippop").count() == 0, "tapping anywhere else closes it")
        api("/squadup/api/rsvp", {"token": em["token"], "activity_id": fresh["id"], "cant": True})
        fc2 = _nc(viewport={"width": 390, "height": 844}); fp2 = fc2.new_page()
        fp2.goto(f"{H}/squadup/a/{fresh['id']}?t={fh['token']}"); fp2.wait_for_load_state("networkidle")
        check(not fp2.evaluate("document.getElementById('invited').open"), "once someone's answered, Invite starts folded")
        check("1 out" in fp2.locator(".sumrow").inner_text(), "the summary row counts who's in and out")
        check(not ferrs, "no JS errors with folds and tips: " + str(ferrs[:2]))
        fc.close(); fc2.close()

        b.close()
finally:
    srv.terminate()

print("\n"+("BROWSER FAILURES:\n - "+"\n - ".join(fails) if fails else "ALL BROWSER CHECKS PASSED"))
sys.exit(1 if fails else 0)
