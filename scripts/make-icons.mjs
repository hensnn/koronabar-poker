// Vygeneruje ikony PWA (PNG) z jednoho zdrojového SVG. Spuštění: node scripts/make-icons.mjs
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync } from 'node:fs';

const SPADE = 'M256 96C205 170 118 218 118 296a68 68 0 0 0 118 46c-4 38-18 68-42 92h124c-24-24-38-54-42-92a68 68 0 0 0 118-46C394 218 307 170 256 96z';
const svg = (inner, round = true) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512"${round ? ' rx="96"' : ''} fill="#0a0a0a"/>${inner}</svg>`;
const glyph = (scale) => `<g transform="translate(256 256) scale(${scale}) translate(-256 -256)"><circle cx="256" cy="256" r="196" fill="#00331a" stroke="#7dffb0" stroke-width="16"/><path d="${SPADE}" fill="#7dffb0"/></g>`;

const out = (name, markup, size) => writeFileSync(`apps/web/public/${name}`, new Resvg(markup, { fitTo: { mode: 'width', value: size } }).render().asPng());
writeFileSync('apps/web/public/icon.svg', svg(glyph(1)));
out('icon-192.png', svg(glyph(1)), 192);
out('icon-512.png', svg(glyph(1)), 512);
out('apple-touch-icon.png', svg(glyph(1), false), 180);
// maskable: motiv musí být ve vnitřních 80 %, pozadí přes celou plochu
out('icon-maskable-512.png', svg(glyph(0.72), false), 512);
console.log('hotovo');
