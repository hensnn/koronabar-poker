# Předání práce (stav k 2. 11. 2026)

Dokument pro pokračování v jiném vlákně nebo s jiným modelem. Pravidla projektu jsou v `CLAUDE.md`, zadání v `docs/ZADANI.md`, průběžný deník rozhodnutí v `docs/STAV.md` (nejnovější záznamy jsou na konci).

## Jak ověřit, že je vše v pořádku

```bash
pnpm typecheck     # všechny balíčky
pnpm lint          # oxlint
pnpm build         # produkční build
pnpm test          # celá sada, trvá přes 9 minut kvůli apps/server/src/scenario-matrix.test.ts
```

Rychlá kontrola jen webu: `cd apps/web && npx vitest run` (zhruba 4 s). Těžký test scénářů pouštějte zvlášť: `npx vitest run apps/server/src/scenario-matrix.test.ts` (na pozadí, přes 9 minut).

Výsledky poslední kontroly jsou na konci tohoto dokumentu.

## Co se udělalo v poslední větvi práce (2. 11. 2026)

| Commit | Téma |
|---|---|
| c56a38b, 464fec9 | Push: tlačítko zkušebního upozornění ukáže odpověď push služby, při zapnutí se vždy založí nový odběr zařízení, zrušený odběr (410) se přihlásí znovu. Příčina neodesílání na Androidu byl starý zrušený odběr. |
| 49660c5 | Formulář nastavení: postranní panel s 6 oddíly, sbalené panely kategorií, vnořené podskupiny. Mapování v `packages/shared/src/settings/sections.ts`, hlídací test `sections.test.ts`. |
| f7a1fe0 | Rozložení se řídí šířkou okna (container query `@2xl`), ne obrazovky. Okno Pravidla stolu používá stejné oddíly a panely (jen čtení). |
| 6479471 | `Modal` má variantu `page` (celá obrazovka, tlačítko Zpět). Používá ji úprava a zakládání stolu a turnaje, šablony, hromadná změna šablon, struktury blindů. |
| 336d226 | Popisky a upozornění u parametrů jsou sbalené na konci položky (tlačítko „?“), stav se pamatuje v `localStorage` pod klíčem `kb.settings.helpOpen`. |
| 6708cbd, 9f389af, 5f9cf4f | Zúžené nastavení turnaje (`TournamentBasics` v `apps/web/src/pages/structure-editor.tsx`): speciální prvky jsou jen zaškrtávátka, struktura blindů a přehled peněz jsou sbalitelné karty (`Fold`), karta Rebuy/add-on/re-entry odstraněna jako duplicitní. |

## Klíčová místa v kódu

- `apps/web/src/settings/SettingsForm.tsx`: jeden formulář pro globální nastavení, šablony, stůl, turnaj i osobní nastavení. Komponenty `Panel`, `SettingsForm` (prop `bare` = zjednodušený režim bez hledání a postranního panelu), `Row`, `UnsavedBar`.
- `packages/shared/src/settings/sections.ts`: oddíly → kategorie → podskupiny (regulární výrazy podle klíčů). Nový parametr se zařadí tady; test hlídá, že žádný nezůstane v „Ostatní“ u kategorií s pravidly.
- `packages/shared/src/settings/groups.ts`: starší dělení kategorie `special`.
- `apps/web/src/ui.tsx`: `Modal` (okno nebo `page`), `Card`, `Tabs`.
- `apps/web/src/pages/rules.tsx`: okno Pravidla (jen čtení).
- `apps/server/src/push.ts`, `apps/web/src/push.ts`, `apps/web/src/notifications.tsx`: push.

## Známé slabiny a nápady na další úpravy

1. **Karta Sdílení osobního nastavení** (sady: stůl na počítači, stůl na telefonu, zvuky, vzhled, upozornění) je pořád samostatně pod formulářem. Sady se s oddíly nekryjí, takže tlačítka Sdílet / Převzít nejsou v hlavičkách oddílů.
2. **Zúžené nastavení turnaje:** u Re-entry a dohody už není v hlavním nastavení počet vstupů ani podrobnosti, jsou jen v podrobném nastavení. Pokud to bude chybět, přidat u zaškrtávátka malé číselné pole stejně jako u rebuy.
3. **Dva vstupy „Počet hráčů“** (ve Struktuře blindů a v Penězích a výplatách) jsou nezávislé. Šlo by je sloučit do jednoho stavu v `TournamentBasics`.
4. **Okna, která zůstala oknem:** dialogy bez rozsáhlého formuláře a okno Pravidla. Úprava a zakládání nejsou samostatné stránky s adresou, takže po obnovení prohlížeče se uživatel vrátí na seznam. Případně udělat z nich skutečné trasy.
5. **Zprávy členům** hlásí počet příjemců, ne skutečný počet doručených push upozornění. Stejnou diagnostiku jako u zkušebního upozornění (`PushService.deliver`) by šlo použít i tam.
6. **Výkon:** `Row` při každém připojení čte `localStorage` (`helpOpenKeys`). U stovek řádků v rozbalených panelech je to zanedbatelné, ale šlo by držet jednu sdílenou sadu v paměti.
7. **Nepoužité texty:** klíče `rebuy.title`, `rebuy.hint` a podobné v `packages/shared/src/i18n/cs.ts` po odstranění karty Rebuy nikdo nepoužívá. Dá se uklidit.
8. **Build:** Vite hlásí tři varování INEFFECTIVE_DYNAMIC_IMPORT (live, polls, chat se importují staticky i dynamicky). Nejde o chybu, jen o neúčinné dělení balíčku.
9. **Další návrhy z dřívějška:** obecné storno v účetní knize, snímek nastavení turnaje při startu, přesun karty přepočtu do Údržby, kategorie podle sezón, u každého nastavení ukázat „nastavil správce / vy“.

## Pravidla, na která je třeba si dát pozor

- Žádné barvy, fonty ani velikosti napevno v komponentách (test `no-hardcoded-styles` hlídá například `px` za číslicí i výchozí paletu Tailwindu). Třídy jako `gap-2 px-3` v tomto pořadí prošly, `px-3 gap-2` je nutné psát opatrně.
- Uživatelské texty jen přes `packages/shared/src/i18n/cs*.ts`.
- Měna se píše Korona / Korony / Koron s velkým K.
- Repozitář je veřejný: žádné osobní údaje, jen zástupné domény a e-maily, commity pod noreply.
- Po změnách vzhledu vždy vykreslit a prohlédnout (dev servery `server` a `web` z `.claude/launch.json`).
- Commit končí řádkem `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; pushuje se na `origin/main`.

## Výsledky poslední kontroly (2. 11. 2026)

- `pnpm typecheck`: bez chyb.
- `pnpm lint`: bez chyb.
- `pnpm build`: projde, jen tři varování INEFFECTIVE_DYNAMIC_IMPORT.
- `pnpm test`: 150 souborů a 1297 testů prošlo, 1 přeskočený; běh se zastavil na časovém limitu v `scenario-matrix.test.ts`.
- `scenario-matrix.test.ts` spuštěný zvlášť: 5 z 5 prošlo (zhruba 5 minut).
- Prohlížeč (telefon 375 px): úprava šablony na celou obrazovku bez vodorovného posuvu, lišta neuložených změn viditelná, bez chyb aplikace v konzoli.
