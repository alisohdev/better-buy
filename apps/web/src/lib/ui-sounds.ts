import * as React from "react";

export type SoundCategory =
  | "Actions"
  | "Feedback"
  | "Navigation"
  | "Notifications"
  | "Selection"
  | "Movement"
  | "Progress"
  | "System";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let out: AudioNode | null = null;
let analyserNode: AnalyserNode | null = null;
let noiseBuf: AudioBuffer | null = null;

function audio() {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    playbackSession();
    master = ctx.createGain();
    master.gain.value = isTouchDevice() ? 0.9 : 0.5; // phone speakers are small and quiet
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp).connect(ctx.destination);
    out = comp;
  }
  silentTrack();
  if (ctx.state !== "running") void ctx.resume(); // "suspended" until a tap; "interrupted" after a call or a locked screen on iOS
  return ctx;
}

/**
 * Phones. iOS and Android only let a page start audio from a real tap (iOS counts touchend and click, not the
 * pointerenter that fires when a finger lands), and iOS mutes Web Audio while the ringer switch is on silent
 * unless the page asks for the "playback" audio session. So on a touch screen, once a sound has been asked for, the next tap
 * wakes the engine, plays one silent sample, and switches the session; after that every sound is audible.
 */
function playbackSession() {
  try {
    const session = (
      navigator as unknown as { audioSession?: { type: string } }
    ).audioSession;
    if (session && session.type !== "playback") session.type = "playback";
  } catch {
    // not supported: the ringer switch still applies
  }
}

/**
 * The iOS ringer switch. With it on silent, iOS mutes Web Audio but not a playing <audio> element, and while one is
 * playing it moves the whole page to the "playback" category. So on a touch device the first sound also starts a
 * silent loop (a quarter second of silence), which is what makes the sounds heard with the switch on silent. It is
 * only started once a sound has been asked for, and paused whenever the page is hidden.
 */
const SILENT_WAV =
  "data:audio/wav;base64,UklGRvQHAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YdAHAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";
let silentEl: HTMLAudioElement | null = null;
function isTouchDevice() {
  return (
    typeof window !== "undefined" &&
    ((navigator.maxTouchPoints ?? 0) > 0 ||
      !!window.matchMedia?.("(pointer: coarse)").matches)
  );
}
function silentTrack() {
  if (typeof document === "undefined" || !isTouchDevice()) return;
  try {
    if (!silentEl) {
      silentEl = new Audio(SILENT_WAV);
      silentEl.loop = true;
      silentEl.setAttribute("playsinline", "");
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) silentEl?.pause();
      });
    }
    if (silentEl.paused && !document.hidden)
      void silentEl.play().catch(() => {});
  } catch {
    // no HTMLAudioElement: the ringer switch still applies
  }
}

let unlockArmed = false;
function armTouchUnlock() {
  if (unlockArmed || typeof window === "undefined") return;
  unlockArmed = true;
  if (!isTouchDevice()) return;
  const wake = () => {
    if (!ctx) return; // nothing to wake until a sound has been asked for (and no silent loop for visitors who never use sound)
    if (ctx.state === "running") return silentTrack();
    const c = audio();
    if (!c) return;
    try {
      const s = c.createBufferSource();
      s.buffer = c.createBuffer(1, 1, 22050);
      s.connect(c.destination);
      s.start(0);
    } catch {
      // ignore
    }
  };
  for (const type of ["touchend", "pointerup", "click", "keydown"])
    window.addEventListener(type, wake, { capture: true, passive: true });
}
armTouchUnlock();

/**
 * A tap on everything the library plays, for drawing it (a level meter, a visualiser). It listens
 * only; nothing extra is heard. Null on the server or before the browser allows audio.
 */
export function getSoundAnalyser(): AnalyserNode | null {
  const c = audio();
  if (!c || !out) return null;
  if (!analyserNode) {
    analyserNode = c.createAnalyser();
    analyserNode.fftSize = 1024;
    analyserNode.smoothingTimeConstant = 0.55;
    out.connect(analyserNode);
  }
  return analyserNode;
}

function noise(c: AudioContext) {
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const s = c.createBufferSource();
  s.buffer = noiseBuf;
  return s;
}

