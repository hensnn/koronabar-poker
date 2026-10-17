/**
 * Přehrávač hlasatele v prohlížeči: řadí hlášky do fronty (aby se nepřekrývaly) a čte je hlasem zařízení
 * (Web Speech API), nebo namluvené na serveru. Když server audio nedodá, přejde se na hlas zařízení.
 */
export interface AnnounceItem {
  id: string;
  text: string;
  /** Server má hlášku namluvenou (Piper, Google). */
  audio: boolean;
}

export interface PlayerPrefs {
  enabled: boolean;
  /** Hlas zařízení místo serverového. */
  browserOnly: boolean;
  /** 0 až 1 */
  volume: number;
  /** 0,5 až 2 */
  rate: number;
  voiceName: string;
  /** Adresa audia pro danou hlášku a hlavičky pro přihlášení (televize posílá token). */
  audioUrl: (id: string) => string;
  headers?: Record<string, string>;
}

export type PlayerNotice = 'noVoice' | null;

const synth = (): SpeechSynthesis | null => (typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null);

/** Český hlas zařízení: podle jména, jinak první s jazykem cs. */
export function pickVoice(name: string): SpeechSynthesisVoice | null {
  const voices = synth()?.getVoices() ?? [];
  return (name ? voices.find((v) => v.name === name) : undefined) ?? voices.find((v) => v.lang.toLowerCase().startsWith('cs')) ?? null;
}

export function browserVoices(): SpeechSynthesisVoice[] {
  return synth()?.getVoices() ?? [];
}

export class AnnouncerPlayer {
  private queue: { item: AnnounceItem; prefs: PlayerPrefs }[] = [];
  private seen = new Set<string>();
  private busy = false;
  private unlocked = false;
  private notice: PlayerNotice = null;

  constructor(private onNotice: (n: PlayerNotice) => void = () => undefined) {}

  /** Prohlížeče pustí zvuk až po zásahu uživatele. */
  unlock(): void {
    if (this.unlocked) return;
    this.unlocked = true;
    const s = synth();
    if (s) {
      const u = new SpeechSynthesisUtterance('');
      u.volume = 0;
      s.speak(u);
    }
  }

  isUnlocked(): boolean {
    return this.unlocked;
  }

  enqueue(item: AnnounceItem, prefs: PlayerPrefs): void {
    if (!prefs.enabled || prefs.volume <= 0 || this.seen.has(item.id)) return;
    this.seen.add(item.id);
    if (this.seen.size > 200) this.seen = new Set([...this.seen].slice(-100));
    this.queue.push({ item, prefs });
    // Hlášky, které se hromadí (třeba po výpadku spojení), se neposlouchají všechny: zůstane posledních pár.
    if (this.queue.length > 4) this.queue.splice(0, this.queue.length - 4);
    void this.next();
  }

  stop(): void {
    this.queue = [];
    synth()?.cancel();
  }

  private async next(): Promise<void> {
    if (this.busy) return;
    const job = this.queue.shift();
    if (!job) return;
    this.busy = true;
    try {
      await this.play(job.item, job.prefs);
    } finally {
      this.busy = false;
      void this.next();
    }
  }

  private async play(item: AnnounceItem, prefs: PlayerPrefs): Promise<void> {
    if (item.audio && !prefs.browserOnly) {
      try {
        const res = await fetch(prefs.audioUrl(item.id), { headers: prefs.headers, credentials: 'include' });
        if (!res.ok) throw new Error(String(res.status));
        const url = URL.createObjectURL(await res.blob());
        try {
          await new Promise<void>((resolve, reject) => {
            const a = new Audio(url);
            a.volume = prefs.volume;
            a.playbackRate = prefs.rate;
            a.onended = () => resolve();
            a.onerror = () => reject(new Error('audio'));
            a.play().catch(reject);
          });
          return;
        } finally {
          URL.revokeObjectURL(url);
        }
      } catch {
        // server audio nedodal nebo ho prohlížeč nepustil: hlas zařízení
      }
    }
    await this.speak(item.text, prefs);
  }

  private speak(text: string, prefs: PlayerPrefs): Promise<void> {
    const s = synth();
    if (!s) return Promise.resolve();
    const voice = pickVoice(prefs.voiceName);
    if (!voice) {
      if (this.notice !== 'noVoice') {
        this.notice = 'noVoice';
        this.onNotice('noVoice');
      }
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.voice = voice;
      u.lang = voice.lang;
      u.volume = prefs.volume;
      u.rate = prefs.rate;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      s.speak(u);
    });
  }
}
