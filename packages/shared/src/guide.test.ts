import { describe, expect, it } from 'vitest';
import { answerFromGuide, foldText } from './guide.js';

describe('odpověď z návodu bez AI', () => {
  it('najde odstavec podle významných slov i s českou koncovkou', () => {
    const a = answerFromGuide('Co je straddle?');
    expect(a?.paragraphs[0]).toMatch(/Straddle/);
    expect(answerFromGuide('jak funguje rebuy a add-on v turnaji')?.paragraphs.join(' ')).toMatch(/add-on/i);
    expect(answerFromGuide('Vysvětli mi time bank')?.paragraphs.join(' ')).toMatch(/Time bank/);
  });
  it('žádosti o změnu, příliš obecné a nenalezené otázky vrací null', () => {
    expect(answerFromGuide('zapni straddle u stolu')).toBeNull();
    expect(answerFromGuide('nastav blindy 10/20')).toBeNull();
    expect(answerFromGuide('hra')).toBeNull();
    expect(answerFromGuide('xyzzyplugh')).toBeNull();
    expect(answerFromGuide('poker')).toBeNull(); // víc než tři odstavce
  });
  it('foldText odstraní diakritiku', () => {
    expect(foldText('Sázka Čeněk')).toBe('sazka cenek');
  });
});