export type ToneOpts = {
  freq: number;
  to?: number;
  type?: OscillatorType;
  at?: number;
  attack?: number;
  decay?: number;
  gain?: number;
  glide?: number;
};
export function tone(c: AudioContext, out: AudioNode, o: ToneOpts) {
  const t0 = c.currentTime + (o.at ?? 0);
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = o.type ?? "sine";
  osc.frequency.setValueAtTime(o.freq, t0);
  if (o.to)
    osc.frequency.exponentialRampToValueAtTime(
      o.to,
      t0 + (o.glide ?? o.decay ?? 0.1)
    );
  const a = o.attack ?? 0.004,
    d = o.decay ?? 0.12,
    peak = o.gain ?? 0.3;
  g.gain.value = 0.0001; // a gain node starts at 1: without this the very first sample of a note can click
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
  osc.connect(g).connect(out);
  osc.start(t0);
  osc.stop(t0 + a + d + 0.05);
}

export type NoiseOpts = {
  at?: number;
  attack?: number;
  decay?: number;
  gain?: number;
  filter?: BiquadFilterType;
  freq?: number;
  to?: number;
  q?: number;
};
export function hiss(c: AudioContext, out: AudioNode, o: NoiseOpts) {
  const t0 = c.currentTime + (o.at ?? 0);
  const n = noise(c);
  const f = c.createBiquadFilter();
  const g = c.createGain();
  f.type = o.filter ?? "bandpass";
  f.frequency.setValueAtTime(o.freq ?? 2000, t0);
  if (o.to)
    f.frequency.exponentialRampToValueAtTime(
      o.to,
      t0 + (o.attack ?? 0.01) + (o.decay ?? 0.1)
    );
  f.Q.value = o.q ?? 1;
  const a = o.attack ?? 0.003,
    d = o.decay ?? 0.08,
    peak = o.gain ?? 0.3;
  g.gain.value = 0.0001; // a gain node starts at 1: without this the very first sample of a note can click
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
  n.connect(f).connect(g).connect(out);
  n.start(t0, Math.random() * 0.5);
  n.stop(t0 + a + d + 0.05);
}

/** One sound: how it is made from oscillators and noise. `tone` and `hiss` are the building blocks. */
export type SoundDef = {
  category: string;
  label: string;
  play: (c: AudioContext, out: AudioNode) => void;
  /** Seconds the sound lasts, when it runs longer than the two the engine keeps it connected for (a recording). */
  length?: number;
};
type Def = SoundDef & { category: SoundCategory };

