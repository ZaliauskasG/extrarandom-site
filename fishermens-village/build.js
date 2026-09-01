/* Inlines the shared simulation and every sprite into one self-contained
   index.html. Runs on postinstall so a fresh deploy builds itself. */
const fs = require("fs");
const path = require("path");

const root = __dirname;
const spriteDir = path.join(root, "sprites");

const mime = f => (f.endsWith(".png") ? "image/png" : "image/jpeg");
const sprites = {};
fs.readdirSync(spriteDir).sort().forEach(f => {
  if (!/\.(png|jpg|jpeg)$/i.test(f)) return;
  const key = f.replace(/\.[^.]+$/, "");
  const b64 = fs.readFileSync(path.join(spriteDir, f)).toString("base64");
  sprites[key] = `data:${mime(f)};base64,${b64}`;
});

const simSrc = fs.readFileSync(path.join(root, "sim.js"), "utf8");
let html = fs.readFileSync(path.join(root, "client.html"), "utf8");

if (!html.includes("__SIM__") || !html.includes("__SPRITES__")) {
  console.error("client.html is missing __SIM__ or __SPRITES__ placeholders");
  process.exit(1);
}

html = html
  .replace("__SIM__", () => simSrc)
  .replace("__SPRITES__", () => JSON.stringify(sprites));

fs.writeFileSync(path.join(root, "index.html"), html);
console.log(
  `built index.html — ${Object.keys(sprites).length} sprites, ` +
  `${(html.length / 1024 / 1024).toFixed(2)} MB`
);
