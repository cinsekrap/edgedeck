// Builds Resources/web/mdi-icons.js from @mdi/font's CSS. Usage:
//   npm pack @mdi/font@<version> && tar xzf mdi-font-*.tgz
//   node tools/make-mdi-map.js package/css/materialdesignicons.css Resources/web/mdi-icons.js
// then copy package/fonts/materialdesignicons-webfont.woff2 to Resources/web/fonts/mdi.woff2.
const fs = require('fs');
const [css, out] = process.argv.slice(2);
const text = fs.readFileSync(css, 'utf8');
const re = /\.mdi-([a-z0-9-]+)::before\s*\{\s*content:\s*"\\([0-9A-Fa-f]+)"/g;
const pairs = [];
let m;
while ((m = re.exec(text))) pairs.push(m[1] + ':' + m[2].toLowerCase());
const js = `// Material Design Icons 7.4.47 (Pictogrammers, Apache 2.0): icon name -> code point.
// Generated from @mdi/font's CSS; the font is fonts/mdi.woff2.
window.MDI_ICONS = (function () {
  const map = new Map();
  for (const p of ${JSON.stringify(pairs.join(','))}.split(',')) { const i = p.indexOf(':'); map.set(p.slice(0, i), parseInt(p.slice(i + 1), 16)); }
  return map;
})();
`;
fs.writeFileSync(out, js);
console.log(pairs.length, 'icons', js.length, 'bytes');