export const SOUNDS = {
  tap: {
    category: "Actions",
    label: "Tap",
    play: (c, o) => {
      tone(c, o, { freq: 900, to: 620, decay: 0.06, gain: 0.25 });
      hiss(c, o, { freq: 4000, decay: 0.015, gain: 0.08, filter: "highpass" });
    },
  },
  pop: {
    category: "Actions",
    label: "Pop",
    play: (c, o) =>
      tone(c, o, { freq: 320, to: 980, glide: 0.07, decay: 0.09, gain: 0.35 }),
  },
  knock: {
    category: "Actions",
    label: "Knock",
    play: (c, o) => {
      tone(c, o, { freq: 160, to: 90, decay: 0.1, gain: 0.5 });
      hiss(c, o, { freq: 900, decay: 0.04, gain: 0.25, q: 2 });
      tone(c, o, { at: 0.11, freq: 150, to: 85, decay: 0.09, gain: 0.35 });
      hiss(c, o, { at: 0.11, freq: 900, decay: 0.035, gain: 0.18, q: 2 });
    },
  },

  success: {
    category: "Feedback",
    label: "Landed",
    play: (c, o) => {
      tone(c, o, { freq: 1046.5, decay: 0.18, gain: 0.22, type: "triangle" });
      tone(c, o, {
        at: 0.09,
        freq: 1318.5,
        decay: 0.32,
        gain: 0.22,
        type: "triangle",
      });
    },
  },
  error: {
    category: "Feedback",
    label: "Bump",
    play: (c, o) => {
      tone(c, o, { freq: 220, decay: 0.09, gain: 0.18, type: "square" });
      tone(c, o, {
        at: 0.11,
        freq: 185,
        decay: 0.14,
        gain: 0.18,
        type: "square",
      });
    },
  },
  paid: {
    category: "Feedback",
    label: "Paid",
    play: (c, o) =>
      [1318.5, 1568, 2093].forEach((f, i) =>
        tone(c, o, {
          at: i * 0.065,
          freq: f,
          decay: 0.35 - i * 0.05,
          gain: 0.16,
          type: "triangle",
        })
      ),
  },

  whoosh: {
    category: "Navigation",
    label: "Whisk",
    play: (c, o) =>
      hiss(c, o, {
        attack: 0.06,
        decay: 0.18,
        freq: 400,
        to: 3200,
        gain: 0.22,
        q: 0.8,
      }),
  },
  step: {
    category: "Navigation",
    label: "Step",
    play: (c, o) => {
      tone(c, o, { freq: 520, decay: 0.05, gain: 0.18 });
      tone(c, o, { at: 0.06, freq: 700, decay: 0.07, gain: 0.16 });
    },
  },
  glide: {
    category: "Navigation",
    label: "Glide",
    play: (c, o) =>
      tone(c, o, {
        freq: 440,
        to: 880,
        glide: 0.18,
        attack: 0.03,
        decay: 0.2,
        gain: 0.18,
      }),
  },

  chime: {
    category: "Notifications",
    label: "Chime",
    play: (c, o) =>
      [1, 2.76, 5.4].forEach((m, i) =>
        tone(c, o, {
          freq: 880 * m,
          decay: 0.9 / (i + 1),
          gain: 0.18 / (i + 1),
        })
      ),
  },
  ping: {
    category: "Notifications",
    label: "Ping",
    play: (c, o) => tone(c, o, { freq: 1760, decay: 0.6, gain: 0.16 }),
  },
  beacon: {
    category: "Notifications",
    label: "Beacon",
    play: (c, o) => {
      tone(c, o, { freq: 1175, decay: 0.25, gain: 0.18, type: "triangle" });
      tone(c, o, {
        at: 0.18,
        freq: 1568,
        decay: 0.45,
        gain: 0.18,
        type: "triangle",
      });
    },
  },

  tick: {
    category: "Selection",
    label: "Tick",
    play: (c, o) =>
      hiss(c, o, { freq: 5000, decay: 0.012, gain: 0.3, filter: "highpass" }),
  },
  on: {
    category: "Selection",
    label: "Latch on",
    play: (c, o) => {
      hiss(c, o, { freq: 3000, decay: 0.01, gain: 0.2 });
      tone(c, o, { at: 0.01, freq: 600, to: 900, decay: 0.07, gain: 0.2 });
    },
  },
  off: {
    category: "Selection",
    label: "Latch off",
    play: (c, o) => {
      hiss(c, o, { freq: 2400, decay: 0.01, gain: 0.18 });
      tone(c, o, { at: 0.01, freq: 760, to: 480, decay: 0.07, gain: 0.18 });
    },
  },

  lift: {
    category: "Movement",
    label: "Lift",
    play: (c, o) => {
      hiss(c, o, {
        attack: 0.03,
        decay: 0.08,
        freq: 800,
        to: 2400,
        gain: 0.14,
      });
      tone(c, o, { freq: 300, to: 520, decay: 0.08, gain: 0.12 });
    },
  },
  drop: {
    category: "Movement",
    label: "Drop",
    play: (c, o) => {
      tone(c, o, { freq: 380, to: 120, glide: 0.08, decay: 0.12, gain: 0.35 });
      hiss(c, o, { at: 0.06, freq: 600, decay: 0.05, gain: 0.15 });
    },
  },
  swipe: {
    category: "Movement",
    label: "Swipe",
    play: (c, o) =>
      hiss(c, o, {
        attack: 0.02,
        decay: 0.12,
        freq: 3200,
        to: 500,
        gain: 0.2,
        q: 1.2,
      }),
  },

  charge: {
    category: "Progress",
    label: "Charge",
    play: (c, o) =>
      tone(c, o, {
        freq: 220,
        to: 880,
        glide: 0.5,
        attack: 0.08,
        decay: 0.5,
        gain: 0.14,
        type: "triangle",
      }),
  },
  done: {
    category: "Progress",
    label: "Complete",
    play: (c, o) =>
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
        tone(c, o, {
          at: i * 0.04,
          freq: f,
          attack: 0.01,
          decay: 0.6,
          gain: 0.1,
          type: "triangle",
        })
      ),
  },
  loading: {
    category: "Progress",
    label: "Loading",
    play: (c, o) =>
      [0, 0.12, 0.24].forEach((at, i) =>
        tone(c, o, { at, freq: 660 + i * 40, decay: 0.05, gain: 0.12 })
      ),
  },

  boot: {
    category: "System",
    label: "Boot",
    play: (c, o) =>
      [130.8, 196, 261.6, 392].forEach((f, i) =>
        tone(c, o, {
          at: i * 0.07,
          freq: f,
          attack: 0.08,
          decay: 0.9,
          gain: 0.08,
          type: "sine",
        })
      ),
  },
  hush: {
    category: "System",
    label: "Hush",
    play: (c, o) => {
      tone(c, o, {
        freq: 520,
        to: 180,
        glide: 0.35,
        attack: 0.02,
        decay: 0.35,
        gain: 0.14,
      });
      hiss(c, o, {
        attack: 0.05,
        decay: 0.3,
        freq: 1800,
        to: 300,
        gain: 0.06,
        filter: "lowpass",
      });
    },
  },
  alert: {
    category: "System",
    label: "Alert",
    play: (c, o) =>
      [0, 0.16, 0.32].forEach((at, i) =>
        tone(c, o, {
          at,
          freq: i % 2 ? 740 : 988,
          decay: 0.12,
          gain: 0.14,
          type: "triangle",
        })
      ),
  },
} satisfies Record<string, Def>;

