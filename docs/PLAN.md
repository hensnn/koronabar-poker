# KoronaBar Poker – plán (verze 1, ke schválení)

Tento dokument vychází z `CLAUDE.md` a `docs/ZADANI.md`. Žádný kód zatím nevznikl. Po schválení (a po zodpovězení otevřených otázek v kapitole 5) začnu fází 1.

---

## 1. Pokerový engine: porovnání a doporučení

### Kandidáti

| Kritérium | `@pokertools/engine` | `poker-ts` | Vlastní od nuly |
|---|---|---|---|
| Jazyk, licence | TypeScript, MIT | TypeScript, MIT | – |
| Side poty a all-in | ano (iterativní odečítání), testy | ano (`pots()` s oprávněnými hráči) | riziko chyb |
| Maska pohledu pro hráče | **ano, `engine.view(playerId)`**, bez ID = pohled diváka, balíček označen „jen server“ | **ne**, maskování bych psal sám | – |
| Serializace stavu | **ano, `snapshot` / `restore`**, neměnný (immutable) stav | v README neuvedeno, stav je objekt třídy | – |
| Kontrola součtu žetonů | **ano, vestavěná** (porušení = výjimka) | ne | – |
| Kryptografický RNG | ano (Node `crypto`, nikdy `Math.random`) | míchání dodává volající (my) | – |
| Ante | ano | ano | – |
| Rake (cap, no flop no drop) | ano | ne | – |
| Turnajový modul (levely, dead button) | ano, základní | ne | – |
| Time bank | ano (jen jednoduchý, nám nestačí) | ne | – |
| Straddle, BB ante, run it twice, rabbit hunt, PLO | **ne** | **ne** | – |
| Testy | 362 testů ve 38 sadách (podle README) | Jest sada, rozsah neznámý | – |
| Údržba a stáří | mladý projekt, jeden autor | 65 hvězdiček, 95 commitů, bez releasů | – |

Poznámka k ověřitelnosti: údaje jsou z README a stránky repozitáře. **Nepodařilo se mi ověřit datum posledního vydání ani přesný stav údržby** u obou knihoven. Proto doporučuji krátký ověřovací test (viz níže), než se na engine definitivně spolehneme.

### Doporučení: `@pokertools/engine`

Zdůvodnění:
1. **Splňuje nejtěžší bezpečnostní požadavky zadání hned z krabice:** maska pohledu (`view`), serializace (restart serveru nesmí ztratit hru), kontrola zachování žetonů (to přesně chceme jako invariant) a kryptografický RNG.
2. Neměnný stav se výborně hodí k ukládání do DB po každé akci a k přehrávání hand.
3. Obsahuje rake a základní turnajová pravidla, což je částečně to, co potřebujeme (my to ale stejně vedeme vlastní vrstvou, viz níže).
4. `poker-ts` je čistší a menší, ale maskování, serializaci a kontrolu součtu bychom dopisovali sami, což jsou přesně místa, kde se dělají chyby.

Rizika a jak je řeším:
- **Chybí straddle, BB ante, run it twice, rabbit hunt, bomb pot, PLO.** To zadání očekává (adaptér/herní vrstva). Řešení: tyto funkce jdou do **vlastní herní vrstvy** nad adaptérem (viz kap. 2.4). Straddle a BB ante a bomb pot jsou „předepsané sázky na začátku handy“. Pokud je engine neumí zadat zvenčí, **zkusím nejdřív** dodat je přes konfiguraci a nakonec je řeším **forkem do `packages/engine-fork`** (licence MIT to dovoluje). Run it twice se řeší v herní vrstvě: engine dohraje do showdownu s vlastním balíčkem a my rozdělíme pot ze zbytku téhož balíčku.
- **Mladý projekt.** Proto celý engine zabalím do adaptéru `PokerEngineAdapter` a vedle něj mít sadu **vlastních kontrolních testů** (side poty s více all-iny, heads-up, dead button, split pot s lichým žetonem). Tyto testy běží proti jakémukoli enginu a umožní výměnu.
- **Rozhodovací brána na začátku fáze 1 (půl dne až den):** napíšu tzv. „spike“ s 20 až 30 případy side potů a ověřím maskování. Když engine neprojde, přepnu na `poker-ts` (a doplním maskování, serializaci a audit v adaptéru). Výsledek zapíšu do `docs/STAV.md`.

Další knihovny:
- **Vyhodnocení rukou a šance na výhru:** `@pokertools/evaluator` (stejná rodina) nebo `pokersolver`/`poker-evaluator`, vybereme po spike. Přesný výčet kombinací pro šance na výhru je potřeba stejně dělat vlastní vrstvou.
- **Rating:** `openskill` (MIT), jak zadání požaduje.
- **Hlasatel, ICM:** vlastní kód (ICM je krátký algoritmus, Malmuth-Harville).

---

## 2. Architektura

### 2.1 Technologie

| Oblast | Volba | Poznámka |
|---|---|---|
| Správa balíčků | **pnpm workspaces** (monorepo) | sdílené typy a schémata mezi serverem a klientem |
| Server | Node.js 20+, TypeScript, **Fastify** + **Socket.IO** | Fastify je rychlejší a má lepší typování než Express |
| Schémata | **Zod** | jedno centrální schéma nastavení, katalog oprávnění, zprávy Socket.IO |
| Databáze | **PostgreSQL 16**, **Drizzle ORM** + migrace | Drizzle je lehčí a SQL-blízké, dobré pro účetní transakce |
| Klient | React + Vite + TypeScript, Tailwind přes design tokeny | stav: Zustand, data: TanStack Query |
| Testy | **Vitest** (jednotkové, simulace), **Playwright** (E2E), fake timers | |
| Nasazení | Docker Compose (app, postgres, volitelně piper), vše přes `.env` | za Nginx Proxy Manager |
| Časovače a plánovač | vlastní „scheduler“ nad tabulkou událostí v DB | přežije restart |
| Fronta (e-mail, push, webhooky) | tabulky v PostgreSQL + worker ve stejném procesu (`SELECT … FOR UPDATE SKIP LOCKED`) | bez Redisu v první verzi |

