/** „Zobrazit jako“: správce se jen dívá očima jiného uživatele. Stav drží karta prohlížeče (sessionStorage), server všechno omezuje na čtení. */
const KEY = 'kb.viewAs';

export interface ViewAs {
  id: string;
  nickname: string;
}

export function viewAs(): ViewAs | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as ViewAs) : null;
  } catch {
    return null;
  }
}

/** Začne zobrazení jako jiný uživatel; aplikace se načte znovu, aby neměla nic z předchozí identity. */
export function startViewAs(v: ViewAs): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* bez úložiště zobrazení jako nejde */
    return;
  }
  window.location.assign('/');
}

export function stopViewAs(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* nic */
  }
  window.location.assign('/admin/uzivatele');
}
