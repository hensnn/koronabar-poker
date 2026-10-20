/**
 * Katalog tajných údajů (API klíče a hesla zadávaná v GUI). Hodnoty se ukládají šifrovaně,
 * klientovi se nikdy nevrací víc než poslední 4 znaky, do logu ani exportu se nedostanou.
 */
export interface SecretDef {
  key: string;
  /** Oprávnění potřebné ke změně. */
  permission: string;
}

export const SECRETS: SecretDef[] = [
  { key: 'smtp.password', permission: 'email.spravovat_smtp' },
  { key: 'ai.gemini.apiKey', permission: 'system.tajne_udaje' },
  { key: 'ai.anthropic.apiKey', permission: 'system.tajne_udaje' },
  { key: 'ai.openai.apiKey', permission: 'system.tajne_udaje' },
  { key: 'ai.compatible.apiKey', permission: 'system.tajne_udaje' },
  { key: 'tts.google.apiKey', permission: 'system.tajne_udaje' },
  { key: 'mqtt.password', permission: 'system.tajne_udaje' },
  { key: 'webhook.signingSecret', permission: 'system.tajne_udaje' },
  { key: 'discord.webhookUrl', permission: 'system.tajne_udaje' },
  { key: 'discord.webhookUrl2', permission: 'system.tajne_udaje' },
  { key: 'discord.webhookUrl3', permission: 'system.tajne_udaje' },
  { key: 'discord.webhookUrl4', permission: 'system.tajne_udaje' },
  { key: 'push.vapidPrivateKey', permission: 'system.tajne_udaje' },
];

export const secretDef = (key: string): SecretDef | undefined => SECRETS.find((s) => s.key === key);

/** Šablony e-mailů: klíč, proměnné (česky), odkud se vyvolávají. */
export interface EmailTemplateDef {
  key: string;
  variables: string[];
  /** Bezpečnostní e-mail: jde odeslat i po dosažení denního limitu a nejde ho vypnout. */
  security: boolean;
  subject: string;
  text: string;
}