Proč ne Redis hned: pro 4–9 hráčů a desítky stolů je zbytečný. Socket.IO se používá po místnostech (rooms) a adaptér pro Redis jde později přidat bez zásahu do kódu.

### 2.2 Struktura repozitáře

```
apps/
  server/        Fastify + Socket.IO, moduly, plánovač, workery
  web/           React klient (PWA)
packages/
  shared/        Zod schémata (nastavení, oprávnění, zprávy), typy, překladové klíče
  game-core/     PokerEngineAdapter, herní vrstva, moduly (pluginy), časovače, šance na výhru
  ledger/        účetní kniha (čistá logika + SQL), invariants
  rating/        XP, hodnosti, OpenSkill, výměna při vyřazení
  tokens/        design tokeny, motivy, kontrola kontrastu
  bots/          jednoduchý bot, simulátor
docs/            ZADANI.md, PLAN.md, STAV.md, README podklady
docker/          Dockerfile, compose, nginx poznámky
```

### 2.3 Server: vrstvy

1. **HTTP/REST (Fastify):** přihlášení, registrace, správa, exporty, OpenAPI (později).
2. **Socket.IO brána:** každá zpráva projde stejným řetězcem: *autentizace → Zod validace → rate limit → kontrola oprávnění → handler*. Žádný handler nesmí být registrován mimo tento řetězec (lint/test to hlídá).
3. **Služby (services):** doménová logika bez vazby na transport (účty, role, peněženka, turnaje…). REST i Socket.IO i MCP i asistent volají **tytéž služby**, takže oprávnění, validace i audit jsou na jednom místě.
4. **Repozitáře (Drizzle):** přístup k DB, transakce.
5. **Plánovač a workery:** událostní tabulka (`scheduled_events`), časovače hry, e-mail, push, webhooky, zálohy.

### 2.4 Herní jádro (`game-core`)

```
Klient ──akce──▶ Gateway ──▶ TableActor (jedna instance na stůl)
                               │
                               ├─ PokerEngineAdapter  (obaluje @pokertools/engine)
                               ├─ HandPipeline  (háčky/moduly)
                               ├─ TimerService  (časovač tahu, time bank)
                               └─ Persistence   (snapshot po každé akci)
```

- **`TableActor`:** každý stůl je izolovaná instance se **sériovou frontou příkazů** (jedna akce naráz, žádné souběhy). Výjimka na stole se zachytí, stůl se uloží a přepne do stavu „chyba“, ostatní stoly běží dál. Stav je v paměti, snapshot se ukládá do DB po každé akci (levně, jeden řádek na stůl + přírůstkový log akcí).
- **`PokerEngineAdapter`** (rozhraní): `startHand`, `act`, `legalActions`, `viewFor(playerId|spectator)`, `snapshot/restore`, `pots`, `showdownResult`, `deal(forcedBets)`. Za rozhraním je `@pokertools/engine`; jiný engine = jiná implementace stejného rozhraní, stejné kontrolní testy.
- **Varianty hry:** rozhraní `GameVariant` (počet hole karet, pravidla výběru nejlepší pětice, limit sázek: no-limit/pot-limit/fixed-limit). V první verzi `NLHE`; PLO se přidá jako další implementace (pot-limit výpočet min/max sázky je v rozhraní od začátku).
- **Moduly (pluginy) s háčky:** modul je objekt s manifestem a registrací:
  ```
  GameModule {
    id, název, závislosti
    settingsSchema      // vlastní parametry do centrálního schématu
    permissions         // vlastní oprávnění do katalogu
    hooks: onHandStart, beforeDeal, onAction, afterAction, beforeShowdown,
           onShowdown, afterPotAwarded, onPlayerBusted, onLevelChange,
           onHandEnd, onTableStart/Stop …
  }
  ```
  Háček může: přidat předepsané sázky (straddle, BB ante, bomb pot ante), změnit nabídku akcí, zahájit hlasování (run it twice), přidat účetní pohyby (rake, 7-2 bonus), přidat události do historie. Háčky běží v **pevně daném pořadí** (priorita modulu) a každý dostává jen **kontext bez tajných dat** (kromě háčků označených `server-only`).
  Moduly první verze: *straddle, ante/BB ante, rake a poplatky, run it twice, rabbit hunt, ukázání karet, 7-2 bonus, bomb pot, šance na výhru, time bank, blind structure (turnaj), bounty*, později *dealy, sázky, odměna na hlavu*.
- **Šance na výhru:** čistá funkce nad stavem, přesný výčet kombinací (do rozumného počtu), Monte Carlo jako záloha. Počítá server a posílá jen to, co se smí zobrazit.
- **Časovač:** `TimerService` je serverový, deadline je uložený ve stavu stolu (přežije restart), klient jen zobrazuje `deadlineAt` + odchylku hodin serveru. Varianty time banku jsou **strategie** za jedním rozhraním (`TimeBankPolicy`).
- **Chování po restartu:** při startu se načtou stoly se stavem „běží“, rozehraná handa se **vrátí** (stacky z posledního dokončeného snapshotu před handou, zaznamenané akce se neopakují, viz zadání) a hra pokračuje další handou.

