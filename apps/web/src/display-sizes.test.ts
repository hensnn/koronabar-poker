import { describe, expect, it } from 'vitest';
import { clearProfileValue, MAX_DISPLAYS, parseProfiles, profileOverrides, setProfileValue } from './display-sizes';

describe('velikosti panelů podle zobrazení', () => {
  it('hodnoty se ukládají zvlášť pro každé zobrazení a čtou se jen pro to své', () => {
    let t = '';
    t = setProfileValue(t, '1920x1080@1', 'ui.tableSideWidth', 300);
    t = setProfileValue(t, '1920x1080@1.5', 'ui.tableSideWidth', 220);
    t = setProfileValue(t, '1920x1080@1.5', 'ui.tablePanelHeight', 150);
    expect(profileOverrides(t, '1920x1080@1')).toEqual({ 'ui.tableSideWidth': 300 });
    expect(profileOverrides(t, '1920x1080@1.5')).toEqual({ 'ui.tableSideWidth': 220, 'ui.tablePanelHeight': 150 });
    expect(profileOverrides(t, '1366x768@1.5')).toEqual({});
  });
  it('zrušení hodnoty a poškozený nebo cizí text', () => {
    let t = setProfileValue('', 'a', 'ui.tableSideWidth', 300);
    expect(clearProfileValue(t, 'a', 'ui.tableSideWidth')).toBe('');
    expect(parseProfiles('nesmysl')).toEqual({});
    expect(parseProfiles(JSON.stringify({ a: { 'ui.sfxVolumePercent': 5, 'ui.tableSideWidth': 'x' } }))).toEqual({ a: {} });
    t = setProfileValue(t, 'b', 'ui.tableChatHeight', 100);
    expect(Object.keys(parseProfiles(t))).toEqual(['a', 'b']);
  });
  it('pamatuje se nejvýš pár zobrazení, nejstarší se zahodí', () => {
    let t = '';
    for (let i = 0; i < MAX_DISPLAYS + 3; i++) t = setProfileValue(t, 'd' + i, 'ui.tableSideWidth', 100 + i);
    const ids = Object.keys(parseProfiles(t));
    expect(ids).toHaveLength(MAX_DISPLAYS);
    expect(ids[ids.length - 1]).toBe('d' + (MAX_DISPLAYS + 2));
    expect(ids).not.toContain('d0');
  });
});
