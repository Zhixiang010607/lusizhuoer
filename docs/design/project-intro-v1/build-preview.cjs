const fs = require('node:fs');
const path = require('node:path');

const here = __dirname;
const images = {
  BRAND: 'brand-background.webp',
  SKIN: 'layers-hero.webp',
  WARMTH: 'warmth-hero.webp',
};
let fragment = fs.readFileSync(path.join(here, 'preview.template.html'), 'utf8');
for (const [name, filename] of Object.entries(images)) {
  const data = fs.readFileSync(path.join(here, 'assets', filename)).toString('base64');
  fragment = fragment.replaceAll(`__${name}_IMAGE__`, `data:image/webp;base64,${data}`);
}
if (/__[A-Z_]+__/.test(fragment)) throw new Error('Unresolved preview asset');
if (Buffer.byteLength(fragment) > 1_000_000) throw new Error('Preview exceeds 1 MB');
const destination = path.resolve(process.argv[2] || path.join(here, 'preview.html'));
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, fragment);
console.log(`${destination} (${Buffer.byteLength(fragment)} bytes)`);