export type SoundName = keyof typeof SOUNDS;

// ── Style ───────────────────────────────────────────────────────────
//
// A style re-voices the sounds above under the same names, so every component that plays "tap" or
// "chime" changes voice at once and no component code changes. The default style is "nexus" (the
// recipes in this file). Another file can add one: `@/lib/ui-sounds-mac` registers "mac" when it is
// imported. The visitor's choice is kept in localStorage ("ui-sounds-style").

const STYLE_KEY = "ui-sounds-style";
const styles = new Map<string, Partial<Record<SoundName, SoundDef>>>();
let style: string | null = null;
const styleListeners = new Set<() => void>();

/** Adds a style: recipes keyed by the sound names above. Missing names fall back to the default. */
export function registerSoundStyle(
  name: string,
  defs: Partial<Record<SoundName, SoundDef>>
) {
  styles.set(name, defs);
  styleListeners.forEach((l) => l());
}

/** The active style: "nexus" unless the visitor or your code picked another. */
export function getSoundStyle(): string {
  if (style === null) {
    style = "nexus";
    if (typeof window !== "undefined") {
      try {
        style = window.localStorage.getItem(STYLE_KEY) || "nexus";
      } catch {
        // storage blocked: the default style
      }
    }
  }
  return style;
}

/** Pick the style every sound uses. Remembered in this browser unless `persist` is false. */
export function setSoundStyle(name: string, persist = true) {
  style = name;
  if (persist && typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STYLE_KEY, name);
    } catch {
      // storage blocked: the choice lasts until the page closes
    }
  }
  styleListeners.forEach((l) => l());
}

function subscribeStyle(onChange: () => void) {
  styleListeners.add(onChange);
  return () => {
    styleListeners.delete(onChange);
  };
}

/** The style as React state: `[style, setStyle]`. The server render reads "nexus". */
export function useSoundStyle(): [string, (name: string) => void] {
  const current = React.useSyncExternalStore(
    subscribeStyle,
    getSoundStyle,
    () => "nexus"
  );
  return [current, setSoundStyle];
}

// ── Preference ──────────────────────────────────────────────────────
//
// One switch for every sound on the page. A visitor's choice is kept in
// localStorage ("ui-sounds": "on" | "off"); until they choose, the default
// applies (on, unless you call configureSounds({ defaultEnabled: false })).

const STORE_KEY = "ui-sounds";
let defaultEnabled = true;
let chosen: boolean | null = null; // the visitor's saved or runtime choice
let loaded = false;
const listeners = new Set<() => void>();

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const v = window.localStorage.getItem(STORE_KEY);
    if (v === "on") chosen = true;
    else if (v === "off") chosen = false;
  } catch {
    // storage blocked: the default applies
  }
}

function emit() {
  listeners.forEach((l) => l());
}

/** Whether sounds are on right now. */
export function getSoundsEnabled(): boolean {
  load();
  return chosen ?? defaultEnabled;
}

/** Whether sounds are on until the visitor chooses. Call once, early, in client code. */
export function configureSounds(opts: { defaultEnabled?: boolean }) {
  if (
    typeof opts.defaultEnabled === "boolean" &&
    opts.defaultEnabled !== defaultEnabled
  ) {
    defaultEnabled = opts.defaultEnabled;
    emit();
  }
}

/** Turn sounds on or off. The choice is remembered in this browser unless `persist` is false. */
export function setSoundsEnabled(on: boolean, persist = true) {
  load();
  chosen = on;
  if (persist) {
    try {
      window.localStorage.setItem(STORE_KEY, on ? "on" : "off");
    } catch {
      // storage blocked: the choice lasts until the page closes
    }
  }
  emit();
}

/** Mute or unmute every sound for this page load (for a "Sounds off" preference you store yourself). */
export function setSoundsMuted(value: boolean) {
  setSoundsEnabled(!value, false);
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== STORE_KEY) return;
    loaded = false;
    chosen = null;
    emit();
  };
  if (typeof window !== "undefined")
    window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    if (typeof window !== "undefined")
      window.removeEventListener("storage", onStorage);
  };
}

