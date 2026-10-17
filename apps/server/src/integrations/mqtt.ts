import net from 'node:net';
import tls from 'node:tls';

/**
 * Nejmenší klient MQTT 3.1.1, který umí jen to, co aplikace potřebuje: připojit se (jméno, heslo, TLS), publikovat
 * zprávy (QoS 0, volitelně retain) a držet spojení při životě. Odběr zpráv aplikace nepotřebuje.
 */

export interface MqttOptions {
  host: string;
  port: number;
  tls: boolean;
  username?: string;
  password?: string;
  clientId: string;
  keepAliveSeconds?: number;
  connectTimeoutMs?: number;
}

export interface MqttConnection {
  publish(topic: string, payload: string, opts?: { retain?: boolean }): Promise<void>;
  end(): void;
  readonly connected: boolean;
}

export type MqttConnector = (opts: MqttOptions) => Promise<MqttConnection>;

const CONNACK_TEXT: Record<number, string> = {
  1: 'UNACCEPTABLE_PROTOCOL',
  2: 'CLIENT_ID_REJECTED',
  3: 'SERVER_UNAVAILABLE',
  4: 'BAD_CREDENTIALS',
  5: 'NOT_AUTHORIZED',
};

export class MqttError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

function varInt(n: number): Buffer {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
}

function str(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
}

function packet(type: number, flags: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), varInt(body.length), body]);
}

export function connectPacket(o: MqttOptions): Buffer {
  const keep = o.keepAliveSeconds ?? 60;
  let flags = 0x02; // čistá relace
  if (o.username) flags |= 0x80;
  if (o.username && o.password) flags |= 0x40;
  const ka = Buffer.alloc(2);
  ka.writeUInt16BE(keep);
  const parts = [str('MQTT'), Buffer.from([4, flags]), ka, str(o.clientId)];
  if (o.username) parts.push(str(o.username));
  if (o.username && o.password) parts.push(str(o.password));
  return packet(1, 0, Buffer.concat(parts));
}

export function publishPacket(topic: string, payload: string, retain: boolean): Buffer {
  return packet(3, retain ? 1 : 0, Buffer.concat([str(topic), Buffer.from(payload, 'utf8')]));
}

/** Skutečné spojení s brokerem. */
export const connectMqtt: MqttConnector = (opts) =>
  new Promise<MqttConnection>((resolve, reject) => {
    let settled = false;
    let alive = false;
    const socket = opts.tls ? tls.connect({ host: opts.host, port: opts.port, servername: opts.host }) : net.connect({ host: opts.host, port: opts.port });
    const fail = (code: string) => {
      alive = false;
      socket.destroy();
      if (!settled) {
        settled = true;
        reject(new MqttError(code));
      }
    };
    const timer = setTimeout(() => fail('TIMEOUT'), opts.connectTimeoutMs ?? 8000);
    let ping: ReturnType<typeof setInterval> | undefined;
    const conn: MqttConnection = {
      get connected() {
        return alive;
      },
      publish: (topic, payload, o) =>
        new Promise<void>((res, rej) => {
          if (!alive) return rej(new MqttError('NOT_CONNECTED'));
          socket.write(publishPacket(topic, payload, !!o?.retain), (err) => (err ? rej(new MqttError('WRITE_FAILED')) : res()));
        }),
      end: () => {
        if (alive) socket.write(Buffer.from([0xe0, 0x00]));
        alive = false;
        if (ping) clearInterval(ping);
        socket.end();
      },
    };
    let buf = Buffer.alloc(0);
    socket.on(opts.tls ? 'secureConnect' : 'connect', () => socket.write(connectPacket(opts)));
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d as Buffer]);
      // Jediný paket, který čekáme, je CONNACK (4 bajty); ostatní (PINGRESP) zahodíme.
      while (buf.length >= 2) {
        const type = buf[0]! >> 4;
        const len = buf[1]!;
        if (buf.length < 2 + len) return;
        const body = buf.subarray(2, 2 + len);
        buf = buf.subarray(2 + len);
        if (type === 2 && !settled) {
          clearTimeout(timer);
          const rc = body[1] ?? 255;
          if (rc !== 0) return fail(CONNACK_TEXT[rc] ?? 'REFUSED');
          settled = true;
          alive = true;
          ping = setInterval(() => alive && socket.write(Buffer.from([0xc0, 0x00])), ((opts.keepAliveSeconds ?? 60) * 1000) / 2);
          ping.unref?.();
          resolve(conn);
        }
      }
    });
    socket.on('error', (e: NodeJS.ErrnoException) => fail(e.code ?? 'ERROR'));
    socket.on('close', () => {
      alive = false;
      if (ping) clearInterval(ping);
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new MqttError('CLOSED'));
      }
    });
    socket.unref?.();
  });
