"""Draw one tutorial video and encode it.

  python3 tools/tutorial/render.py <node_modules with @fontsource/m-plus-rounded-1c> <video html> <out dir>

Each video is a small HTML stage (720x1280) built from the app's own styles
(lib/theme.js is injected first, so buttons and cards are the real ones).
render(t) draws one frame. Writes <name>.mp4 (720x1280, for the app),
<name>-1080.mp4 (for sharing) and <name>.jpg (the still shown before it plays).

TUTORIAL_PREVIEW=1.0,3.2 draws just those moments as PNGs to look at.
"""
import sys, os, json, shutil, subprocess
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tour"))
import fonts
from playwright.sync_api import sync_playwright

NODE_MODULES, STAGE, OUT = sys.argv[1], os.path.abspath(sys.argv[2]), os.path.abspath(sys.argv[3])
NAME = os.path.splitext(os.path.basename(STAGE))[0]
FPS = 30
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.makedirs(OUT, exist_ok=True)
frames = os.path.join(OUT, NAME + "-frames")

theme = subprocess.run(["node", "-e", "process.stdout.write(require('./lib/theme.js'))"],
                       cwd=ROOT, capture_output=True, text=True, check=True).stdout
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 720, "height": 1280}, device_scale_factor=1.5)
    fonts.route_fonts(ctx, NODE_MODULES)
    ctx.add_init_script("document.addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');"
                        f"s.textContent={json.dumps(theme)};document.head.insertBefore(s,document.head.firstChild);}});")
    pg = ctx.new_page()
    pg.goto("file://" + STAGE)
    pg.evaluate("window.ready")
    dur, poster_t = pg.evaluate("[window.DURATION, window.POSTER]")
    only = [float(x) for x in os.environ.get("TUTORIAL_PREVIEW", "").split(",") if x]
    if only:
        for t in only:
            pg.evaluate(f"render({t})"); pg.screenshot(path=os.path.join(OUT, f"{NAME}-preview-{t:05.2f}.png"))
        sys.exit(0)
    shutil.rmtree(frames, ignore_errors=True); os.makedirs(frames)
    n = int(round(dur * FPS))
    for i in range(n):
        pg.evaluate(f"render({i / FPS})")
        pg.screenshot(path=os.path.join(frames, f"f{i:04d}.jpg"), type="jpeg", quality=92)
    pg.evaluate(f"render({poster_t})")
    pg.screenshot(path=os.path.join(frames, "poster.png"))
    b.close()
print(f"{n} frames, {dur:.1f}s")


def enc(name, w, crf):
    tmp = os.path.join(OUT, "tmp-" + name)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS), "-i", os.path.join(frames, "f%04d.jpg"),
                    "-vf", f"scale={w}:-2:flags=lanczos", "-c:v", "libx264", "-profile:v", "high", "-preset", "veryfast",
                    "-crf", str(crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", tmp], check=True)
    os.replace(tmp, os.path.join(OUT, name))


enc(NAME + ".mp4", 720, 24)
enc(NAME + "-1080.mp4", 1080, 20)
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", os.path.join(frames, "poster.png"),
                "-vf", "scale=720:-2:flags=lanczos", "-q:v", "4", os.path.join(OUT, NAME + ".jpg")], check=True)
shutil.rmtree(frames)
for f in (NAME + ".mp4", NAME + "-1080.mp4", NAME + ".jpg"):
    print(f, round(os.path.getsize(os.path.join(OUT, f)) / 1024), "KB")
