import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { eq } from 'drizzle-orm';
import { SECRETS, secretDef, type PermissionChecker } from '@kb/shared';
import type { AuditService, AuditSource } from '../auth/audit.js';
import { schema, type Db } from '../db/index.js';

export class SecretError extends Error {
  constructor(public readonly code: 'FORBIDDEN' | 'UNKNOWN_SECRET' | 'EMPTY' | 'DECRYPT_FAILED' | 'NO_KEY') {
    super(code);
  }
}

export interface MasterKey {
  key: Buffer;
  version: number;
}

const HEX = /^[0-9a-fA-F]{64}$/;

/**
 * Hlavní šifrovací klíč (32 bajtů) je vždy mimo databázi: v proměnné prostředí / Docker secretu,
 * nebo v souboru ve volume. Chybí-li, vygeneruje se a zapíše do souboru s návodem k záloze.
 */
export function loadMasterKey(opts: { envKey?: string; envVersion?: number; keyFile?: string; log?: (msg: string) => void }): MasterKey {
  if (opts.envKey) {
    if (!HEX.test(opts.envKey.trim())) throw new Error('MASTER_KEY musí mít 64 hexadecimálních znaků (32 bajtů).');
    return { key: Buffer.from(opts.envKey.trim(), 'hex'), version: opts.envVersion ?? 1 };
  }
  if (opts.keyFile && existsSync(opts.keyFile)) {
    const [v, hex] = readFileSync(opts.keyFile, 'utf8').trim().split(':');
    if (!hex || !HEX.test(hex)) throw new Error(`Soubor s klíčem ${opts.keyFile} je poškozený.`);
    return { key: Buffer.from(hex, 'hex'), version: Number(v) || 1 };
  }
  const key = randomBytes(32);
  const mk = { key, version: 1 };
  if (opts.keyFile) {
    writeKeyFile(opts.keyFile, mk);
    opts.log?.(
      `Vygeneroval jsem hlavní šifrovací klíč a uložil ho do ${opts.keyFile}.\n` +
        'DŮLEŽITÉ: tento soubor zálohuj ZVLÁŠŤ od databáze (bez něj půjdou tajné údaje jen znovu zadat).\n' +
        'Lepší je klíč mít v .env jako MASTER_KEY nebo v Docker secretu.',
    );
  } else {
    opts.log?.(`Vygeneroval jsem dočasný hlavní klíč (jen v paměti, po restartu se ztratí): nastav MASTER_KEY=${key.toString('hex')}`);
  }
  return mk;
}

function writeKeyFile(file: string, mk: MasterKey): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${mk.version}:${mk.key.toString('hex')}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* na Windows nemá smysl */
  }
}

export interface EncryptedSecret {
  ciphertext: string;
  nonce: string;
}

/** AES-256-GCM; název tajného údaje jde jako AAD, takže zašifrovanou hodnotu nelze podstrčit pod jiný klíč. */
export function encryptSecret(key: Buffer, name: string, plaintext: string): EncryptedSecret {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(name));
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext: Buffer.concat([enc, cipher.getAuthTag()]).toString('base64'), nonce: nonce.toString('base64') };
}

export function decryptSecret(key: Buffer, name: string, s: EncryptedSecret): string {
  const raw = Buffer.from(s.ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(s.nonce, 'base64'));
  decipher.setAAD(Buffer.from(name));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString('utf8');
}

export interface SecretStatus {
  key: string;
  set: boolean;
  /** Poslední 4 znaky (zbytek se nikdy nevrací). */
  last4?: string;
  updatedAt?: Date;
}

export class SecretStore {
  constructor(
    private db: Db,
    private audit: AuditService,
    private perms: PermissionChecker,
    private master: MasterKey,
    private keyFile?: string,
  ) {}

  get keyVersion(): number {
    return this.master.version;
  }

  private authorize(actorId: string, key: string): void {
    const def = secretDef(key);
    if (!def) throw new SecretError('UNKNOWN_SECRET');
    if (!this.perms.can(actorId, def.permission).allowed) throw new SecretError('FORBIDDEN');
  }

