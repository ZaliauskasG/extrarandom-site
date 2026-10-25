"""Step 1 of the tour video: run the app on a demo squad, act out each scene
as Danielle (a regular member) in a phone-sized browser, and save
screenshots plus where the tapped things are (shots/manifest.json).

  python3 tools/tour/capture.py <node_modules with @fontsource/m-plus-rounded-1c> <out dir>
"""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import seed, fonts
from playwright.sync_api import sync_playwright

NODE_MODULES, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
VW, VH, DPR = 390, 600, 3
man = {"viewport": [VW, VH], "dpr": DPR, "shots": {}}


def box(pg, loc):
    """an element's box in page coordinates (CSS px)"""
    loc.scroll_into_view_if_needed()
    return pg.evaluate("""el => { const r = el.getBoundingClientRect();
        return [r.left + scrollX, r.top + scrollY, r.width, r.height]; }""", loc.element_handle())


def shot(pg, name, full=True, **boxes):
    pg.evaluate("window.scrollTo(0,0)")
    pg.wait_for_timeout(150)
    path = os.path.join(OUT, name + ".png")
    pg.screenshot(path=path, full_page=full)
    h = pg.evaluate("document.documentElement.scrollHeight") if full else VH
    man["shots"][name] = {"file": name + ".png", "h": h, "boxes": boxes}


def settle(pg):
    pg.wait_for_load_state("networkidle")
    pg.evaluate("document.fonts.ready")
    pg.wait_for_timeout(250)


srv = seed.start_server()
try:
    S = seed.seed()
    srv = seed.polish(srv)
    T = S["tokens"]["Danielle"]
    H = seed.H
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": VW, "height": VH}, device_scale_factor=DPR,
                            is_mobile=True, has_touch=True)
        fonts.route_fonts(ctx, NODE_MODULES)
        pg = ctx.new_page()
        # no blinking caret or hover glow in the stills
        ctx.add_init_script("""addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');
            s.textContent='*{caret-color:transparent!important;transition:none!important;animation:none!important}';
            document.head.appendChild(s);});""")

        # 1. home -> + New plan -> I know when / Find a time
        pg.goto(f"{H}/squadup/p/{T}"); settle(pg)
        nb = box(pg, pg.locator("a.pill.go", has_text="New plan"))
        shot(pg, "home_top", full=False, newplan=nb)
        pg.goto(f"{H}/squadup/start?t={T}"); settle(pg)
        ft = box(pg, pg.locator(".bubble", has_text="Find a time").first)
        shot(pg, "start", full=False, findtime=ft)

        # 2. the Beach day poll: tap "This works" on the leading date
        pg.goto(f"{H}/squadup/f/{S['poll']}?t={T}"); settle(pg)
        btn = pg.locator("[data-pick]").first
        bb = box(pg, btn)
        card = box(pg, btn.locator("xpath=ancestor::*[contains(@class,'bubble')][1]"))
        shot(pg, "poll_before", tap=bb, card=card)
        btn.click(); pg.wait_for_timeout(1500)
        shot(pg, "poll_after", card=box(pg, pg.locator("[data-pick]").first.locator("xpath=ancestor::*[contains(@class,'bubble')][1]")))

        # 3. Activities: I'm interested on Climbing (new), then who's in
        pg.goto(f"{H}/squadup/p/{T}"); settle(pg)
        cl = pg.locator(".act", has_text="Climbing")
        shot(pg, "act_before", card=box(pg, cl), tap=box(pg, cl.locator("[data-int]")))
        cl.locator("[data-int]").click(); settle(pg); pg.wait_for_timeout(500)
        cl = pg.locator(".act", has_text="Climbing")
        summ = cl.locator("details.actwho summary")
        shot(pg, "act_after", card=box(pg, cl), tap=box(pg, summ))
        summ.click(); pg.wait_for_timeout(200)
        shot(pg, "act_open", card=box(pg, cl))

        # 4. the bell on Dinner
        dn = pg.locator(".act", has_text="Dinner")
        pg.locator("details.actwho[open]").evaluate_all("els => els.forEach(e => e.open = false)")
        shot(pg, "bell_before", card=box(pg, dn), tap=box(pg, dn.locator("[data-bell]")))
        dn.locator("[data-bell]").click(); pg.wait_for_timeout(900)
        shot(pg, "bell_after", card=box(pg, dn))
        dn.locator("[data-bell]").click(); pg.wait_for_timeout(600)   # leave it on

        # 5. Squad members: open Gin
        pg.goto(f"{H}/squadup/members?t={T}"); settle(pg)
        g = pg.locator("details.mem", has_text="Gin")
        shot(pg, "members", full=False, tap=box(pg, g.locator("summary")))
        g.locator("summary").click(); pg.wait_for_timeout(200)
        shot(pg, "members_open", full=False)
        b.close()
finally:
    srv.kill()

json.dump(man, open(os.path.join(OUT, "manifest.json"), "w"), indent=1)
print("captured", len(man["shots"]), "screens into", OUT)