### 2.5 Systém nastavení

- **Centrální registr parametrů** v `packages/shared/settings`: každý parametr je záznam
  `{ key, label_cs, help_cs, type (Zod), default, min/max/step | enum, unit, category, dependsOn, mutability: anytime | betweenHands | beforeStart | adminOnly, secret?, appliesTo (cash/turnaj/…) }`.
  Texty (`label_cs`, `help_cs`) jsou **překladové klíče**, ne přímé řetězce (pravidlo „žádné texty v kódu“).
- Z registru se odvozují: TypeScript typy, validace na serveru, výchozí hodnoty, **automatický formulář** v UI (slider + pole, přepínače, segmentová tlačítka, skupiny a závislosti), nástroje pro AI asistenta/MCP, export/import JSON, migrace.
- **Vrstvy:** `globální výchozí → šablona → hra/stůl → hráč (+ přepsání pro zařízení)`. Ukládá se **jen to, co je přepsáno** (řídké záznamy `scope, scope_id, key, value`), efektivní hodnotu počítá `resolveSettings(scopes[])`, který u každé hodnoty vrací i **původ** (pro „odkud pochází / vrátit na zděděné“).
- **Validace konzistence:** pravidla `crossRules[]` (např. `min buy-in ≤ max buy-in`, součet procent = 100 %) s českou chybou navázanou na konkrétní pole.
- **Kdy lze měnit:** `mutability` hlídá server při každé změně. Změny „mezi handami“ se zařadí do fronty a použijí se při příští handě (`pending_changes`), tak aby se nikdy neměnila pravidla uprostřed handy.
- **Verze schématu a migrace:** každá šablona/motiv/export nese `schemaVersion`; migrace jsou čisté funkce `vN → vN+1`. Nový parametr bez migrace dostane výchozí hodnotu (u „Retro“ šablon hodnotu „vypnuto“, přes příznak `retroDefault`).
- **Synchronizace hráčova nastavení:** úložiště v DB, změna se rozešle po Socket.IO místnosti `user:{id}`, localStorage je jen cache.
- **Tajné parametry** (`secret: true`) jdou jinou cestou (viz 2.7), nikdy se nevrací klientovi, nejsou v exportu ani auditu.

### 2.6 Oprávnění a role

- **Katalog oprávnění** v kódu (`registerPermission({key, label_cs, desc_cs, category, limitsSchema?, scopable, ownAll?})`), moduly přidávají vlastní. Při startu se katalog synchronizuje do DB (tabulka jen pro referenci a pro editor rolí).
- **Role** = sada oprávnění + `power` (0–100) + barva + ikona. Přidělení (`role_assignments`) má **rozsah** (`global | series | tournament | table | channel + id`) a **platnost** (`valid_from/valid_to`). Zákazy (`deny`) mají přednost.
- **Rozhodovací funkce** `can(user, permission, {scope, resource, amount})` vrací `{allowed, reason, needsApproval}`. Vyhodnocuje: sjednocení rolí v rozsahu → zákazy → limity (za operaci, za den, počet současných her) → hierarchie síly (u správy uživatelů/rolí) → vlastní vs. cizí → princip čtyř očí.
- **Hierarchie síly:** při přidělování role se kontroluje `actor.maxPower > target.power`, `actor` má všechna oprávnění, která dává; změna vlastní role na vyšší je zakázána. Ochrana posledního hlavního administrátora v jedné transakci.
- **Čtyři oči:** akce označená jako schvalovaná vytvoří `approval_requests` (stav čeká), schválit ji smí jen jiná osoba s oprávněním; provedení proběhne znovu přes stejnou službu s ověřením.
- **Okamžitá platnost:** změna rolí vyvolá událost → server znovu spočítá oprávnění připojených uživatelů a pošle jim nový výpis (klient jen skrývá UI), spojení s nižšími právy se nevyhazují, jen se přepočítají.
- **Náhled „zobrazit jako uživatel“:** jen čtení – server vrací stav jako pro cílového uživatele, ale přijímá pouze „bezpečné“ čtecí příkazy. **Nikdy neposílá jeho skryté karty** (platí i pro adminy).
- **Audit log:** jedna tabulka, zapisuje se ze služeb (ne z handlerů), obsahuje aktéra, cíl, akci, před/po, IP, důvod, zdroj (`ui | assistant | api | mcp | cli`).

### 2.7 Tajné údaje

- Tabulka `secrets` (`key`, `ciphertext`, `nonce`, `key_version`, `last4`, `updated_by/at`). AES-256-GCM, hlavní klíč z `MASTER_KEY` v env nebo z Docker secret; při prvním startu bez klíče se vygeneruje a vypíše s návodem.
- API vrací jen `{nastaveno, last4}`. Logger má **maskovací vrstvu** (seznam citlivých polí + vzory), export nastavení secrets vynechává, audit log píše jen „klíč změněn“.
- Rotace klíče: příkaz CLI + tlačítko; přešifruje všechny řádky v transakci. Změna/smazání vyžaduje oprávnění + znovuzadání hesla.

### 2.8 Peníze: účetní kniha (zásadní)

