import net from 'node:net';

/**
 * Klient protokolu Wyoming (Piper, Whisper…): události jsou řádek JSON, volitelně za ním `data_length` bajtů
 * dalšího JSON a `payload_length` bajtů dat. Používá ho vlastní kontejner Piper i Piper v Home Assistantu.
 */
export interface WyomingEvent {
  type: string;
  data: Record<string, unknown>;
  payload: Buffer;
}

/** Postupně skládá události z proudu bajtů. */
export class WyomingParser {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer): WyomingEvent[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: WyomingEvent[] = [];
    for (;;) {
      const nl = this.buf.indexOf(0x0a);
      if (nl < 0) break;
      const header = JSON.parse(this.buf.toString('utf8', 0, nl)) as { type: string; data?: Record<string, unknown>; data_length?: number; payload_length?: number };
      const dataLen = header.data_length ?? 0;
      const payloadLen = header.payload_length ?? 0;
      const need = nl + 1 + dataLen + payloadLen;
      if (this.buf.length < need) break;
      const extra = dataLen > 0 ? (JSON.parse(this.buf.toString('utf8', nl + 1, nl + 1 + dataLen)) as Record<string, unknown>) : {};
      out.push({ type: header.type, data: { ...(header.data ?? {}), ...extra }, payload: Buffer.from(this.buf.subarray(nl + 1 + dataLen, need)) });
      this.buf = this.buf.subarray(need);
    }
    return out;
  }
}

export const encodeEvent = (type: string, data?: Record<string, unknown>): Buffer => Buffer.from(`${JSON.stringify(data ? { type, data } : { type })}\n`, 'utf8');

/** Pošle jednu událost a čeká, až `done` vrátí true (nebo vyprší čas). Vrací všechny přijaté události. */
export function wyomingRequest(host: string, port: number, request: Buffer, done: (events: WyomingEvent[]) => boolean, timeoutMs: number): Promise<WyomingEvent[]> {
  return new Promise((resolve, reject) => {
    const events: WyomingEvent[] = [];
    const parser = new WyomingParser();
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(events);
    };
    const timer = setTimeout(() => finish(new Error('Vypršel čas spojení')), timeoutMs);
    socket.on('connect', () => socket.write(request));
    socket.on('data', (chunk: Buffer) => {
      try {
        events.push(...parser.push(chunk));
      } catch (e) {
        return finish(e instanceof Error ? e : new Error('Neplatná odpověď'));
      }
      if (done(events)) finish();
    });
    socket.on('error', (e) => finish(e));
    socket.on('close', () => finish(events.length ? undefined : new Error('Spojení se zavřelo bez odpovědi')));
  });
}

/** PCM (16 bitů) zabalené do WAV, aby ho přehrál každý prohlížeč. */
export function pcmToWav(pcm: Buffer, rate: number, width: number, channels: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * width, 28);
  header.writeUInt16LE(channels * width, 32);
  header.writeUInt16LE(width * 8, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export interface PiperOptions {
  host: string;
  port: number;
  voice: string;
  timeoutMs: number;
}

/** Namluví text přes Wyoming; vrací WAV. */
export async function piperSynthesize(text: string, o: PiperOptions): Promise<Buffer> {
  const events = await wyomingRequest(o.host, o.port, encodeEvent('synthesize', { text, ...(o.voice ? { voice: { name: o.voice } } : {}) }), (ev) => ev.some((e) => e.type === 'audio-stop'), o.timeoutMs);
  const start = events.find((e) => e.type === 'audio-start');
  const chunks = events.filter((e) => e.type === 'audio-chunk');
  if (chunks.length === 0) throw new Error('Piper nevrátil žádné audio');
  const fmt = (start ?? chunks[0]!).data as { rate?: number; width?: number; channels?: number };
  return pcmToWav(Buffer.concat(chunks.map((c) => c.payload)), Number(fmt.rate ?? 22050), Number(fmt.width ?? 2), Number(fmt.channels ?? 1));
}

/** Seznam hlasů, které server nabízí (odpověď na „describe“). */
export async function piperVoices(o: Pick<PiperOptions, 'host' | 'port' | 'timeoutMs'>): Promise<string[]> {
  const events = await wyomingRequest(o.host, o.port, encodeEvent('describe'), (ev) => ev.some((e) => e.type === 'info'), o.timeoutMs);
  const info = events.find((e) => e.type === 'info');
  const tts = (info?.data.tts as { voices?: { name?: string }[]; models?: { name?: string }[] }[] | undefined) ?? [];
  const names = tts.flatMap((p) => [...(p.voices ?? []), ...(p.models ?? [])].map((v) => v.name).filter((n): n is string => !!n));
  return [...new Set(names)];
}