export const EMAIL_TEMPLATES: EmailTemplateDef[] = [
  {
    key: 'overeni_emailu',
    variables: ['prezdivka', 'odkaz', 'platnost'],
    security: true,
    subject: 'Ověření e-mailu – KoronaBar Poker',
    text: 'Ahoj {prezdivka},\n\nvítej v KoronaBar Poker. Pro dokončení registrace potvrď svůj e-mail kliknutím na tento odkaz:\n\n{odkaz}\n\nOdkaz platí {platnost} hodin.\n\nVirtuální měna v aplikaci nemá žádnou peněžní hodnotu.\n',
  },
  {
    key: 'obnova_hesla',
    variables: ['prezdivka', 'odkaz', 'platnost'],
    security: true,
    subject: 'Obnova hesla – KoronaBar Poker',
    text: 'Ahoj {prezdivka},\n\nněkdo (snad ty) požádal o obnovu hesla. Nové heslo si nastavíš zde:\n\n{odkaz}\n\nOdkaz platí {platnost} hodin a lze ho použít jen jednou. Pokud jsi o obnovu nežádal, tento e-mail ignoruj.\n',
  },
  {
    key: 'zmena_hesla',
    variables: ['prezdivka'],
    security: true,
    subject: 'Heslo bylo změněno – KoronaBar Poker',
    text: 'Ahoj {prezdivka},\n\ntvoje heslo bylo právě změněno a všechna ostatní přihlášení byla odhlášena. Pokud jsi to nebyl ty, ihned požádej o obnovu hesla nebo kontaktuj správce.\n',
  },
  {
    key: 'zmena_emailu',
    variables: ['prezdivka', 'odkaz', 'platnost'],
    security: true,
    subject: 'Potvrzení nového e-mailu – KoronaBar Poker',
    text: 'Ahoj {prezdivka},\n\npro potvrzení změny e-mailové adresy klikni na odkaz:\n\n{odkaz}\n\nOdkaz platí {platnost} hodin.\n',
  },
  {
    key: 'email_zmenen',
    variables: ['prezdivka', 'novy_email'],
    security: true,
    subject: 'Změna e-mailu u tvého účtu – KoronaBar Poker',
    text: 'Ahoj {prezdivka},\n\ne-mail u tvého účtu byl změněn na {novy_email}. Pokud jsi to nebyl ty, kontaktuj správce.\n',
  },
  {
    key: 'pozvanka',
    variables: ['kod', 'odkaz', 'zvouci'],
    security: false,
    subject: 'Pozvánka do KoronaBar Poker',
    text: 'Ahoj,\n\n{zvouci} tě zve do KoronaBar Poker, domácí pokerové herny s virtuální měnou bez peněžní hodnoty.\n\nTvůj pozvánkový kód: {kod}\nRegistrace: {odkaz}\n',
  },
  {
    key: 'zadost_vyrizena',
    variables: ['prezdivka', 'druh', 'vysledek', 'poznamka'],
    security: false,
    subject: 'Tvoje žádost byla vyřízena – KoronaBar Poker',
    text: 'Ahoj {prezdivka},\n\ntvoje žádost ({druh}) byla vyřízena. Výsledek: {vysledek}.\n{poznamka}\nPodrobnosti uvidíš v aplikaci. Tento e-mail můžeš vypnout v profilu v osobním nastavení.\n',
  },
  {
    key: 'turnaj_upozorneni',
    variables: ['prezdivka', 'turnaj', 'udalost', 'text', 'odkaz'],
    security: false,
    subject: 'Turnaj {turnaj}: {udalost}',
    text: 'Ahoj {prezdivka},\n\n{text}\n\nPodrobnosti: {odkaz}\n\nTato upozornění můžeš vypnout v profilu v osobním nastavení.\n',
  },
  {
    key: 'vecer_souhrn',
    variables: ['prezdivka', 'nazev', 'souhrn', 'odkaz'],
    security: false,
    subject: 'Souhrn večera {nazev} – KoronaBar Poker',
    text: 'Ahoj {prezdivka},\n\nvečer skončil. Souhrn:\n\n{souhrn}\n\nCelé vyúčtování: {odkaz}\n\nTento e-mail můžeš vypnout v profilu v osobním nastavení.\n',
  },
  {
    key: 'rocni_souhrn',
    variables: ['prezdivka', 'rok', 'souhrn', 'odkaz'],
    security: false,
    subject: 'Tvůj herní rok {rok} – KoronaBar Poker',
    text: 'Ahoj {prezdivka},\n\nzde je souhrn tvého herního roku {rok}:\n\n{souhrn}\n\nVíc najdeš ve Statistikách: {odkaz}\n\nTento e-mail můžeš vypnout v profilu v osobním nastavení.\n',
  },
  {
    key: 'chat_souhrn',
    variables: ['prezdivka', 'souhrn', 'odkaz'],
    security: false,
    subject: 'Nepřečtené zprávy v chatu – KoronaBar Poker',
    text: 'Ahoj {prezdivka},\n\nv chatu na tebe čekají nepřečtené zprávy:\n\n{souhrn}\n\nOtevři chat: {odkaz}\n\nTento souhrn můžeš vypnout nebo změnit v osobním nastavení.\n',
  },
  {
    key: 'schvaleni_vyrizeno',
    variables: ['prezdivka', 'akce', 'vysledek'],
    security: false,
    subject: 'Rozhodnutí o schválení – KoronaBar Poker',
    text: 'Ahoj {prezdivka},\n\no tvém požadavku ({akce}) bylo rozhodnuto. Výsledek: {vysledek}.\n\nTento e-mail můžeš vypnout v profilu v osobním nastavení.\n',
  },
];

export const emailTemplateDef = (key: string): EmailTemplateDef | undefined => EMAIL_TEMPLATES.find((t) => t.key === key);

/** Přednastavení SMTP pro běžné poskytovatele (vyplní server, port a zabezpečení). */
export const SMTP_PRESETS = [
  { id: 'gmail', host: 'smtp.gmail.com', port: 587, security: 'starttls' },
  { id: 'seznam', host: 'smtp.seznam.cz', port: 465, security: 'tls' },
  { id: 'brevo', host: 'smtp-relay.brevo.com', port: 587, security: 'starttls' },
  { id: 'custom', host: '', port: 587, security: 'starttls' },
] as const;