  async set(actorId: string, key: string, value: string, meta: { ip?: string | null; source?: AuditSource } = {}): Promise<void> {
    this.authorize(actorId, key);
    if (!value || !value.trim()) throw new SecretError('EMPTY');
    const enc = encryptSecret(this.master.key, key, value);
    const last4 = value.slice(-4);
    await this.db
      .insert(schema.secrets)
      .values({ key, ciphertext: enc.ciphertext, nonce: enc.nonce, keyVersion: this.master.version, last4, updatedBy: actorId })
      .onConflictDoUpdate({ target: schema.secrets.key, set: { ciphertext: enc.ciphertext, nonce: enc.nonce, keyVersion: this.master.version, last4, updatedBy: actorId, updatedAt: new Date() } });
    // Do auditu se zapisuje jen, že se klíč změnil, nikdy hodnota.
    await this.audit.log({ actorId, action: 'tajny_udaj.zmenen', targetType: 'secret', targetId: key, ...meta });
  }

  async delete(actorId: string, key: string, meta: { ip?: string | null; source?: AuditSource } = {}): Promise<void> {
    this.authorize(actorId, key);
    await this.db.delete(schema.secrets).where(eq(schema.secrets.key, key));
    await this.audit.log({ actorId, action: 'tajny_udaj.smazan', targetType: 'secret', targetId: key, ...meta });
  }

  /** Uloží údaj, který si server vytvořil sám (např. VAPID klíč). Bez oprávnění uživatele, ale stejně šifrovaně. */
  async setSystem(key: string, value: string): Promise<void> {
    if (!secretDef(key)) throw new SecretError('UNKNOWN_SECRET');
    const enc = encryptSecret(this.master.key, key, value);
    const row = { ciphertext: enc.ciphertext, nonce: enc.nonce, keyVersion: this.master.version, last4: value.slice(-4) };
    await this.db
      .insert(schema.secrets)
      .values({ key, ...row })
      .onConflictDoUpdate({ target: schema.secrets.key, set: { ...row, updatedAt: new Date() } });
  }

  /** Stav všech známých tajných údajů pro GUI („nastaveno“ + poslední 4 znaky). */
  async status(): Promise<SecretStatus[]> {
    const rows = await this.db.select().from(schema.secrets);
    return SECRETS.map((d) => {
      const r = rows.find((x) => x.key === d.key);
      return r ? { key: d.key, set: true, last4: r.last4, updatedAt: r.updatedAt } : { key: d.key, set: false };
    });
  }

  /** Dešifrovaná hodnota pro volání externích služeb ze serveru. Nikdy se neposílá klientovi. */
  async reveal(key: string): Promise<string | undefined> {
    if (!secretDef(key)) throw new SecretError('UNKNOWN_SECRET');
    const [row] = await this.db.select().from(schema.secrets).where(eq(schema.secrets.key, key));
    if (!row) return undefined;
    try {
      return decryptSecret(this.master.key, key, row);
    } catch {
      throw new SecretError('DECRYPT_FAILED');
    }
  }

  /**
   * Rotace hlavního klíče: vygeneruje nový, přešifruje všechny údaje v jedné transakci a starý
   * klíč lze zahodit. Při klíči v souboru se nový zapíše sám, při klíči v .env ho musí správce
   * uložit podle návratové hodnoty.
   */
  async rotate(actorId: string, meta: { ip?: string | null; source?: AuditSource } = {}): Promise<{ newKeyHex: string; version: number; savedToFile: boolean }> {
    if (!this.perms.can(actorId, 'system.kryptovani_klic').allowed) throw new SecretError('FORBIDDEN');
    const next: MasterKey = { key: randomBytes(32), version: this.master.version + 1 };
    await this.db.transaction(async (trx) => {
      const rows = await trx.select().from(schema.secrets);
      for (const r of rows) {
        const plain = decryptSecret(this.master.key, r.key, r);
        const enc = encryptSecret(next.key, r.key, plain);
        await trx.update(schema.secrets).set({ ciphertext: enc.ciphertext, nonce: enc.nonce, keyVersion: next.version }).where(eq(schema.secrets.key, r.key));
      }
    });
    if (this.keyFile) writeKeyFile(this.keyFile, next);
    this.master = next;
    await this.audit.log({ actorId, action: 'tajny_udaj.rotace_klice', targetType: 'secret', after: { version: next.version }, ...meta });
    return { newKeyHex: next.key.toString('hex'), version: next.version, savedToFile: !!this.keyFile };
  }
}
