import { describe, expect, it } from 'vitest';
import { lastInGroup } from './index';

describe('poslední použitá stránka správy', () => {
  it('kategorie vede na poslední použitou stránku, jinak na první', () => {
    expect(lastInGroup(['/a', '/b', '/c'], '/b')).toBe('/b');
    expect(lastInGroup(['/a', '/b'], undefined)).toBe('/a');
    expect(lastInGroup(['/a', '/b'], '/zmizela')).toBe('/a');
  });
});
