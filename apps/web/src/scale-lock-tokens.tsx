import { useEffect } from 'react';
import { scaledTokenCss, useScaleFactor } from './scale-lock';
import { useThemes } from './theme/ThemeProvider';

const STYLE_ID = 'tk-scale';

/**
 * Měřítko okna pro rozměry z motivu (jednotka odsazení, karty, avatary, zaoblení jsou v pixelech, takže písmo na kořeni stránky je nezmění):
 * přepíše je ve zvláštním stylu, dokud je měřítko zapnuté. Bez zapnutého měřítka nevloží nic.
 */
export function ScaleLockTokens(): null {
  const s = useScaleFactor();
  const { tokens } = useThemes();
  useEffect(() => {
    let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (s === 1) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      document.head.appendChild(el);
    }
    el.textContent = scaledTokenCss(tokens, s);
    return () => el?.remove();
  }, [s, tokens]);
  return null;
}