- Dvojí zápis (double-entry): každý pohyb = `ledger_transactions` + 2 a více `ledger_entries` (účet, částka v celých číslech, směr), součet v transakci musí být **0**. Zůstatek účtu = součet záznamů (zároveň držím materializovaný zůstatek `accounts.balance` aktualizovaný v téže transakci s `SELECT … FOR UPDATE` a kontrolním jobem, který ho porovnává se součtem).
- **Typy účtů:** `wallet:{user}`, `table:{id}` (cash žetony na stole), `tournament_pool:{id}`, `house`, `fund:{id}`, `jackpot:{id}`, `escrow:{id}` (sázky/odměny), `system_mint` (vydání měny adminem: jediný zdroj nově vzniklé měny, vyžaduje oprávnění a audit).
- **Turnajové žetony nejsou v knize měny.** Mají vlastní tabulku `tournament_chip_ledger` (vydání při buy-inu, rebuy, addonu; stav stacku). Nikdy se nepřevádějí na měnu – převod nemá v kódu cestu (typově oddělené typy `Money` a `TournamentChips`).
- **Idempotence:** každý pohyb má `idempotency_key` (unikátní), takže opakované volání po výpadku neprovede nic dvakrát.
- **Invarianty (testované simulací):** (1) součet všech účtů kromě `system_mint` = −(součet `system_mint`), (2) cash: peněženky + stoly + domy/fondy = vydáno, (3) turnaj: žetony = vydané stacky, prize pool po výplatě = 0, (4) zůstatek peněženky ≥ −limit.
- Pád serveru/zrušení stolu: vrácení „na stole“ do peněženek podle posledního uloženého stavu, jedna transakce.

### 2.9 Komunikace v reálném čase

- Místnosti: `user:{id}`, `table:{id}` (hráči), `table:{id}:spectators` (zpožděný pohled), `channel:{id}`, `tournament:{id}`, `lobby`.
- Stav stolu se klientovi posílá jako **personalizovaný pohled** (`viewFor`). Nikdy se neposílá celý stav „všem“. Pro diváky se generuje zvlášť pohled se zpožděním (buffer).
- Verze stavu (`seq`) u každé zprávy; klient po výpadku požádá o plný stav (reconnect), pak dostává přírůstky.
- Akce klienta: `{tableId, seq, type, amount, requestId}`; server odmítne zastaralé `seq` nebo duplicitní `requestId`.

### 2.10 Klient

- **Mobile-first**, PWA (service worker, manifest, push). Stavové úložiště pro stůl se přepisuje jen serverovými pohledy (klient nic nepočítá „za server“, jen animuje).
- **Design tokeny:** CSS proměnné generované z motivu; Tailwind konfigurace odkazuje jen na tokeny (`bg-surface`, `text-primary`…). **ESLint pravidlo** zakáže barvy/pixely/fonty mimo tokeny. Kontrola kontrastu (WCAG) v testech pro každý vestavěný motiv, světlý i tmavý.
- **Překlady:** `i18next`, výchozí `cs`, klíče pro všechny texty (včetně chyb ze serveru: server vrací kód a parametry, ne větu).
- **Generovaný formulář nastavení:** jeden komponent `SettingsForm` čte registr a vykreslí vše.
- **Stůl:** vykreslování SVG/CSS, animace řízené časovými parametry z nastavení (každá prodleva zvlášť, násobitel rychlosti).

---

## 3. Datový model (hlavní tabulky)

Všechny částky `bigint` v nejmenších jednotkách. Všechna ID `uuid`. Všude `created_at/updated_at`.

### 3.1 Uživatelé, role, oprávnění
- `users` (id, nickname, email, email_verified_at, password_hash, avatar, status, locale, last_seen_at)
- `sessions`, `email_tokens` (hash, typ, platnost, použito), `invites` (kód, vytvořil, role, platnost, limit použití)
- `roles` (id, key, name, power, color, icon, is_system, is_locked)
- `role_permissions` (role_id, permission_key, effect allow/deny, limits jsonb)
- `role_assignments` (user_id, role_id, scope_type, scope_id, valid_from, valid_to, granted_by, reason)
- `approval_requests` (action, payload, requested_by, status, decided_by, decided_at)
- `audit_log` (actor_id, action, target_type, target_id, before, after, ip, source, reason, at)
- `user_requests` (typ: dobití/role/schválení, stav, fronta)

### 3.2 Nastavení
- `settings_values` (scope_type: global | template | game | table | user | user_device, scope_id, key, value jsonb, updated_by) – unikátní (scope, key)
- `settings_templates` (id, name, kind, owner_id, is_builtin, schema_version, payload jsonb, tags)
- `settings_pending` (scope, key, value, apply_at: next_hand | next_level)
- `settings_schema_meta` (aktuální verze, migrace)
- `secrets` (viz 2.7)

### 3.3 Účetní kniha
- `ledger_accounts` (id, type, owner_type, owner_id, balance, currency_id)
- `ledger_transactions` (id, kind, game_id, hand_id, idempotency_key, created_by, reason, meta, at)
- `ledger_entries` (transaction_id, account_id, amount, seq) + constraint: součet v transakci = 0 (kontrola v kódu i v testu)
- `currencies` (název, symbol, desetinná místa; 1 aktivní, ale připraveno)
- `tournament_chip_events` (tournament_entry_id, kind, amount, at)

