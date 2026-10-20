import { MORE_THEMES } from './builtin-more.js';
import { EXTRA_THEMES } from './builtin-extra.js';
import { THEME_SCHEMA_VERSION, type Theme } from './schema.js';

/** Vestavěné motivy. Prázdné vrstvy = výchozí tokeny (klasický zelený stůl). */
export const BUILTIN_THEMES: Theme[] = [
  {
    schemaVersion: THEME_SCHEMA_VERSION,
    id: 'classic-green',
    name: 'theme.classic-green.name',
    builtin: true,
    light: {},
    dark: {},
  },
  {
    schemaVersion: THEME_SCHEMA_VERSION,
    id: 'high-contrast',
    name: 'theme.high-contrast.name',
    builtin: true,
    light: {
      'color.bg': '#ffffff',
      'color.surface': '#ffffff',
      'color.surfaceRaised': '#f0f0f0',
      'color.text': '#000000',
      'color.textMuted': '#1a1a1a',
      'color.border': '#000000',
      'color.primary': '#004d1f',
      'color.felt': '#00331a',
      'color.actionFold': '#7a0000',
      'color.actionCheck': '#003d80',
      'color.actionCall': '#004d1f',
      'color.actionRaise': '#5c3d00',
      'shape.borderWidth': '2px',
    },
    dark: {
      'color.bg': '#000000',
      'color.surface': '#0a0a0a',
      'color.surfaceRaised': '#1a1a1a',
      'color.text': '#ffffff',
      'color.textMuted': '#e6e6e6',
      'color.border': '#ffffff',
      'color.primary': '#7dffb0',
      'color.onPrimary': '#000000',
      'color.felt': '#003d1f',
      'color.actionFold': '#a31515',
      'color.actionCheck': '#1a5fb4',
      'color.actionCall': '#1b6e3c',
      'color.actionRaise': '#8a5a00',
      'shape.borderWidth': '2px',
    },
  },
];

BUILTIN_THEMES.push(...MORE_THEMES, ...EXTRA_THEMES);
