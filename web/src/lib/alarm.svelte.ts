/**
 * Global audible alarm for attention states. While any session is `needs-input`
 * or `error` (work has stalled and needs you) AND sound is enabled, a warning
 * tone plays roughly once a minute — including when the tab is backgrounded.
 *
 * Background-tab strategy: browsers throttle setInterval and freeze rendering in
 * hidden tabs, but MEDIA PLAYBACK keeps running. So instead of a JS timer we play
 * a looping <audio> element whose track is "[alert tones][~silence to 60s]" — the
 * loop re-fires the tones every minute on its own. Audio is gated by the browser
 * autoplay policy, so it must be unlocked from a user gesture (the sound toggle).
 */
import type { Snapshot } from "./types";

const LS_KEY = "agi.alarm";
const LOOP_SECONDS = 60;
const RATE = 8000;

function encodeWav(samples: Float32Array, rate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([buf], { type: "audio/wav" });
}

/** Write a short tone with a soft attack/release envelope to avoid clicks. */
function tone(buf: Float32Array, startSec: number, durSec: number, freq: number): void {
  const s = Math.floor(startSec * RATE);
  const e = Math.min(buf.length, s + Math.floor(durSec * RATE));
  const edge = 0.012 * RATE;
  for (let i = s; i < e; i++) {
    const env = Math.min(1, (i - s) / edge) * Math.min(1, (e - i) / edge);
    buf[i]! += 0.6 * env * Math.sin((2 * Math.PI * freq * (i - s)) / RATE);
  }
}

function makeUrl(build: (buf: Float32Array) => void, seconds: number): string {
  const buf = new Float32Array(Math.floor(seconds * RATE));
  build(buf);
  return URL.createObjectURL(encodeWav(buf, RATE));
}

class Alarm {
  /** Whether the user has turned audible alerts on (persisted). */
  enabled = $state(false);
  /** Whether the alarm is currently sounding (enabled + an active alert). */
  active = $state(false);

  #loop: HTMLAudioElement | null = null;
  #confirm: HTMLAudioElement | null = null;
  #hasAlert = false;
  #unlocked = false;

  constructor() {
    if (typeof localStorage !== "undefined") {
      this.enabled = localStorage.getItem(LS_KEY) === "1";
    }
    // If sound was left enabled, unlock on the first user gesture after a reload
    // (autoplay can't resume on its own) so the alarm can sound again.
    if (this.enabled && typeof document !== "undefined") {
      const once = () => {
        this.#unlock();
        this.#refresh();
        document.removeEventListener("pointerdown", once);
        document.removeEventListener("keydown", once);
      };
      document.addEventListener("pointerdown", once);
      document.addEventListener("keydown", once);
    }
  }

  #ensureAudio(): void {
    if (this.#loop) return;
    // Alert pattern (three rising tones) at the start of each 60s loop.
    this.#loop = new Audio(
      makeUrl((b) => {
        tone(b, 0.0, 0.14, 988);
        tone(b, 0.22, 0.14, 988);
        tone(b, 0.44, 0.2, 1319);
      }, LOOP_SECONDS),
    );
    this.#loop.loop = true;
    this.#confirm = new Audio(makeUrl((b) => tone(b, 0, 0.12, 988), 0.2));
  }

  /** Satisfy the autoplay policy from within a user gesture. */
  #unlock(): void {
    this.#ensureAudio();
    const l = this.#loop!;
    l.muted = true;
    l.play()
      .then(() => {
        l.pause();
        l.currentTime = 0;
        l.muted = false;
        this.#unlocked = true;
      })
      .catch(() => {});
  }

  /** Toggle audible alerts. MUST be called from a user gesture (e.g. a click). */
  toggle(): void {
    this.#ensureAudio();
    this.enabled = !this.enabled;
    if (typeof localStorage !== "undefined") localStorage.setItem(LS_KEY, this.enabled ? "1" : "0");
    if (this.enabled) {
      this.#unlock();
      // Audible confirmation that sound works (and a second unlock path).
      this.#confirm?.play().then(() => (this.#unlocked = true)).catch(() => {});
      this.#refresh();
    } else {
      this.#stop();
    }
  }

  /** Feed each snapshot: (re)starts or stops the alarm based on alert states. */
  update(snap: Snapshot): void {
    this.#hasAlert = snap.sessions.some((s) => s.status === "needs-input" || s.status === "error");
    this.#refresh();
  }

  #refresh(): void {
    const shouldAlarm = this.enabled && this.#hasAlert;
    this.active = shouldAlarm;
    if (!this.#loop) return;
    if (shouldAlarm) {
      if (this.#loop.paused) {
        this.#loop.currentTime = 0; // beep immediately on a new alert
        this.#loop.play().catch(() => {});
      }
    } else {
      this.#stop();
    }
  }

  #stop(): void {
    this.active = false;
    if (this.#loop && !this.#loop.paused) {
      this.#loop.pause();
      this.#loop.currentTime = 0;
    }
  }
}

export const alarm = new Alarm();
