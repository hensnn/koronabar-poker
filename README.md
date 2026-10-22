# KoronaBar Poker

Vlastní webová pokerová herna pro domácí hry přátel přes internet. Cash game i turnaje, virtuální měna **bez peněžní hodnoty** (žádné platby, směna ani výběry). Běží na tvém serveru pod tvou doménou (v návodu je jako příklad `poker.example.cz`).

> Stav projektu: všech 12 fází ze zadání je hotových a pokrytých testy (cash i turnaje, plánování, chat, zvukové emotikony, XP a rating, ankety, statistiky, vzhled, živá hra a TV, hlasatel, večery, sázky, limity, kosmetika, Home Assistant a API, AI asistent a MCP, PWA). Podrobnosti a odložené drobnosti jsou v `docs/STAV.md`, výsledek poslední kontroly (testy, simulace her, známé nedostatky) v `docs/AUDIT.md`.

## Co potřebuješ

- Server nebo LXC kontejner s Linuxem (stačí malý, 1 GB RAM).
- Nainstalovaný **Docker** a **Docker Compose**.
- Nginx Proxy Manager (NPM), který už obsluhuje tvou doménu.
- Vlastní doménu (stačí bezplatná dynamická DNS) nasměrovanou na tvůj server.

## Instalace krok za krokem

Podrobný návod pro LXC kontejner v Proxmoxu s přesnými příkazy (a instalačním skriptem pro hostitele) je v `docs/NASAZENI.md`.


1. **Stáhni projekt** na server (například `git clone`, nebo zkopíruj složku).
2. **Vytvoř soubor `.env`**:
   ```bash
   cp .env.example .env
   ```
3. **Uprav `.env`** (například v `nano .env`):
   - `POSTGRES_PASSWORD` – nastav dlouhé náhodné heslo k databázi.
   - `ADMIN_NICKNAME` – přezdívka hlavního administrátora (ty).
   - `ADMIN_PASSWORD` – heslo hlavního administrátora (min. 12 znaků). Když ho nevyplníš, vygeneruje se a vypíše do logu při prvním startu.
   - `MASTER_KEY` – šifrovací klíč pro tajné údaje (např. heslo k e-mailu). Vygeneruješ ho příkazem `openssl rand -hex 32`.
   - `PUBLIC_URL` – tvoje veřejná adresa (například `https://poker.example.cz`); platí jako výchozí, dokud ji nezměníš v administraci v Nastavení → Systém.
4. **Spusť**:
   ```bash
   docker compose up -d --build
   ```
   První sestavení trvá několik minut.
5. **Zkontroluj**, že vše běží:
   ```bash
   docker compose ps
   docker compose logs app --tail 30
   ```
   V logu uvidíš „Vytvořen hlavní administrátor“.

## Kontrolní seznam před prvním spuštěním

- [ ] Na serveru je Docker a Docker Compose (`docker compose version`).
- [ ] V `.env` je dlouhé `POSTGRES_PASSWORD`, `ADMIN_PASSWORD` (min. 12 znaků) a vygenerovaný `MASTER_KEY` (`openssl rand -hex 32`). `MASTER_KEY` máš uložený i ve správci hesel.
- [ ] Port z `.env` (výchozí 3000) je dostupný jen z Nginx Proxy Manageru; pokud je NPM na stejném stroji, můžeš v `docker-compose.yml` omezit `ports` na `127.0.0.1:3000:3000`.
- [ ] `docker compose ps` ukazuje `app` jako `healthy` a `db` jako `healthy`.
- [ ] Po přihlášení jsi v **Správa → Nastavení → Systém** zkontroloval veřejnou adresu a v **Správa → Tajné údaje** zadal, co chceš používat (e-mail, hlasatel, AI, MQTT, Discord).
- [ ] Na telefonu sis aplikaci nainstaloval (Profil → Nainstalovat aplikaci) a povolil upozornění.
- [ ] Záloha: ověřil sis, že ve svazku `backups` přibývají soubory (`docker compose cp backup:/backups ./zalohy`).