### 3.4 Hry, hráči, handy
- `games` (id, kind: cash | tournament | live_cash | live_tournament, variant, status, template_id, owner_id, series_id, evening_id, scheduled_for, started_at, ended_at, settings_snapshot)
- `tables` (id, game_id, table_no, seats, status, state_snapshot jsonb, state_seq) – **tabulka stolů oddělená od her** (turnaj přes více stolů)
- `seats` (table_id, seat_no, user_id, stack, status: active | sitting_out | disconnected, joined_at)
- `game_entries` (id, game_id, user_id, entry_no, kind: buyin | rebuy | reentry, paid, chips_issued, busted_at, finish_place, payout, bounty_won) – účast v turnaji/cash sezení
- `hands` (id, table_id, game_id, hand_no, level, button_seat, started_at, ended_at, dealer_deck_commit)
- `hand_players` (hand_id, user_id, seat, start_stack, hole_cards (uloženo, viditelné jen po skončení handy podle pravidel), net_result, showed)
- `hand_actions` (hand_id, seq, user_id, street, type, amount, at, time_used, time_bank_used)
- `hand_pots` (hand_id, pot_no, run_no, amount, eligible, winners)
- `hand_equity` (hand_id, street, run_no, player_id, win_pct, split_pct) – pro statistiky štěstí
- `blind_structures` (id, name, levels jsonb) / `blind_levels` – editor levelů
- `tournaments` (game_id, blind_structure_id, payout_structure jsonb, rebuy_rules, addon_rules, bounty_rules, late_reg, level_clock state)
- `payout_tables`, `payout_presets`
- `deals` (tournament_id, method, proposal jsonb, status, votes → vote_id)
- `bounties` (entry_id, base, progressive_part) / `bounty_events`
- `scheduled_events` (id, kind, run_at, payload, status, attempts, locked_by) – **všechny časované události**
- `series`, `series_standings`, `evenings`

### 3.5 Hlasování
- `polls` (id, type, config jsonb: pravidla oprávnění, váhy, kvórum, většina, tajnost, termíny, navázaná akce, zdroj: game_deal | game_rit | pause | user)
- `poll_options`, `poll_eligibility_snapshots`, `poll_votes` (u tajného hlasování bez vazby na hlas, jen `poll_participation`), `poll_results`

### 3.6 Komunita
- `chat_channels`, `chat_members`, `chat_messages` (včetně `reply_to`, `edited_at`, `deleted_by`), `chat_reactions`, `dm_threads`, `chat_mutes`, `chat_search` (tsvector index)
- `sound_emotes` (soubor, délka, vlastník, stav schválení, kategorie), `user_emote_favorites`, `emote_events` (pro limity)
- `push_subscriptions`, `notifications`, `email_queue` (+ `email_templates`)

### 3.7 Statistiky, postup, vzhled
- `player_stats_*` (agregace přepočitatelné z `hands`), `seasons`, `leaderboards` (materializované)
- `player_xp_events` (typ, hodnota, zdroj), `player_levels`, `achievements`, `user_achievements`
- `ratings` (user_id, scope: tournament | cash, mu, sigma, display, provisional, season_id), `rating_events` (game_id, složky změny, aby šlo vysvětlit „+18 za umístění…“), možnost přepočtu z historie
- `themes` (id, owner, is_builtin, schema_version, light jsonb, dark jsonb, shared, approved), `theme_assets`
- `cosmetics`, `user_cosmetics`

### 3.8 Rozšiřující moduly
`bets`, `bet_stakes` (vazba na `escrow` účty), `head_bounties`, `player_notes`, `personal_limits`, `api_tokens` (hash, scope, platnost), `webhooks`, `webhook_deliveries`, `mqtt_config` (přes settings), `tv_devices` (tokeny), `live_game_logs`, `ai_prompts` (+ verze), `ai_usage`, `mcp_call_log`.

### 3.9 Klíčové vztahy (stručně)
`users 1–N game_entries N–1 games 1–N tables 1–N hands 1–N hand_actions`; `games 1–1 tournaments`; `ledger_transactions` se váže na `games/hands`; `role_assignments` na `users`+`roles`+rozsah; `settings_values` na libovolný rozsah. Všechny cizí klíče bez pevných limitů (počet míst, levelů, rebuyů je jen řádky, ne sloupce).

---

## 4. Fáze: rozpis na kroky

Úpravy oproti číslování v zadání (zdůvodnění v kap. 5): **fázi 1 dělím na 1A a 1B**, **minimální účetní kniha a minimální stub oprávnění přicházejí už do fáze 1**, **společný hlasovací engine se staví ve fázi 4**, **fázi 6 dělím na 6A, 6B, 6C**.

Každá fáze končí: spuštěná aplikace, testy zelené, shrnutí „co funguje / co zbývá“, aktualizace `docs/STAV.md`, commity po malých celcích.

### Fáze 0: Základ (malá, cca 0,5 dne)
1. Monorepo (pnpm), TypeScript, ESLint, Prettier, Vitest, Husky/CI skript.
2. Docker Compose (app + postgres), `.env.example`, healthcheck, první migrace Drizzle.
3. `docs/STAV.md`, kostra README.
4. **Spike enginu** (rozhodovací brána, viz kap. 1) a zápis rozhodnutí.

### Fáze 1A: Nastavení, tokeny a jádro
1. Registr nastavení (`packages/shared/settings`): typ parametru, kategorie, závislosti, `mutability`, `crossRules`.
2. `resolveSettings` s vrstvami a původem hodnoty; testy dědičnosti.
3. Generovaný formulář (slidery + pole, přepínače, segmentová tlačítka, závislosti, chyby česky).
4. Šablony: uložení, kopie, export/import JSON, `schemaVersion` a migrace; první 3 vestavěné šablony (Cash – Klasika, Retro – Kuchyňský stůl, Cash – Rychlovka).
5. Design tokeny: schéma, generování CSS proměnných, světlý/tmavý/auto, přepnutí za běhu, 2 motivy (klasický zelený, vysoký kontrast), ESLint pravidlo proti natvrdo psaným stylům.
6. Překladový systém (i18next, `cs`), pravidlo „žádné texty v kódu“.
7. Dočasný systém „vlastník/uživatel“ (bez rolí): jen jeden vestavěný admin pro vývoj, rozhraní `can()` už s finálním podpisem (implementace se vymění ve fázi 2).

