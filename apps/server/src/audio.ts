import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type AudioFormat = 'mp3' | 'ogg' | 'wav' | 'm4a';

/** Pozná formát podle obsahu souboru (přípona nestačí, dá se podvrhnout). */
export function detectFormat(b: Buffer): AudioFormat | null {
  if (b.length < 12) return null;
  if (b.toString('latin1', 0, 4) === 'OggS') return 'ogg';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE') return 'wav';
  if (b.toString('latin1', 4, 8) === 'ftyp') return 'm4a';
  if (b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)) return 'mp3';
  return null;
}

export interface ProcessOptions {
  startMs: number;
  endMs: number;
  /** Cílová hlasitost (LUFS). */
  loudness: number;
}

/** Převod zvuku: zjištění délky a ořez + normalizace hlasitosti do jednotného formátu (mp3). */
export interface AudioProcessor {
  probe(data: Buffer, format: AudioFormat): Promise<{ durationMs: number }>;
  process(data: Buffer, format: AudioFormat, opts: ProcessOptions): Promise<{ data: Buffer; mime: string; durationMs: number }>;
}

function run(bin: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => (stderr += String(d)));
    p.on('error', (e) => reject((e as NodeJS.ErrnoException).code === 'ENOENT' ? new Error('TOOL_MISSING') : e));
    p.on('close', (code) => resolve({ code: code ?? 1, stderr }));
  });
}

const toSeconds = (ms: number) => (ms / 1000).toFixed(3);

/** Používá `ffmpeg` (v Docker obrazu je nainstalovaný). Pracuje přes dočasné soubory, protože m4a nejde číst z roury. */
export class FfmpegProcessor implements AudioProcessor {
  constructor(private bin = process.env.FFMPEG_PATH ?? 'ffmpeg') {}

  private async withTemp<T>(data: Buffer, format: AudioFormat, fn: (inFile: string, dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'kb-audio-'));
    try {
      const inFile = join(dir, `in.${format}`);
      await writeFile(inFile, data);
      return await fn(inFile, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async probe(data: Buffer, format: AudioFormat): Promise<{ durationMs: number }> {
    return this.withTemp(data, format, async (inFile) => {
      // Dekóduje celý soubor do „nic“ a z posledního hlášení času zjistí skutečnou délku.
      const r = await run(this.bin, ['-hide_banner', '-nostdin', '-i', inFile, '-f', 'null', '-']);
      const times = [...r.stderr.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
      const last = times[times.length - 1];
      if (r.code !== 0 || !last) throw new Error('AUDIO_INVALID');
      return { durationMs: Math.round((Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3])) * 1000) };
    });
  }

  async process(data: Buffer, format: AudioFormat, o: ProcessOptions): Promise<{ data: Buffer; mime: string; durationMs: number }> {
    return this.withTemp(data, format, async (inFile, dir) => {
      const out = join(dir, 'out.mp3');
      const r = await run(this.bin, [
        '-hide_banner', '-nostdin', '-y',
        '-i', inFile,
        '-ss', toSeconds(o.startMs), '-to', toSeconds(o.endMs),
        '-af', `loudnorm=I=${o.loudness}:TP=-1.5:LRA=11`,
        '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '96k', '-map_metadata', '-1',
        out,
      ]);
      if (r.code !== 0) throw new Error('AUDIO_INVALID');
      const buf = await readFile(out);
      return { data: buf, mime: 'audio/mpeg', durationMs: o.endMs - o.startMs };
    });
  }
}

/** Zástupný převodník do testů a vývoje bez ffmpeg: nic nepřevádí, jen ořízne délku v metadatech. */
export class PassthroughProcessor implements AudioProcessor {
  constructor(private durationMs = 1500) {}
  async probe(): Promise<{ durationMs: number }> {
    return { durationMs: this.durationMs };
  }
  async process(data: Buffer, format: AudioFormat, o: ProcessOptions): Promise<{ data: Buffer; mime: string; durationMs: number }> {
    const mime = format === 'mp3' ? 'audio/mpeg' : format === 'ogg' ? 'audio/ogg' : format === 'wav' ? 'audio/wav' : 'audio/mp4';
    return { data, mime, durationMs: o.endMs - o.startMs };
  }
}

// ---------- vestavěné zvuky (syntéza, bez externích souborů) ----------

const RATE = 22050;

function wav(samples: Float32Array): Buffer {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32000), 44 + i * 2);
  return buf;
}

/** Tón s náběhem a doznívením; `slide` posouvá frekvenci (poměr konce k začátku). */
function tone(freq: number, seconds: number, opts: { slide?: number; wave?: 'sine' | 'square'; gain?: number } = {}): Float32Array {
  const n = Math.floor(seconds * RATE);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const f = freq * (1 + ((opts.slide ?? 1) - 1) * t);
    phase += (2 * Math.PI * f) / RATE;
    const env = Math.min(1, i / 200) * Math.pow(1 - t, 1.5);
    const s = opts.wave === 'square' ? Math.sign(Math.sin(phase)) * 0.5 : Math.sin(phase);
    out[i] = s * env * (opts.gain ?? 0.6);
  }
  return out;
}

function noise(seconds: number, seed: number, sweep = false): Float32Array {
  const n = Math.floor(seconds * RATE);
  const out = new Float32Array(n);
  let x = seed;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    const r = (x / 0xffffffff) * 2 - 1;
    const t = i / n;
    const a = sweep ? 0.05 + 0.6 * Math.sin(Math.PI * t) : 0.9;
    lp += a * (r - lp);
    out[i] = lp * Math.sin(Math.PI * t) * 0.7;
  }
  return out;
}

const join2 = (...parts: Float32Array[]): Float32Array => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const gap = (s: number) => new Float32Array(Math.floor(s * RATE));

export interface BuiltinSound {
  shortcut: string;
  name: string;
  emoji: string;
  category: string;
  data: Buffer;
  durationMs: number;
}

/** Malá vestavěná sada; názvy jsou česky, protože jde o uživatelská data knihovny. */
export function builtinSounds(): BuiltinSound[] {
  const mk = (shortcut: string, name: string, emoji: string, category: string, s: Float32Array): BuiltinSound => ({ shortcut, name, emoji, category, data: wav(s), durationMs: Math.round((s.length / RATE) * 1000) });
  return [
    mk('ding', 'Cink', '🔔', 'upozorneni', tone(1320, 0.7)),
    mk('fanfara', 'Fanfára', '🎺', 'oslava', join2(tone(523, 0.15, { wave: 'square', gain: 0.4 }), tone(659, 0.15, { wave: 'square', gain: 0.4 }), tone(784, 0.15, { wave: 'square', gain: 0.4 }), tone(1047, 0.6, { wave: 'square', gain: 0.4 }))),
    mk('smutna', 'Smutná trubka', '😢', 'smutek', join2(tone(392, 0.35, { gain: 0.5 }), tone(370, 0.35, { gain: 0.5 }), tone(349, 0.35, { gain: 0.5 }), tone(330, 0.8, { slide: 0.9, gain: 0.5 }))),
    mk('buben', 'Bubnování', '🥁', 'napeti', join2(...Array.from({ length: 8 }, (_, i) => join2(noise(0.08, 11 + i), gap(0.04))))),
    mk('svist', 'Svist', '💨', 'efekt', noise(0.6, 99, true)),
    mk('boing', 'Boing', '🦘', 'efekt', tone(220, 0.5, { slide: 3, gain: 0.5 })),
  ];
}
