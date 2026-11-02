import { eq, inArray } from 'drizzle-orm';
import webpush from 'web-push';
import { schema, type Db } from './db/index.js';
import type { SecretStore } from './secrets/store.js';

export interface PushPayload {
  title: string;
  body: string;
  /** Adresa uvnitř aplikace, kam klepnutí na upozornění zavede. */
  url: string | null;
  /** Stejná značka nahradí starší upozornění (nehromadí se). */
  tag?: string;
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export type PushSender = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, body: string) => Promise<void>;

const PUBLIC_KEY = 'push.vapidPublicKey';

/**
 * Web push (VAPID): klíče si server vytvoří sám při prvním použití, soukromý se ukládá šifrovaně
 * mezi tajnými údaji, veřejný (z něj se neodvodí soukromý) v systémových údajích. Odběr je dobrovolný
 * a vázaný na zařízení; mrtvé odběry (404/410) se mažou.
 */
export class PushService {
  private keys: { publicKey: string; privateKey: string } | null = null;

  constructor(
    private deps: {
      db: Db;
      secrets: SecretStore;
      /** Kontaktní adresa pro push služby (VAPID subject): https adresa serveru nebo mailto. */
      subject: () => string;
      /** Výměnný odesílač kvůli testům; výchozí je knihovna web-push. */
      sender?: PushSender;
    },
  ) {}

  private async ensureKeys(): Promise<{ publicKey: string; privateKey: string }> {
    if (this.keys) return this.keys;
    const [meta] = await this.deps.db.select().from(schema.systemMeta).where(eq(schema.systemMeta.key, PUBLIC_KEY));
    const priv = await this.deps.secrets.reveal('push.vapidPrivateKey');
    if (meta && priv) {
      this.keys = { publicKey: String(meta.value), privateKey: priv };
      return this.keys;
    }
    const k = webpush.generateVAPIDKeys();
    await this.deps.secrets.setSystem('push.vapidPrivateKey', k.privateKey);
    await this.deps.db.insert(schema.systemMeta).values({ key: PUBLIC_KEY, value: k.publicKey }).onConflictDoUpdate({ target: schema.systemMeta.key, set: { value: k.publicKey } });
    this.keys = k;
    return k;
  }

  async publicKey(): Promise<string> {
    return (await this.ensureKeys()).publicKey;
  }

  async subscribe(userId: string, sub: PushSubscriptionInput, userAgent?: string): Promise<void> {
    const v = this.validate(sub);
    await this.deps.db
      .insert(schema.pushSubscriptions)
      .values({ userId, endpoint: v.endpoint, p256dh: v.keys.p256dh, auth: v.keys.auth, userAgent: userAgent?.slice(0, 200) ?? null })
      // zařízení se mohlo přepnout na jiný účet: odběr patří poslednímu přihlášenému
      .onConflictDoUpdate({ target: schema.pushSubscriptions.endpoint, set: { userId, p256dh: v.keys.p256dh, auth: v.keys.auth } });
  }

  async unsubscribe(userId: string, endpoint: string): Promise<void> {
    const rows = await this.deps.db.select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.endpoint, endpoint));
    for (const r of rows) if (r.userId === userId) await this.deps.db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, r.id));
  }

  async count(userId: string): Promise<number> {
    return (await this.deps.db.select({ id: schema.pushSubscriptions.id }).from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.userId, userId))).length;
  }

  private validate(sub: PushSubscriptionInput): PushSubscriptionInput {
    const ok = typeof sub?.endpoint === 'string' && /^https:\/\/.{1,2000}$/.test(sub.endpoint) && typeof sub.keys?.p256dh === 'string' && typeof sub.keys?.auth === 'string' && sub.keys.p256dh.length < 200 && sub.keys.auth.length < 100;
    if (!ok) throw new Error('INVALID_SUBSCRIPTION');
    return sub;
  }

  /** Pošle upozornění všem zařízením daných uživatelů. Chyby jednoho zařízení neovlivní ostatní. */
  async send(userIds: string[], payload: PushPayload): Promise<number> {
    if (userIds.length === 0) return 0;
    return (await this.deliver(userIds, payload)).sent;
  }

  /** Zkušební upozornění pro vlastní zařízení; vrací, co push služba na každém zařízení odpověděla. */
  async test(userId: string, payload: PushPayload): Promise<{ devices: number; sent: number; errors: { status: number | null; message: string }[] }> {
    return this.deliver([userId], payload);
  }

  private async deliver(userIds: string[], payload: PushPayload): Promise<{ devices: number; sent: number; errors: { status: number | null; message: string }[] }> {
    const subs = await this.deps.db.select().from(schema.pushSubscriptions).where(inArray(schema.pushSubscriptions.userId, userIds));
    const errors: { status: number | null; message: string }[] = [];
    if (subs.length === 0) return { devices: 0, sent: 0, errors };
    const keys = await this.ensureKeys();
    const body = JSON.stringify(payload);
    const send: PushSender =
      this.deps.sender ??
      (async (s, b) => {
        await webpush.sendNotification(s, b, { vapidDetails: { subject: this.deps.subject(), publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 3600 });
      });
    let sent = 0;
    for (const s of subs) {
      try {
        await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body);
        sent++;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) await this.deps.db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, s.id));
        const message = String((e as { body?: string }).body || (e instanceof Error ? e.message : e)).slice(0, 300);
        errors.push({ status: status ?? null, message });
        if (status !== 404 && status !== 410) console.error(`Odeslání push upozornění selhalo (${status ?? 'bez kódu'}):`, message);
      }
    }
    return { devices: subs.length, sent, errors };
  }
}
