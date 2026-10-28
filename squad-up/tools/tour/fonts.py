"""Serve the app's Google font from local files, so captures look right even
offline. Needs `npm i @fontsource/m-plus-rounded-1c` somewhere; pass the
node_modules folder that holds it."""
import os

def route_fonts(context, node_modules):
    base = os.path.join(node_modules, "@fontsource", "m-plus-rounded-1c", "files")
    css = "".join(
        f"@font-face{{font-family:'M PLUS Rounded 1c';font-style:normal;font-weight:{w};font-display:block;"
        f"src:url(https://fonts.gstatic.com/local/{w}.woff2) format('woff2');}}"
        for w in (500, 700, 800))
    context.route("https://fonts.googleapis.com/**",
                  lambda r: r.fulfill(status=200, content_type="text/css", body=css))

    def font(r):
        w = r.request.url.rsplit("/", 1)[1].split(".")[0]
        with open(os.path.join(base, f"m-plus-rounded-1c-latin-{w}-normal.woff2"), "rb") as f:
            r.fulfill(status=200, content_type="font/woff2", body=f.read(),
                      headers={"Access-Control-Allow-Origin": "*"})
    context.route("https://fonts.gstatic.com/**", font)