### Fáze 1B: Engine, stůl a cash game
1. `PokerEngineAdapter` + kontrolní sada testů (side poty, heads-up, dead button, split pot, lichý žeton).
2. `GameVariant` (NLHE) + limity sázek (no-limit; rozhraní pro pot-limit/fixed).
3. `TableActor`: sériová fronta, ukládání snapshotu, obnova po restartu.
4. Modulový systém (registrace, háčky, schémata modulů), první moduly: ante, BB ante, straddle (UTG, Mississippi), pravidla nových hráčů (čekat na BB / dead blind), heads-up pravidla.
5. **Minimální účetní kniha** (double-entry, `system_mint`, `wallet`, `table`), buy-in, top-up, rebuy, cash-out, hit-and-run ochrana, čekací listina.
6. Časovač tahu (serverový) a základní time bank (zásobník + na handu); plné varianty doplním ve fázi 3 nebo 4 (viz níže), ale rozhraní `TimeBankPolicy` je hotové.
7. Časování průběhu handy: všechny prodlevy z nastavení, násobitel rychlosti.
8. Maskované pohledy pro hráče a diváky; **test: klient nikdy nedostane cizí karty**.
9. Základní UI stolu: ovál, místa, karty (SVG, tokeny), akční lišta se sázkami a předvolbami, pot a side poty, přepínač měna/BB, animace rozdání.
10. Šance na výhru při dokládání (přesný výčet, vlastní nastavení zobrazení).
11. Jednoduchý bot + **simulační test** tisíců hand (invarianty cash).
12. Testy: side poty s více all-in, straddle, heads-up, časování (fake timers), maskování, šance (AA vs KK atd.).

### Fáze 2: Účty, role, peníze, lobby, chat
1. Účty: registrace přes pozvánku, argon2, session v httpOnly cookie, profil, avatar.
2. Katalog oprávnění + role + přidělení s rozsahem a platností; hierarchie síly; limity; čtyři oči; audit log; ochrana posledního hlavního administrátora; CLI nouzová obnova.
3. GUI správy rolí (seznam, editor, matice, hromadné přidělení, export/import, „zobrazit jako“).
4. Hlavní administrátor při prvním startu, předpřipravené role.
5. Tajné údaje (šifrování, maskování v logu, rotace klíče, znovuzadání hesla).
6. E-mail: SMTP v GUI (Gmail jako výchozí), testovací e-mail, fronta, denní strop, ověření účtu, obnova hesla, změna e-mailu, šablony e-mailů s náhledem.
7. Rozšíření účetní knihy: počáteční vklad, dobíjení s limity a schvalováním, žádosti o dobití, přehled knihy, vyúčtování (minimální převody).
8. Lobby: seznam stolů, filtry, vytvoření hry, pozvánkový odkaz, čekárna, přihlížení.
9. Chat: kanály, soukromé zprávy, online stav, píše…, nepřečtené, trvalá historie.
10. Reconnect z libovolného zařízení, synchronizace hráčova nastavení napříč zařízeními přes Socket.IO.
11. Podmínky použití a text „měna nemá peněžní hodnotu“ (registrace, patička, vyúčtování; text upravitelný).
12. Testy oprávnění (každá akce a zpráva), tokenů, e-mailů (Mailpit), invarianty knihy.

### Fáze 3: Turnaje, výplaty a poplatky
1. Datový model turnaje (včetně `tables` oddělených od `games`), turnajové žetony mimo knihu měny.
2. Freezeout, rebuy/addon/re-entry, late reg, hodiny levelů (čas nebo počet hand), přestávky, editor levelů + generátor podle cílové délky.
3. Prize pool jako účet turnaje, počet placených míst, výplatní tabulky a předvolby, sliderové procenta s dorovnáním na 100 % a zámky, bublina, zaokrouhlování.
4. House cut, příspěvky do fondů, garance (overlay), účet domu a fondů, přehled pro pokladníka, průhlednost pro hráče.
5. Rake, strop, no flop no drop, time charge, rakeback, jackpoty (bad beat, high hand, royal flush).
6. Živý náhled výplat a poplatků v UI.
7. Plné varianty time banku (time chips, šachové hodiny, Fischer, Bronstein, shot clock, call the clock, čas při odpojení).
8. Vyúčtování (cash + turnaje, rozpad).
9. Další vestavěné šablony (freezeout, rebuy+addon, re-entry, turbo, hyper, deep stack, WTA, heads-up, freeroll, retro) + simulace odhadu délky.
10. Testy: součty výplat, zaokrouhlení, garance, rake, bad beat, turnajové žetony nikdy neprojdou do peněženky, simulace turnajů s boty.

