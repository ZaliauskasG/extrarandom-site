"""Step 2 of the tour video: draw every frame and encode.

  python3 tools/tour/render.py <node_modules> <shots dir> <out dir> [slides.html|stage.html]

slides.html (the default) is the current tour: scenario slides built from
the app's own styles. stage.html is the first, all-screens version.

Writes squad-up-tour.mp4 (720x1280, for the app), squad-up-tour-1080.mp4
(1080x1920, for sharing) and squad-up-tour.jpg (the still shown before
it plays). Needs ffmpeg.
"""
import sys, os, json, shutil, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fonts
from playwright.sync_api import sync_playwright

NODE_MODULES, SHOTS, OUT = sys.argv[1], os.path.abspath(sys.argv[2]), os.path.abspath(sys.argv[3])
STAGE = sys.argv[4] if len(sys.argv) > 4 else "slides.html"
FPS = 30
POSTER_T = 6.6 if STAGE == "slides.html" else 13.4   # "I'm interested" just tapped
HERE = os.path.dirname(os.path.abspath(__file__))
frames = os.path.join(OUT, "frames")
shutil.rmtree(frames, ignore_errors=True); os.makedirs(frames)
man = json.load(open(os.path.join(SHOTS, "manifest.json")))

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 720, "height": 1280}, device_scale_factor=1.5)
    fonts.route_fonts(ctx, NODE_MODULES)
    ctx.add_init_script(f"window.MAN={json.dumps(man)}; window.SHOTS='file://{SHOTS}/';")
    # the app's own stylesheet first, so the slides' buttons are the real ones
    theme = subprocess.run(["node", "-e", "process.stdout.write(require('./lib/theme.js'))"],
                           cwd=os.path.dirname(os.path.dirname(HERE)), capture_output=True, text=True, check=True).stdout
    if STAGE == "slides.html": ctx.add_init_script("document.addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');"
                        f"s.textContent={json.dumps(theme)};document.head.insertBefore(s,document.head.firstChild);}});")
    pg = ctx.new_page()
    pg.goto("file://" + os.path.join(HERE, STAGE))
    pg.evaluate("window.ready")
    dur = pg.evaluate("window.DURATION")
    n = int(round(dur * FPS))
    only = [float(x) for x in os.environ.get("TOUR_PREVIEW", "").split(",") if x]
    if only:   # just a few stills to look at, no video
        for t in only:
            pg.evaluate(f"render({t})"); pg.screenshot(path=os.path.join(OUT, f"preview-{t:05.2f}.png"))
        sys.exit(0)
    for i in range(n):
        pg.evaluate(f"render({i / FPS})")
        pg.screenshot(path=os.path.join(frames, f"f{i:04d}.png"))
    pg.evaluate(f"render({POSTER_T})")
    pg.screenshot(path=os.path.join(OUT, "poster.png"))
    b.close()
print(f"{n} frames, {dur:.1f}s")

def enc(name, w, crf):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS), "-i", os.path.join(frames, "f%04d.png"),
                    "-vf", f"scale={w}:-2:flags=lanczos", "-c:v", "libx264", "-profile:v", "high", "-preset", "slow",
                    "-crf", str(crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an",
                    os.path.join(OUT, name)], check=True)
enc("squad-up-tour.mp4", 720, 26)
enc("squad-up-tour-1080.mp4", 1080, 22)
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", os.path.join(OUT, "poster.png"),
                "-vf", "scale=720:-2:flags=lanczos", "-q:v", "4", os.path.join(OUT, "squad-up-tour.jpg")], check=True)
os.remove(os.path.join(OUT, "poster.png"))
shutil.rmtree(frames)
for f in ("squad-up-tour.mp4", "squad-up-tour-1080.mp4", "squad-up-tour.jpg"):
    print(f, round(os.path.getsize(os.path.join(OUT, f)) / 1024), "KB")