## Nastavení Nginx Proxy Manageru

1. V NPM přidej **Proxy Host**.
2. **Domain Names:** `poker.example.cz`.
3. **Scheme:** `http`, **Forward Hostname/IP:** adresa serveru s Dockerem, **Forward Port:** `3000` (nebo hodnota `PORT` z `.env`).
4. Zapni **Websockets Support** (bez něj nebude fungovat hra ani chat).
5. Zapni **Block Common Exploits**.
6. Na záložce **SSL** vyber **Request a new SSL certificate** (Let's Encrypt), zapni **Force SSL** a **HTTP/2**.

Pak otevři `https://poker.example.cz` a přihlas se jako hlavní administrátor.

## První kroky po přihlášení

Krátké vysvětlení logiky hry a nastavení turnajů je v `docs/NAVOD-HRA.md`.


1. **Správa → Uživatelé / Pozvánky:** vytvoř pozvánky a pošli je kamarádům. Registrace je pouze na pozvánku.
2. **Správa → Pokladna:** dobij hráčům virtuální měnu (jde o interní účetnictví, ne o peníze).
3. **Hra → Stoly:** založte turnaj nebo cash stůl z šablony, nebo si uprav parametry.

## Orientace v aplikaci

Nahoře v hlavičce zleva doprava:

| Prvek | Co v něm je |
|---|---|
| **Ke stolu** | Vede ke stolu, u kterého sedíš (šedé, když nikde nesedíš). |
| **Lobby** | Úvodní stránka: účet, kde hraješ, **Stoly** (nahoře turnaje, dole cash game), žebříček, ankety a odkazy na chat a ankety. |
| **Hra** | Stoly, Živý cash, Večery, Chat, Ankety, Peněženka (včetně vyúčtování večera s filtrem Vše / Cash / Turnaje), Statistiky, Postup, Obchod. |
| **Nastavení** | Osobní nastavení (vzhled, hustota zobrazení, zvuky, panely, **Odhlásit**), Profil a **Správa**. |

Na telefonu jsou **Ke stolu** a **Lobby** vždy vidět, zbytek je pod tlačítkem **Nabídka** (tam je i asistent). Osobní nastavení jde mít zvlášť pro telefon a tablet a zvlášť pro počítač (druhá záložka v Nastavení). Jemnost rozmístění prvků ovládá **Hustota zobrazení** (Automaticky / Úsporná / Běžná / Volná).

Herní nastavení (blindy, časování, rake, speciální prvky, vše kolem turnajů) se nastavuje v **šablonách** (Správa → Šablony, včetně hromadné změny více šablon najednou) a při zakládání hry. Obecné nastavení ve Správě obsahuje jen pravidla celé aplikace. Podrobnosti jsou v `docs/NAVOD-HRA.md`.

## E-mail (odesílání pozvánek a upozornění)

Nastavuje se v **Správa → Tajné údaje** (heslo) a **Správa → E-mail** (server, port, odesílatel).

Příklad pro **Gmail**:
1. Na účtu Google zapni dvoufázové ověření.
2. V sekci „Hesla aplikací“ vytvoř nové heslo aplikace (16 znaků).
3. V aplikaci zvol předvolbu Gmail (server `smtp.gmail.com`, port `587`, zabezpečení STARTTLS), uživatel je celá e-mailová adresa, heslo je **heslo aplikace** (ne tvé běžné).
4. Použij tlačítko pro zkušební e-mail. Chyby se zobrazují srozumitelně česky.

Když e-mail nenastavíš, aplikace funguje dál, jen se nic neodesílá (pozvánky můžeš předávat odkazem).

## Zálohy

- **Databázi** automaticky zálohuje služba `backup` v `docker-compose.yml` (denně, drží posledních 14 dní). Soubory jsou v Docker svazku `backups`. Nastavení v `.env`: `BACKUP_KEEP_DAYS`, `BACKUP_EVERY_HOURS`.
- Zkopírovat zálohy ven z Dockeru:
  ```bash
  docker compose cp backup:/backups ./zalohy
  ```
- **Hlavní šifrovací klíč** (`MASTER_KEY`, nebo soubor `/data/master.key` v kontejneru) zálohuj **zvlášť od databáze**, nejlépe do správce hesel. Bez něj nejdou tajné údaje (např. heslo k e-mailu) dešifrovat; stačí je pak zadat znovu, hry a účty se tím neztratí.
- Obnova databáze ze zálohy:
  ```bash
  docker compose stop app
  gunzip -c zalohy/koronabar-RRRRMMDD-HHMMSS.sql.gz | docker compose exec -T db psql -U koronabar -d koronabar
  docker compose start app
  ```
  (Před obnovou je potřeba mít prázdnou databázi; při pochybnostech se poraď.)

## Nouzová obnova přístupu

Zapomněl jsi heslo hlavního administrátora? V kontejneru spusť:

```bash
docker compose exec app node dist/cli.js recover-admin PŘEZDÍVKA NOVÉ-HESLO
```

Další příkazy:

```bash
docker compose exec app node dist/cli.js list-admins   # vypíše hlavní administrátory
docker compose exec app node dist/cli.js rotate-key    # přešifruje tajné údaje novým klíčem
```

Poslední hlavní administrátor nejde smazat ani odebrat jeho roli.

## Aktualizace

```bash
git pull
docker compose up -d --build
```

Databáze se při startu migruje automaticky. Před větší aktualizací si pořiď zálohu.

## Napojení na Home Assistant, webhooky, Discord a API

Všechno se nastavuje v GUI. Vypínač a údaje najdeš v **Administrace → Nastavení → Napojení ven** (adresa a port MQTT brokeru, jméno, předpona témat, TLS) a hesla v **Administrace → Tajné údaje** (heslo k MQTT, adresa webhooku Discordu, podpisový klíč webhooků). Které události se kam posílají, vybereš zaškrtnutím v **Administrace → Napojení ven**. Skrytá herní data (cizí karty, balíček) se neposílají nikdy.

### Home Assistant přes MQTT
Podrobný postup krok za krokem (síť, broker, nastavení, řešení problémů) je v `docs/HOME-ASSISTANT.md`. Stručně:
1. V Home Assistantu zapni integraci **MQTT** (a doplněk Mosquitto broker, pokud ještě nemáš broker).
2. V aplikaci zapni **Napojení ven** a **MQTT**, vyplň adresu brokeru, port, jméno a v tajných údajích heslo.
3. V **Napojení ven** klikni na **Otestovat spojení**. V Home Assistantu se samy objeví entity: stav turnaje, název, level, počet hráčů, prize pool a poslední událost (MQTT Discovery).
4. Události chodí do témat `<předpona>/event/<událost>` (například `koronabar/event/player.allIn`), stav do `<předpona>/state`.

Ukázková automatizace: při all-inu bliknout světlem.

```yaml
automation:
  - alias: Poker all-in
    trigger:
      - platform: mqtt
        topic: koronabar/event/player.allIn
    action:
      - service: light.turn_on
        target: { entity_id: light.herna }
        data: { flash: short }
```

Ukázka: oznámení na telefon při vítězi turnaje.

```yaml
automation:
  - alias: Poker vítěz turnaje
    trigger:
      - platform: mqtt
        topic: koronabar/event/tournament.finished
    action:
      - service: notify.mobile_app_telefon
        data:
          message: "Turnaj {{ trigger.payload_json.data.name }} vyhrál {{ trigger.payload_json.data.winner }}"
```

All-in a chat jsou ve výchozím výběru MQTT vypnuté, zapneš je zaškrtnutím v administraci.

### Webhooky
V **Napojení ven** přidáš adresu a vybereš události. Každá zpráva je JSON `{ version, event, at, data }` a je podepsaná: hlavička `X-KB-Signature` obsahuje `sha256=` a HMAC-SHA256 z textu `<X-KB-Timestamp>.<tělo>`, klíčem je tajný údaj `webhook.signingSecret` (vznikne sám při prvním použití, můžeš ho přepsat vlastním). Při chybě se doručení opakuje s prodlužujícím se odstupem a každý pokus je vidět v logu, kde jde chybné doručení poslat znovu.

### Discord
V Discordu vytvoř webhook kanálu (Nastavení kanálu → Integrace → Webhooky), adresu vlož do tajných údajů (`discord.webhookUrl`), zapni **Discord** v nastavení a vyber události (výchozí: registrace do turnaje, konec turnaje, souhrn večera). Tlačítkem **Poslat zkušební zprávu** si to ověříš.

### REST API a osobní tokeny
V **Profilu → Přístupové tokeny** si vytvoříš token s vybraným rozsahem. Token nikdy nemůže víc než ty sám a jde kdykoli zrušit. Celou hodnotu uvidíš jen při vytvoření. Volání:

```bash
curl -H "Authorization: Bearer kbp_..." https://poker.example.cz/api/v1/tournaments
```

Dokumentace (OpenAPI) je na `/api/v1/openapi.json`. Počet volání za minutu a nejdelší platnost tokenu nastavíš v **Nastavení → REST API a tokeny**.

## AI asistent nastavení a MCP server

### Asistent v aplikaci
Asistent umí převést běžnou řeč na změny nastavení („zrychli blindy o polovinu“, „vypni zvukové emotikony u tohoto stolu“), založit nebo naplánovat turnaj, navrhnout anketu a vysvětlit, co který parametr dělá. **Nikdy nic nemění sám:** vždy ukáže přehled „před → po“ s vyznačením, kdy změna začne platit (hned, od další handy), a ty ji potvrdíš, upravíš, nebo zamítneš. Změnu provede stejná logika jako ruční změna, tedy s tvými oprávněními, pravidly „kdy lze měnit“ a zápisem do audit logu (se značkou „asistent“ a původním textem požadavku). Karty hráčů, balíček a soukromé zprávy asistent nikdy nedostane.

Zapnutí krok za krokem:
1. **Administrace → Tajné údaje:** vlož API klíč vybraného poskytovatele (Google Gemini je výchozí; klíč zdarma vytvoříš v Google AI Studio). Jiní poskytovatelé: Anthropic Claude, OpenAI, nebo vlastní rozhraní kompatibilní s OpenAI (adresu zadáš v nastavení).
2. **Administrace → Nastavení → AI asistent a MCP:** vyber poskytovatele a model, nastav denní limity (na hráče a celkem), teplotu a další. Tlačítkem **Otestovat spojení** v **Administrace → AI asistent** si to ověříš.
3. V pravém dolním rohu se hráčům s oprávněním objeví tlačítko **Asistent**. Dokud klíč chybí, asistent je skrytý a aplikace běží normálně.

V **Administraci → AI asistent** upravíš všechny prompty (systémový pokyn, pokyny podle kontextu, šablony textů, popisy nástrojů) s kontrolou proměnných a náhledem, vrátíš starší verzi nebo celé obnovíš výchozí texty, vyzkoušíš **pískoviště** (uvidíš odeslaný prompt, odpověď a návrh změn, nic se neprovede) a sleduješ spotřebu.

### MCP server (Claude, Home Assistant a další)
MCP umožní externí AI ovládat stejné nástroje. Adresa je `https://poker.example.cz/api/mcp`, přihlášení osobním tokenem s rozsahem **MCP** (Profil → Přístupové tokeny; rozsah MCP má jen správce a role s oprávněním „Používat MCP server“). Zapni ho v **Nastavení → AI asistent a MCP → MCP server**. Změny se navrhují voláním `propose_…` a potvrzují druhým voláním `confirm_proposal`. Jednotlivé nástroje jdou vypnout v **Administraci → AI asistent → Nástroje**, tam je i log volání.

Připojení z Claude Code (příklad):

```bash
claude mcp add --transport http koronabar https://poker.example.cz/api/mcp --header "Authorization: Bearer kbp_..."
```

Připojení z Home Assistantu: přidej integraci **Model Context Protocol** (typ HTTP), adresu `https://poker.example.cz/api/mcp` a hlavičku `Authorization: Bearer kbp_...`; nástroje pak nabídneš hlasovému asistentovi v nastavení jeho konverzačního agenta.

## Instalace jako aplikace (PWA), zvuky a animace

- **Instalace:** v Chrome nebo Edge se v **Nastavení** (osobní) objeví karta **Nainstalovat aplikaci** (nebo ikona instalace v adresním řádku). Na iPhonu a iPadu otevři v Safari nabídku **Sdílet → Přidat na plochu**. Aplikace pak běží v samostatném okně s vlastní ikonou a push upozornění chodí i při zavřeném prohlížeči (vyžaduje HTTPS, což zajišťuje Nginx Proxy Manager). Barvy úvodní obrazovky a lišty se berou z motivu v nastavení **Motiv instalované aplikace**.
- **Bez připojení:** aplikace se po ztrátě sítě otevře a ukáže, že jsi offline. Hra samotná potřebuje živé spojení, proto se data ze serveru nikdy neukládají do paměti prohlížeče.
- **Zvuky hry:** u stolu zní rozdání karet, žetony, check a fold, upozornění „jsi na tahu“, tikání před koncem času, začátek time banku, all-in a výhra. Každý zvuk i hlasitost si vypneš v **Nastavení → Osobní nastavení → zvuky hry** (zvukové emotikony se nastavují zvlášť). Na telefonu zavibruje, když jsi na tahu nebo ti dochází čas.
- **Animace:** rozdávání karet, vsazení, vítěz a „+částka“ se řídí tokeny motivu (zapnutí a rychlost v editoru vzhledu) a vypínají se i systémovým nastavením „omezit pohyb“.
- **Ikony** se generují příkazem `node scripts/make-icons.mjs` ze zdrojového obrázku v tomto skriptu.

## Vývoj (pro programátory)

- Před commitem spusť `pnpm typecheck`, `pnpm lint` (pravidla React hooků a základní chyby, oxlint) a `pnpm test`. Po změně vzhledu ještě `LOGIN=... PASSWORD=... node scripts/screenshots.mjs snimky` (snímky stránek pro počítač i mobil; běží vývojový server i web).
- Asistenta jde vyzkoušet bez klíče: spusť `node scripts/fake-ai.mjs` a v nastavení zvol poskytovatele „vlastní“ s adresou `http://localhost:3999/v1` (falešný model navrhne slevu v obchodě podle čísla ve zprávě).

```bash
pnpm install
pnpm test          # všechny testy
pnpm -r typecheck  # kontrola typů
```

Pro lokální běh bez Dockeru jsou v `.claude/launch.json` předpřipravené konfigurace (server na portu 3000 s vestavěnou databází, web na 5173). Bot pro zkoušení herních stolů: `pnpm --filter @kb/server exec tsx scripts/dev-bot.ts Botik 4`.

## Bezpečnost v kostce

- Server je jediná autorita: klient nikdy nedostane cizí karty ani stav balíčku.
- Karty se míchají kryptografickým generátorem náhodných čísel.
- Hesla jsou hašovaná (argon2), tajné údaje šifrované (AES-256-GCM) a nikdy se neposílají do prohlížeče, do logu ani do exportů.
- Měna je virtuální, všechny pohyby jdou přes účetní knihu a nic nemůže vzniknout ani zmizet.