### Fáze 4: Bounty, dealy, speciální prvky, hlasovací engine
1. **Společný hlasovací engine (jádro):** pravidla oprávnění (zatím základní podmínky), váhy, kvórum, většiny, časový limit, tajnost; použije se pro deal, run it twice a pauzu.
2. Fixní bounty, PKO, mystery bounty, split poty a vícenásobná vyřazení.
3. Dealy: ICM, chip chop, rovným dílem, vlastní částky, srovnání vedle sebe, ponechání části na hru.
4. Run it twice/třikrát, rabbit hunt, ukázání karet, 7-2 bonus, bomb pot, automatické otočení karet při all-inu.
5. Dialogy u stolu pro hlasování.
6. Šablony: bounty, PKO, mystery, Divoký večer, Heads-up cash, Limit Hold'em (fixed-limit v adaptéru).
7. Testy: split poty, PKO, ICM, run it twice s více poty, hlasování.

### Fáze 5: Plánované turnaje
1. Plánovač nad `scheduled_events` (restart-safe), časové pásmo Europe/Prague, opakování (pravidla typu „každý první čtvrtek“).
2. Registrace, odhlášení, vrácení buy-inu, automatický start a rozsazení, sit-out neonline hráčů.
3. Min/max hráčů: zrušit, odložit, začít.
4. Pojistky bez admina: pauza při nedostatku hráčů, hlasování o pauze.
5. Upozornění: aplikace, web push (VAPID), e-mail; kalendář, ICS.
6. Série a ligy, bodování, finálový turnaj.
7. Test s posunutým časem: celý turnaj bez zásahu, zrušení při nedostatku hráčů, restart uprostřed.

### Fáze 6A: Chat navíc, zvukové emotikony, statistiky
1. Zmínky, odpovědi, reakce, obrázky/GIFy, moderace, ztlumení, propojení s hrou, push.
2. Zvukové emotikony: nahrávání, ořez, normalizace (ffmpeg v kontejneru), knihovna, limity, schvalování, sekce v nastavení.
3. Statistiky (VPIP, PFR, 3-bet…), žebříček, sezóny, historie hand s přehráním.

### Fáze 6B: XP, hodnosti, rating
1. XP, křivka levelů, hodnosti, úspěchy, ochrana proti farmení.
2. Rating (OpenSkill), výměna při vyřazení, EV korekce, divize, provizorní rating, neaktivita, sezónní reset, zpětný přepočet s náhledem dopadu.
3. Testy z kap. „Kvalita a testy“ (nulový součet, simulace botů různé síly).

### Fáze 6C: Ankety
1. Rozšíření hlasovacího jádra o plný editor podmínek (A/NEBO/kromě), váhy, živý počet oprávněných, typy anket (včetně Doodle).
2. Karty v chatu a v lobby, navázané akce v mezích oprávnění zakladatele.

### Fáze 7: Editor vzhledu
Editor s živým náhledem, kontrola kontrastu, simulace barvosleposti, undo/redo, vestavěné motivy (Kasino, Noční, Minimalistický, Retro…), sdílení a schvalování, export/import.

### Fáze 8: Živá hra, TV režim, hlasatel, herní večer
Režim živé hry (hodiny, evidence), TV režim (tokeny, zpožděný přenos), hlasatel (prohlížeč, Piper/Wyoming, Google TTS, cache), herní večer a souhrn.

### Fáze 9: Sociální a ekonomické doplňky
Sázky (escrow), odměna na hlavu, sdílení a rozbor hand, handa večera, znělky, kosmetika a obchod, poznámky o hráčích, osobní limity.

### Fáze 10: Integrace
MQTT s Discovery, odchozí webhooky (HMAC, Discord), REST API + OpenAPI, osobní tokeny.

### Fáze 11: AI asistent a MCP
Nástroje generované ze schématu a katalogu oprávnění, návrh „před → po“, potvrzení, pískoviště, verze promptů, poskytovatelé (Gemini výchozí), MCP server.

### Fáze 12: Doladění
PWA, zvuky, animace, výkonnostní a zátěžové testy, bezpečnostní kontrola, finální README (instalace do LXC, Nginx Proxy Manager včetně Websockets Support, záloha, Gmail krok za krokem, nouzová obnova).

### Průřezové úkoly (běží celou dobu)
- **Zálohy:** denní `pg_dump` s retencí (kontejner/cron) – nejpozději ve fázi 2.
- **Retenční a úklidové joby** (historie hand, tokeny, soubory).
- **Logování** s maskováním, metriky stolů, healthcheck.
- **Přístupnost** (kontrast, klávesnice, „omezit pohyb“).

---

## 5. Otevřené otázky, nesrovnalosti a návrhy

### 5.1 Otázky, které potřebuji rozhodnout (nebo potvrdit mou volbu)

1. **Engine:** souhlasíte s `@pokertools/engine` a s tím, že po půldenním ověření (spike) případně přepnu na `poker-ts`?
2. **Fork enginu:** pokud engine neumí zadat straddle/BB ante zvenčí, smím ho zkopírovat do repozitáře (licence MIT dovolí) a upravit? (Doporučuji ano, pokud to bude nutné.)
3. **Pořadí fází:** schvalujete rozdělení 1 → 1A/1B a 6 → 6A/6B/6C a přesun minimální účetní knihy a hlasovacího jádra, jak je popsáno výše? (Důvod: cash game potřebuje peněženku a deal/run it twice potřebují hlasování dřív, než je ve fázích zadání.)
4. **Doména:** v dokumentaci je zástupná `poker.example.cz`; skutečnou adresu nastavuje majitel v `.env` (PUBLIC_URL).
5. **Fixed-limit:** šablona „Retro – Limit Hold'em“ je ve vestavěném katalogu. Má engine fixed-limit? (Spike ověří.) Pokud ne, bude fixed-limit součást vlastního adaptéru. Nechám ve fázi 4 – je to v pořádku?
6. **Obrázky/GIFy v chatu a zvuky:** kam se mají ukládat (Docker volume) a jaká kvóta? Navrhuji volume `uploads` s kvótou nastavitelnou v GUI (výchozí 2 GB). Souhlas? Převody zvuku potřebují `ffmpeg` v kontejneru (zvětší image o cca 80 MB).
7. **Počet současných stolů:** je cílová zátěž opravdu do desítek stolů? (Rozhoduje, zda stačí jeden Node proces. Pro 4–9 hráčů ano.)
8. **E-mail a ověření:** má být ověření e-mailu ve výchozím stavu povinné? (Navrhuji ano, vypnutelné.)
9. **Jazykové varianty:** UI jen česky, ale texty přes překladové soubory. Mám rovnou připravit anglický soubor prázdný, nebo jen strukturu?
10. **Velikost bezpečnostního modelu pro TV a přihlížející:** výchozí zpoždění přihlížejících (navrhuji 30 s, nastavitelné).

