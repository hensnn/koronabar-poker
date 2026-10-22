# Napojení na Home Assistant (MQTT) – postup krok za krokem

Aplikace posílá události (start a konec turnaje, nový level, přestávka, vyřazení, all-in, velký pot…) do MQTT brokeru. Home Assistant je z něj čte a vytvoří z nich entity a automatizace (blikání světla při all-inu, oznámení vítěze apod.). Aplikace jen **posílá**, příkazy z Home Assistantu nepřijímá. Skrytá herní data (cizí karty, balíček) se neposílají nikdy.

## 0. Co potřebuješ
- Home Assistant s integrací MQTT (stačí doplněk **Mosquitto broker**).
- Aplikace běžící na serveru, který se na broker **dostane po síti**. To je hlavní rozhodnutí, viz krok 1.

## 1. Rozhodni, kudy se aplikace dostane k brokeru

| Kde běží aplikace | Kde běží Home Assistant | Doporučení |
|---|---|---|
| Doma, ve stejné síti | Doma | Adresa brokeru = místní IP Home Assistantu (např. `192.168.1.20`), port `1883`, bez TLS. |
| Na serveru v internetu | Doma | **Nevystavuj port 1883 do internetu.** Nejbezpečnější je VPN (např. Tailscale/WireGuard) mezi serverem a domácí sítí, adresa brokeru je pak adresa v VPN. Druhá možnost: broker s TLS na portu `8883`, jméno a heslo, s certifikátem od veřejné autority (např. Let's Encrypt). |
| V Dockeru na stejném počítači jako broker | – | Adresa nesmí být `localhost` (to je ten kontejner sám), použij IP počítače nebo `host.docker.internal`. |

Pozor: klient v aplikaci umí TLS jen s běžně důvěryhodným certifikátem. Vlastní (self-signed) certifikát nepřijme, použij síť bez TLS uvnitř VPN nebo veřejný certifikát.

## 2. Připrav broker v Home Assistantu
1. **Nastavení → Doplňky → Obchod s doplňky → Mosquitto broker → Instalovat → Spustit** (zapni i „Spustit při startu“).
2. **Nastavení → Zařízení a služby**: objeví se nalezená integrace **MQTT** → **Nastavit**. Pokud ne, přidej ji ručně (Přidat integraci → MQTT).
3. Založ **uživatele jen pro poker**: **Nastavení → Lidé → Uživatelé → Přidat uživatele** (např. `poker`, silné heslo). Mosquitto doplněk používá uživatele Home Assistantu. Uživatel nepotřebuje správcovská práva.
4. Zapiš si: adresu brokeru, port (1883, nebo 8883 s TLS), uživatele, heslo.

## 3. Nastav aplikaci
Přihlas se jako správce.
1. **Správa → Nastavení → Napojení ven** (kategorie „Napojení ven“):
   - zapni **Napojení ven** (hlavní vypínač),
   - zapni **MQTT**,
   - **Adresa MQTT brokeru** (z kroku 1), **Port**, **Uživatel**,
   - **Předpona témat** (výchozí `koronabar`; změň jen, když chceš víc nezávislých instalací),
   - **TLS** zapni jen pro port 8883 s veřejným certifikátem,
   - **MQTT Discovery** nech zapnuté, **předpona Discovery** nech `homeassistant` (shoduje se s výchozím nastavením Home Assistantu).
2. **Správa → Tajné údaje**: vyplň **heslo k MQTT**. Heslo se ukládá šifrovaně a nikdy se nezobrazí zpět.
3. **Správa → Napojení ven**: zaškrtni události, které se mají do MQTT posílat. All-in a chat jsou výchozí vypnuté, protože jsou časté.
4. Klikni na **Otestovat spojení**. Při úspěchu uvidíš zprávu o odeslaném stavu a Discovery. Při chybě aplikace napíše důvod:
   - `BAD_CREDENTIALS` / `NOT_AUTHORIZED` – špatné jméno nebo heslo,
   - `ECONNREFUSED`, `TIMEOUT` – broker není na té adrese a portu dostupný (firewall, špatná IP, kontejner),
   - `ENOTFOUND` – adresa neexistuje.

## 4. Co se objeví v Home Assistantu
Díky MQTT Discovery vznikne zařízení **KoronaBar** se senzory: stav turnaje, název turnaje, level, počet hráčů, prize pool a poslední událost. Najdeš je v **Nastavení → Zařízení a služby → MQTT → Zařízení**. Když aplikace není připojená, entity se zobrazí jako nedostupné.

Témata zpráv (pro vlastní automatizace):
- `<předpona>/event/<událost>` – jednotlivé události, například `koronabar/event/player.allIn`. Tělo je JSON `{ "version": 1, "event": "...", "at": <čas>, "data": { ... } }`.
- `<předpona>/state` – aktuální stav turnaje a poslední událost (retained, obnovuje se asi každou minutu).
- `<předpona>/status` – `online` když aplikace žije.

Dostupné události: `tournament.registration`, `tournament.started`, `tournament.level`, `tournament.break`, `tournament.breakEnd`, `tournament.finished`, `player.eliminated`, `player.allIn`, `hand.bigPot`, `hand.badBeat`, `chat.message`, `poll.created`, `evening.closed`.

## 5. Ukázkové automatizace
Vlož v **Nastavení → Automatizace a scény → Přidat automatizaci → Upravit v YAML**.

Bliknutí světla při all-inu (nezapomeň v aplikaci zapnout událost `player.allIn`):
```yaml
alias: Poker all-in
trigger:
  - platform: mqtt
    topic: koronabar/event/player.allIn
action:
  - service: light.turn_on
    target: { entity_id: light.herna }
    data: { flash: short }
```

Oznámení na telefon při konci turnaje:
```yaml
alias: Poker vítěz turnaje
trigger:
  - platform: mqtt
    topic: koronabar/event/tournament.finished
action:
  - service: notify.mobile_app_telefon
    data:
      message: "Turnaj {{ trigger.payload_json.data.name }} vyhrál {{ trigger.payload_json.data.winner }}"
```

Pokud jsi změnil předponu témat, nahraď `koronabar` svou.

## 6. Když to nefunguje
- V aplikaci v **Správa → Napojení ven** je log doručení; chyby spojení tam jsou vidět.
- V Home Assistantu: **Nastavení → Zařízení a služby → MQTT → Konfigurovat** → „Poslouchat téma“ zadej `koronabar/#` a klikni na „Začít poslouchat“; po kliknutí na Otestovat spojení musí přijít zprávy `koronabar/status` a `koronabar/state`.
- Entity se neobjevily: zkontroluj, že předpona Discovery v aplikaci je stejná jako v integraci MQTT (výchozí `homeassistant`), a že je Discovery zapnuté. Pak znovu klikni na Otestovat spojení (Discovery se posílá po každém novém připojení).
- Změnil jsi předponu témat: staré entity zůstanou v Home Assistantu nedostupné, smaž je ručně (Zařízení → KoronaBar → Smazat).
- Broker přes internet: nejdřív to ověř z VPN nebo z domácí sítě, teprve potom zveřejňuj.
