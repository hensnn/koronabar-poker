import { THEME_SCHEMA_VERSION, type Theme } from './schema.js';

type Map = Record<string, string>;
const th = (id: string, shared: Map, light: Map, dark: Map): Theme => ({ schemaVersion: THEME_SCHEMA_VERSION, id, name: `theme.${id}.name`, builtin: true, light: { ...shared, ...light }, dark: { ...shared, ...dark } });

/**
 * Dalších dvanáct vestavěných motivů s vlastním plátnem (barva, vzor), líci a rubem karet.
 * Každý má světlou i tmavou variantu a splňuje kontrast AA (hlídá test).
 */
export const EXTRA_THEMES: Theme[] = [
  // Smaragdový: sytě zelené plátno s jemnou tkaninou, zlaté doplňky, elegantní karty s rámečkem na rubu.
  th(
    'emerald-royal',
    { 'table.pattern': 'weave', 'cards.style': 'elegant', 'cards.back': 'frame', 'font.heading': 'Georgia, "Times New Roman", Times, serif', 'color.cardBackAccent': '#d4af37', 'color.dealerButton': '#d4af37', 'color.turnGlow': '#d4af37' },
    { 'color.bg': '#f3f7f4', 'color.surface': '#ffffff', 'color.surfaceRaised': '#e6efe9', 'color.text': '#10231a', 'color.textMuted': '#46574d', 'color.border': '#c3d3c8', 'color.primary': '#0b5d3b', 'color.felt': '#0b5d3b', 'color.feltBorder': '#3a2a12', 'color.roomBg': '#dfe9e2', 'color.feltPattern': '#ffffff22', 'color.cardBack': '#0b3d27' },
    { 'color.bg': '#08130e', 'color.surface': '#10201a', 'color.surfaceRaised': '#172c23', 'color.text': '#e5f1ea', 'color.textMuted': '#a3b9ad', 'color.border': '#28443a', 'color.primary': '#5fd39b', 'color.felt': '#0a4a30', 'color.feltBorder': '#1f160a', 'color.roomBg': '#050d09', 'color.feltPattern': '#ffffff14', 'color.cardBack': '#072a1b' },
  ),
  // Oceán: tyrkysové plátno s kruhy, podbarvené karty.
  th(
    'ocean',
    { 'table.pattern': 'rings', 'cards.style': 'tinted', 'cards.back': 'rings', 'color.turnGlow': '#ffd166', 'color.dealerButton': '#ffffff' },
    { 'color.bg': '#f1f8f9', 'color.surface': '#ffffff', 'color.surfaceRaised': '#e0eff2', 'color.text': '#0f2a30', 'color.textMuted': '#42585e', 'color.border': '#bcd5da', 'color.primary': '#0b6477', 'color.felt': '#0e7c86', 'color.feltBorder': '#0a3f4a', 'color.roomBg': '#d5e8ec', 'color.feltPattern': '#ffffff26', 'color.cardBack': '#0a3f4a', 'color.cardBackAccent': '#8fe3ea' },
    { 'color.bg': '#07161a', 'color.surface': '#0e242a', 'color.surfaceRaised': '#143239', 'color.text': '#e3f3f5', 'color.textMuted': '#9fbcc2', 'color.border': '#24454d', 'color.primary': '#5dd0dc', 'color.felt': '#0b5f68', 'color.feltBorder': '#052a31', 'color.roomBg': '#040e11', 'color.feltPattern': '#ffffff1a', 'color.cardBack': '#073740', 'color.cardBackAccent': '#5dd0dc' },
  ),
  // Bordó: vínové plátno se zrnitým filcem, kostkovaný rub.
  th(
    'burgundy',
    { 'table.pattern': 'speckle', 'cards.style': 'elegant', 'cards.back': 'plaid', 'color.turnGlow': '#f0c75e', 'color.dealerButton': '#f0c75e', 'color.cardBackAccent': '#e8c872' },
    { 'color.bg': '#fbf5f4', 'color.surface': '#ffffff', 'color.surfaceRaised': '#f3e6e4', 'color.text': '#2a1214', 'color.textMuted': '#5c4144', 'color.border': '#dbc3c0', 'color.primary': '#7b1e2e', 'color.felt': '#6b1a2b', 'color.feltBorder': '#2e0c13', 'color.roomBg': '#ecd9d7', 'color.feltPattern': '#ffffff22', 'color.cardBack': '#4a0f1c' },
    { 'color.bg': '#150a0c', 'color.surface': '#23131a', 'color.surfaceRaised': '#301b24', 'color.text': '#f5e6e8', 'color.textMuted': '#c4a6ab', 'color.border': '#4a2a33', 'color.primary': '#f09aa8', 'color.felt': '#531624', 'color.feltBorder': '#220710', 'color.roomBg': '#0d0507', 'color.feltPattern': '#ffffff14', 'color.cardBack': '#38101a' },
  ),
  // Západ slunce: švestkové plátno se světelným kruhem, teplé okolí, šupinatý rub.
  th(
    'sunset',
    { 'table.pattern': 'spotlight', 'cards.style': 'shadow', 'cards.back': 'scales', 'color.turnGlow': '#ffb347', 'color.dealerButton': '#ffb347' },
    { 'color.bg': '#fff7f0', 'color.surface': '#ffffff', 'color.surfaceRaised': '#fbe8d8', 'color.text': '#2b1a1f', 'color.textMuted': '#614a4f', 'color.border': '#ecd0bb', 'color.primary': '#9a3b1f', 'color.felt': '#5b2a6b', 'color.feltBorder': '#2a1233', 'color.roomBg': '#f6d9c0', 'color.feltPattern': '#ffb34744', 'color.cardBack': '#3d1a4a', 'color.cardBackAccent': '#ffb347' },
    { 'color.bg': '#170e14', 'color.surface': '#251823', 'color.surfaceRaised': '#33202f', 'color.text': '#f7e9e4', 'color.textMuted': '#c5aaa8', 'color.border': '#4a3044', 'color.primary': '#ffa070', 'color.felt': '#47205a', 'color.feltBorder': '#1b0b24', 'color.roomBg': '#0e0710', 'color.feltPattern': '#ffb34733', 'color.cardBack': '#30143c', 'color.cardBackAccent': '#ffb347' },
  ),
  // Les: lesní zelená s dřevěným okrajem, pruhy a linkový rub.
  th(
    'forest',
    { 'table.pattern': 'stripes', 'cards.style': 'classic', 'cards.back': 'lines', 'color.turnGlow': '#c8e06b', 'color.dealerButton': '#e8d9a0', 'color.cardBackAccent': '#a9c27a' },
    { 'color.bg': '#f4f7ef', 'color.surface': '#ffffff', 'color.surfaceRaised': '#e8eedd', 'color.text': '#1b2615', 'color.textMuted': '#4b5a40', 'color.border': '#cbd6bb', 'color.primary': '#33612b', 'color.felt': '#2f5d3a', 'color.feltBorder': '#4a3320', 'color.roomBg': '#cfd8c8', 'color.feltPattern': '#ffffff12', 'color.cardBack': '#24401f' },
    { 'color.bg': '#0b120a', 'color.surface': '#141f12', 'color.surfaceRaised': '#1d2c1a', 'color.text': '#e8f0df', 'color.textMuted': '#a8b99b', 'color.border': '#2f4429', 'color.primary': '#9fd47a', 'color.felt': '#234a2d', 'color.feltBorder': '#2c1d10', 'color.roomBg': '#070c06', 'color.feltPattern': '#ffffff0d', 'color.cardBack': '#183018' },
  ),
  // Neon: černé plátno s neonovou mřížkou, svítící karty a kruhový rub.
  th(
    'neon',
    { 'table.pattern': 'grid', 'cards.style': 'neon', 'cards.back': 'rings', 'cards.fourColor': 'on', 'color.turnGlow': '#00e5ff', 'color.dealerButton': '#ff2bd6', 'color.felt': '#10101c', 'color.feltBorder': '#ff2bd6', 'color.feltText': '#ffffff', 'color.cardBack': '#10101c', 'color.cardBackAccent': '#00e5ff', 'color.suitHeart': '#d4002f', 'color.suitDiamond': '#0a4fd6', 'color.suitClub': '#0b7a2f', 'table.edgeWidth': '6px' },
    { 'color.bg': '#f6f3fb', 'color.surface': '#ffffff', 'color.surfaceRaised': '#ebe5f6', 'color.text': '#1a1030', 'color.textMuted': '#51456b', 'color.border': '#d2c8e6', 'color.primary': '#7a1fa2', 'color.roomBg': '#dcd3ec', 'color.feltPattern': '#00e5ff2e' },
    { 'color.bg': '#0a0714', 'color.surface': '#141026', 'color.surfaceRaised': '#1d1836', 'color.text': '#f0eaff', 'color.textMuted': '#b3a8d6', 'color.border': '#37295c', 'color.primary': '#ff7ae6', 'color.roomBg': '#05030c', 'color.feltPattern': '#00e5ff1f' },
  ),
  // Led: světle modré plátno s tmavým textem, kosočtverce, karty s rámečkem.
  th(
    'ice',
    { 'table.pattern': 'diamonds', 'cards.style': 'frame', 'cards.back': 'zigzag', 'color.turnGlow': '#ff9f1c', 'color.dealerButton': '#ffffff' },
    { 'color.bg': '#f2f8fb', 'color.surface': '#ffffff', 'color.surfaceRaised': '#e1eef4', 'color.text': '#0e2430', 'color.textMuted': '#455b68', 'color.border': '#c2d7e1', 'color.primary': '#1d5f7f', 'color.felt': '#8fc4d9', 'color.feltBorder': '#4d7f94', 'color.feltText': '#0b2530', 'color.roomBg': '#eaf4f8', 'color.feltPattern': '#ffffff55', 'color.cardBack': '#2c6f8f', 'color.cardBackAccent': '#e6f6fc' },
    { 'color.bg': '#08141b', 'color.surface': '#102430', 'color.surfaceRaised': '#17323f', 'color.text': '#e4f2f8', 'color.textMuted': '#a2bccb', 'color.border': '#26485a', 'color.primary': '#8fd0ec', 'color.felt': '#3b7a93', 'color.feltBorder': '#1c3d4c', 'color.feltText': '#ffffff', 'color.roomBg': '#050d12', 'color.feltPattern': '#ffffff26', 'color.cardBack': '#1d4f66', 'color.cardBackAccent': '#bfe6f6' },
  ),
  // Pouštní: písková plátna, terakota, šípy a cik-cak rub.
  th(
    'desert',
    { 'table.pattern': 'chevron', 'cards.style': 'tinted', 'cards.back': 'zigzag', 'color.turnGlow': '#c2410c', 'color.dealerButton': '#7c2d12' },
    { 'color.bg': '#fbf6ec', 'color.surface': '#ffffff', 'color.surfaceRaised': '#f2e6cf', 'color.text': '#2d2210', 'color.textMuted': '#5d4e33', 'color.border': '#e0d0ae', 'color.primary': '#8a3d12', 'color.felt': '#d4b483', 'color.feltBorder': '#7c4a1d', 'color.feltText': '#2b1d0a', 'color.roomBg': '#efe0c0', 'color.feltPattern': '#ffffff40', 'color.cardBack': '#9a4a1c', 'color.cardBackAccent': '#f5deb3' },
    { 'color.bg': '#15100a', 'color.surface': '#231b11', 'color.surfaceRaised': '#2f2518', 'color.text': '#f4ead8', 'color.textMuted': '#c4b494', 'color.border': '#4a3b25', 'color.primary': '#f0a56a', 'color.felt': '#8a6a3f', 'color.feltBorder': '#3a2510', 'color.feltText': '#ffffff', 'color.roomBg': '#0c0905', 'color.feltPattern': '#ffffff1f', 'color.cardBack': '#6f3512', 'color.cardBackAccent': '#e8c898' },
  ),
  // Grafit: šedé plátno, tečky, tučné karty a linkový rub; střídmý a vážný.
  th(
    'graphite',
    { 'table.pattern': 'dots', 'cards.style': 'bold', 'cards.back': 'lines', 'color.turnGlow': '#38bdf8', 'color.dealerButton': '#e5e7eb', 'color.cardBackAccent': '#cbd5e1' },
    { 'color.bg': '#f3f4f6', 'color.surface': '#ffffff', 'color.surfaceRaised': '#e5e7eb', 'color.text': '#111827', 'color.textMuted': '#4b5563', 'color.border': '#cbd0d8', 'color.primary': '#2f3a46', 'color.felt': '#4a4f55', 'color.feltBorder': '#1f2225', 'color.roomBg': '#d5d8dc', 'color.feltPattern': '#ffffff1f', 'color.cardBack': '#2f3a46' },
    { 'color.bg': '#0b0d10', 'color.surface': '#151921', 'color.surfaceRaised': '#1e242e', 'color.text': '#eceff4', 'color.textMuted': '#a4adbb', 'color.border': '#2f3846', 'color.primary': '#9db4cf', 'color.felt': '#363b42', 'color.feltBorder': '#14171a', 'color.roomBg': '#060708', 'color.feltPattern': '#ffffff14', 'color.cardBack': '#232a35' },
  ),
  // Sakura: růžové plátno, jemné tečky, podbarvené karty a šupinatý rub.
  th(
    'sakura',
    { 'table.pattern': 'dots', 'cards.style': 'tinted', 'cards.back': 'scales', 'color.turnGlow': '#f59e0b', 'color.dealerButton': '#ffffff', 'shape.cardRadius': '8px' },
    { 'color.bg': '#fff6f8', 'color.surface': '#ffffff', 'color.surfaceRaised': '#fbe4ea', 'color.text': '#321620', 'color.textMuted': '#69424e', 'color.border': '#eccbd5', 'color.primary': '#a1385c', 'color.felt': '#d98aa4', 'color.feltBorder': '#9c4a64', 'color.feltText': '#3a0f1f', 'color.roomBg': '#f5dce3', 'color.feltPattern': '#ffffff4d', 'color.cardBack': '#b25a78', 'color.cardBackAccent': '#ffe4ec' },
    { 'color.bg': '#160d11', 'color.surface': '#25161c', 'color.surfaceRaised': '#322029', 'color.text': '#fbe9ee', 'color.textMuted': '#c9a9b3', 'color.border': '#4c2f3a', 'color.primary': '#f4a3bb', 'color.felt': '#8a4a62', 'color.feltBorder': '#3d1d2b', 'color.feltText': '#ffffff', 'color.roomBg': '#0e0709', 'color.feltPattern': '#ffffff26', 'color.cardBack': '#7a3a52', 'color.cardBackAccent': '#ffd1de' },
  ),
  // Starý papír: olivové plátno, patkové písmo, kostkovaný rub, zrnitý filc.
  th(
    'vintage',
    { 'table.pattern': 'speckle', 'cards.style': 'elegant', 'cards.back': 'plaid', 'font.heading': 'Georgia, "Times New Roman", Times, serif', 'font.body': 'Georgia, "Times New Roman", Times, serif', 'color.turnGlow': '#b45309', 'color.dealerButton': '#f3e7c4', 'color.cardBackAccent': '#e3cf9a' },
    { 'color.bg': '#f6efe0', 'color.surface': '#fffaf0', 'color.surfaceRaised': '#ece1c8', 'color.text': '#2f2615', 'color.textMuted': '#5f5238', 'color.border': '#d8c9a4', 'color.primary': '#5b4a1f', 'color.felt': '#4f5d2f', 'color.feltBorder': '#3b2a15', 'color.roomBg': '#e6d9bd', 'color.feltPattern': '#ffffff1f', 'color.cardBack': '#6b4423' },
    { 'color.bg': '#14100a', 'color.surface': '#201a10', 'color.surfaceRaised': '#2c2417', 'color.text': '#f0e6cf', 'color.textMuted': '#bfb08c', 'color.border': '#453a22', 'color.primary': '#e0c27a', 'color.felt': '#3d4824', 'color.feltBorder': '#241709', 'color.roomBg': '#0b0905', 'color.feltPattern': '#ffffff14', 'color.cardBack': '#4f3219' },
  ),
  // Láva: ohnivé červené plátno se světelným kruhem a paprsky na rubu.
  th(
    'lava',
    { 'table.pattern': 'spotlight', 'cards.style': 'shadow', 'cards.back': 'rays', 'color.turnGlow': '#ff8a3d', 'color.dealerButton': '#ffd166', 'color.cardBackAccent': '#ff8a3d' },
    { 'color.bg': '#fff4f0', 'color.surface': '#ffffff', 'color.surfaceRaised': '#fbe0d8', 'color.text': '#2b110c', 'color.textMuted': '#66423a', 'color.border': '#eec6bb', 'color.primary': '#b3200f', 'color.felt': '#8a1c0f', 'color.feltBorder': '#2b0a05', 'color.roomBg': '#f2d2c8', 'color.feltPattern': '#ff8a3d55', 'color.cardBack': '#3a0d08' },
    { 'color.bg': '#120706', 'color.surface': '#201010', 'color.surfaceRaised': '#2d1816', 'color.text': '#f8e8e4', 'color.textMuted': '#c9a9a2', 'color.border': '#4a2724', 'color.primary': '#ff8f6b', 'color.felt': '#4a0f0a', 'color.feltBorder': '#180403', 'color.roomBg': '#090303', 'color.feltPattern': '#ff8a3d33', 'color.cardBack': '#2a0805' },
  ),
];