### 5.2 Nesrovnalosti a rizika v zadání, na která narážím

- **Fáze 1 je obrovská** (nastavení + tokeny + engine + moduly + cash + UI + testy). Proto dělení 1A/1B a časná kontrola s vámi po 1A.
- **Cash game ve fázi 1 vyžaduje peněženku**, ale účty a účetní kniha jsou až ve fázi 2. Řeším minimální knihou ve fázi 1 (viz výše).
- **„Admin“ ve fázi 1 vs. role ve fázi 2:** oprávnění se kontrolují přes finální rozhraní `can()` od začátku, implementace se zamění ve fázi 2.
- **Hlasovací engine** je potřeba už ve fázi 4 (deal, run it twice), ale ankety jsou až v 6. Řeším společným jádrem v 4 a rozšířením v 6C.
- **Time bank:** zadání má mnoho variant; základ dám do 1B, kompletní sadu do fáze 3 (kdy mají smysl turnajové režimy a šachové hodiny).
- **Rakeback a jackpoty vs. „žádná peněžní hodnota“:** v pořádku, protože je to virtuální měna. Přesto bych do podmínek přidal větu, že rake/jackpoty jsou herní mechanika.
- **Obchod s kosmetikou za měnu:** peníze jdou na účet domu. Ověřte, že to nechcete obejít „zdarma“ pro adminy (navrhuji nastavitelné).
- **Tajné hlasování** („ani admin nevidí jednotlivé hlasy“) znamená, že v DB nesmí být vazba hlasující → volba. Implementuji oddělením tabulek (`poll_participation` bez volby a `poll_ballots` bez uživatele) a bez časových razítek, která by šla spárovat.
- **Hole cards v DB:** ukládám je pro historii, ale API je vydává jen podle pravidel (po skončení handy, jen ukázané). Doporučuji uložit je šifrovaně nebo ve zvláštní tabulce s omezeným přístupem. Navrhuji zvláštní tabulku `hand_private` a v testu ověřit, že žádný dotaz služby je nevrací před koncem handy.
- **Míchání:** zadání říká Fisher–Yates přes `crypto.randomInt`. Engine používá `getSecureRandom()`. Ve spike ověřím, že jde balíček vložit zvenčí (potřebuji ho pro run it twice), a jinak shuffle dělám sám v adaptéru.
- **Šance na výhru** u PLO: výčet kombinací je dražší → Monte Carlo (jak zadání říká).

### 5.3 Návrhy na vylepšení (volitelné)

1. **Ověřitelná férovost míchání (commit-reveal):** na začátku handy se zveřejní hash balíčku, po handě se zveřejní balíček a sůl. Hráči si mohou ověřit, že se nepodvádělo. Malá cena, velký efekt na důvěru u kamarádů.
2. **Pauza a zotavení z chyby stolu:** tlačítko „Obnovit stůl“ pro ředitele, které stůl vrátí z posledního snapshotu, bez ztráty peněz.
3. **„Zkušební režim“ (cvičné žetony)** pro nováčky: stůl, kde se nehraje o měnu a nic se nezapisuje do knihy.
4. **Řízení tempa:** kvůli rozdílným zařízením umožnit, aby hráč mohl zapnout „akce bez animací“ pro sebe.
5. **Detekce kolizí/podezřelé hry** (chip dumping, spolupráce): upozornění pro ředitele, ne automatické tresty.
6. **Zálohy:** kromě `pg_dump` ještě automatický export knihy do CSV a kontrolní součet; test obnovy v CI.
7. **Pozvánky na stůl přes odkaz s QR kódem** (hodí se pro hospodu).
8. **Monitorovací stránka stavu** (počet stolů, latence, fronta e-mailů, velikost DB) pro hlavního administrátora.
9. **Kolo „čekací doba před akcí“ (protokol proti náhodným kliknutím):** potvrzení u all-inu nad X % stacku (nastavitelné).
10. **Hot-seat/lokální režim pro testování** vlastních nastavení bez dalších lidí (boti u stolu), užitečné pro editor šablon a ladění.
11. **Export historie hand** ve standardním formátu (PokerStars-like) pro externí analýzu.

### 5.4 Co jsem při přípravě plánu ověřil a co ne
- Ověřeno z README: funkce `@pokertools/engine` (view, snapshot, audit součtu, rake, turnajový modul, 362 testů, MIT) a funkce `poker-ts` (side poty, ante, MIT, jen Hold'em).
- **Neověřeno:** stáří a aktivita údržby obou knihoven, přesné chování side potů v hraničních případech, to ověří spike ve fázi 0.