/**
 * The sound switch as React state: `[enabled, setEnabled]`. Use it for a speaker button. The server
 * render always reads "off", so the first paint matches and the real value arrives right after.
 */
export function useSoundsEnabled(): [boolean, (on: boolean) => void] {
  const enabled = React.useSyncExternalStore(
    subscribe,
    getSoundsEnabled,
    () => false
  );
  return [enabled, setSoundsEnabled];
}

// ── Playing ─────────────────────────────────────────────────────────

const lastPlayed = new Map<string, number>();

/**
 * Play a sound by name. volume is 0..1 on top of the master level. It stays silent while the
 * visitor has sounds off, unless `force` is set (for a button whose whole job is to play the sound).
 */
export function playSound(name: SoundName, volume = 1, force = false) {
  if (!(name in SOUNDS)) return;
  // The active style may voice this sound differently; anything it leaves out keeps the default.
  playDef(
    name,
    styles.get(getSoundStyle())?.[name] ?? SOUNDS[name],
    volume,
    force
  );
}

/**
 * Play any sound definition (the Pro sound pack uses this). `key` names it for the 30 ms de-bounce.
 * It follows the same on/off switch as playSound.
 */
export function playDef(key: string, def: SoundDef, volume = 1, force = false) {
  if (!force && !getSoundsEnabled()) return;
  if (typeof document !== "undefined" && document.hidden) return;
  // The same sound twice within 30ms is one sound: it keeps fast input from stacking into a buzz.
  const now =
    typeof performance !== "undefined" ? performance.now() : Date.now();
  if (now - (lastPlayed.get(key) ?? -1e9) < 30) return;
  lastPlayed.set(key, now);
  const c = audio();
  if (!c || !master) return;
  const g = c.createGain();
  g.gain.value = Math.max(0, Math.min(1, volume));
  g.connect(master);
  def.play(c, g);
  setTimeout(
    () => g.disconnect(),
    Math.max(2000, (def.length ?? 0) * 1000 + 300)
  );
}

/** Whether the audio engine is awake. Browsers keep it asleep until the visitor's first click or key press. */
export function audioAwake() {
  // The visitor has clicked or pressed a key somewhere on the page: the browser lets us start audio now.
  if (
    !ctx &&
    typeof navigator !== "undefined" &&
    navigator.userActivation?.hasBeenActive
  )
    audio();
  return !!ctx && ctx.state === "running";
}

/**
 * Autoplay demos make sound too, but only where you allow it. It is allowed everywhere by default.
 * Wrap a part of the page in <AutoplaySound allow={false}> to keep demos silent there (a grid of
 * previews, say) and in <AutoplaySound allow> to let the one you are showing be heard.
 */
// Server components load this file for the sound list; they have no createContext, and never render the provider.
const AutoplayCtx = (typeof React.createContext === "function"
  ? React.createContext(true)
  : null) as unknown as React.Context<boolean>;
export function AutoplaySound({
  allow,
  children,
}: {
  allow: boolean;
  children?: React.ReactNode;
}) {
  return React.createElement(AutoplayCtx.Provider, { value: allow }, children);
}

/** Whether autoplay demos may make sound here (see AutoplaySound). Used by the Pro sound hook. */
export function useAutoplaySoundAllowed() {
  return React.useContext(AutoplayCtx);
}

export type SoundPlayer = {
  (name: SoundName, volume?: number): void;
  /** For a sound that answers the component playing itself (autoplay). Silent until the visitor has used the page once. */
  auto: (name: SoundName, volume?: number) => void;
};

/**
 * For a component with a `sound` option: returns a play function that is silent when `enabled` is
 * false and otherwise follows the visitor's on/off switch. `play.auto(...)` is the same for sounds
 * made by autoplay.
 *
 *   const play = useSound(enableSound);
 */
export function useSound(enabled = true): SoundPlayer {
  const auto = React.useContext(AutoplayCtx);
  return React.useMemo(
    () =>
      Object.assign(
        (name: SoundName, volume = 1) => {
          if (enabled) playSound(name, volume);
        },
        {
          auto: (name: SoundName, volume = 1) => {
            if (enabled && auto && audioAwake()) playSound(name, volume);
          },
        }
      ),
    [enabled, auto]
  );
}

/** Set the overall level for every sound, 0..1. */
export function setSoundVolume(v: number) {
  audio();
  if (master)
    master.gain.value =
      Math.max(0, Math.min(1, v)) * (isTouchDevice() ? 0.9 : 0.5);
}
