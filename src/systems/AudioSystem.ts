/**
 * Procedural WebAudio: 조선 percussion, wind, crickets, sword, bow, horde
 * groans, heartbeat, dawn bell. No external assets, no API keys.
 */
export class AudioSystem {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private unlocked = false;
  private muted = false;

  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private cricketGain: GainNode | null = null;
  private cricketOsc: OscillatorNode | null = null;
  private droneGain: GainNode | null = null;
  private droneOscA: OscillatorNode | null = null;
  private droneOscB: OscillatorNode | null = null;
  private lastGroan = 0;
  private lastHeartbeat = 0;
  private groanVoices = 0;

  private readonly noiseBuffer: AudioBuffer | null = null;

  constructor() {
    try {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.context = new Ctor();
      this.master = this.context.createGain();
      this.master.gain.value = 0.55;
      this.master.connect(this.context.destination);

      const sampleRate = this.context.sampleRate;
      const buffer = this.context.createBuffer(1, sampleRate * 2, sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
      this.noiseBuffer = buffer;
    } catch {
      this.context = null;
    }
  }

  unlock(): void {
    if (!this.context || this.unlocked) return;
    void this.context.resume();
    this.unlocked = true;
    this.startAmbience();
    this.ensureBgm();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.55, this.context.currentTime, 0.05);
    }
  }

  get isMuted(): boolean {
    return this.muted;
  }

  private startAmbience(): void {
    const ctx = this.context;
    if (!ctx || !this.master || !this.noiseBuffer) return;

    // Wind: filtered noise loop, slowly wandering cutoff.
    const windSource = ctx.createBufferSource();
    windSource.buffer = this.noiseBuffer;
    windSource.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 420;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0.028;
    windSource.connect(this.windFilter).connect(this.windGain).connect(this.master);
    windSource.start();

    // Crickets: high sine chirp gate (night only).
    this.cricketOsc = ctx.createOscillator();
    this.cricketOsc.type = 'sine';
    this.cricketOsc.frequency.value = 4200;
    const cricketAm = ctx.createGain();
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 11;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.5;
    lfo.connect(lfoGain).connect(cricketAm.gain);
    cricketAm.gain.value = 0.5;
    this.cricketGain = ctx.createGain();
    this.cricketGain.gain.value = 0;
    this.cricketOsc.connect(cricketAm).connect(this.cricketGain).connect(this.master);
    this.cricketOsc.start();
    lfo.start();

    // Dread drone: detuned low pair (dusk/night tension bed).
    this.droneOscA = ctx.createOscillator();
    this.droneOscA.type = 'sawtooth';
    this.droneOscA.frequency.value = 52;
    this.droneOscB = ctx.createOscillator();
    this.droneOscB.type = 'sawtooth';
    this.droneOscB.frequency.value = 52.7;
    const droneFilter = ctx.createBiquadFilter();
    droneFilter.type = 'lowpass';
    droneFilter.frequency.value = 160;
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0;
    this.droneOscA.connect(droneFilter);
    this.droneOscB.connect(droneFilter);
    droneFilter.connect(this.droneGain).connect(this.master);
    this.droneOscA.start();
    this.droneOscB.start();
  }

  /** Drive ambience by game phase. */
  setPhase(phase: 'day' | 'sunset' | 'night' | 'dawn'): void {
    const ctx = this.context;
    if (!ctx) return;
    const now = ctx.currentTime;
    const ramp = (param: AudioParam | null | undefined, value: number, time = 1.2) => {
      param?.setTargetAtTime(value, now, time);
    };
    switch (phase) {
      case 'day':
        ramp(this.windGain?.gain, 0.03);
        ramp(this.cricketGain?.gain, 0.004);
        ramp(this.droneGain?.gain, 0.0);
        break;
      case 'sunset':
        ramp(this.windGain?.gain, 0.05);
        ramp(this.cricketGain?.gain, 0.012);
        ramp(this.droneGain?.gain, 0.018);
        break;
      case 'night':
        ramp(this.windGain?.gain, 0.042, 2.5);
        ramp(this.cricketGain?.gain, 0.02, 2.5);
        ramp(this.droneGain?.gain, 0.05, 2.5);
        break;
      case 'dawn':
        ramp(this.windGain?.gain, 0.02);
        ramp(this.cricketGain?.gain, 0.006);
        ramp(this.droneGain?.gain, 0.006);
        break;
      default:
        break;
    }
    if (this.windFilter) {
      const cutoff = phase === 'night' ? 300 : phase === 'sunset' ? 520 : 420;
      this.windFilter.frequency.setTargetAtTime(cutoff, now, 2);
    }
  }

  private env(dur: number, peak = 1, attack = 0.005): GainNode | null {
    const ctx = this.context;
    if (!ctx || !this.master) return null;
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), now + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    gain.connect(this.master);
    return gain;
  }

  private noiseBurst(dur: number, peak: number, type: BiquadFilterType, freq: number, q = 0.8): void {
    const ctx = this.context;
    if (!ctx || !this.noiseBuffer) return;
    const env = this.env(dur, peak, 0.004);
    if (!env) return;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    source.connect(filter).connect(env);
    source.start();
    source.stop(ctx.currentTime + dur + 0.05);
  }

  /** 북 — dusk alarm drum, deep membrane hit. */
  drum(intensity = 1): void {
    const ctx = this.context;
    if (!ctx) return;
    const env = this.env(0.7, 0.9 * intensity, 0.002);
    if (!env) return;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const now = ctx.currentTime;
    osc.frequency.setValueAtTime(120, now);
    osc.frequency.exponentialRampToValueAtTime(46, now + 0.28);
    osc.connect(env);
    osc.start();
    osc.stop(now + 0.75);
    this.noiseBurst(0.1, 0.18 * intensity, 'bandpass', 900, 1.2);
  }

  // ── Gatling: continuous spin bed + per-shot crack + vent hiss. ──
  private gatlingGain: GainNode | null = null;
  private gatlingOsc: OscillatorNode | null = null;
  private gatlingFilter: BiquadFilterNode | null = null;
  private gatlingActive = false;

  private ensureGatling(): void {
    const ctx = this.context;
    if (!ctx || !this.master || !this.noiseBuffer || this.gatlingActive) return;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;
    this.gatlingFilter = ctx.createBiquadFilter();
    this.gatlingFilter.type = 'bandpass';
    this.gatlingFilter.frequency.value = 900;
    this.gatlingFilter.Q.value = 0.7;
    this.gatlingGain = ctx.createGain();
    this.gatlingGain.gain.value = 0;
    source.connect(this.gatlingFilter).connect(this.gatlingGain).connect(this.master);
    source.start();
    this.gatlingOsc = ctx.createOscillator();
    this.gatlingOsc.type = 'sawtooth';
    this.gatlingOsc.frequency.value = 55;
    const oscGain = ctx.createGain();
    oscGain.gain.value = 0.35;
    this.gatlingOsc.connect(oscGain).connect(this.gatlingGain);
    this.gatlingOsc.start();
    this.gatlingActive = true;
  }

  setGatling(rate01: number): void {
    const ctx = this.context;
    if (!ctx) return;
    if (rate01 <= 0.001) {
      if (this.gatlingGain) this.gatlingGain.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
      return;
    }
    this.ensureGatling();
    if (!this.gatlingGain || !this.gatlingOsc || !this.gatlingFilter) return;
    this.gatlingGain.gain.setTargetAtTime(0.05 + rate01 * 0.1, ctx.currentTime, 0.06);
    this.gatlingOsc.frequency.setTargetAtTime(45 + rate01 * 190, ctx.currentTime, 0.08);
    this.gatlingFilter.frequency.setTargetAtTime(700 + rate01 * 1400, ctx.currentTime, 0.08);
  }

  gatlingShot(spin01: number, rng: () => number): void {
    if (!this.context) return;
    const pitch = 0.8 + rng() * 0.4 + spin01 * 0.3;
    this.noiseBurst(0.05, 0.16 + spin01 * 0.14, 'highpass', 2400 * pitch, 0.6);
    this.noiseBurst(0.09, 0.1, 'lowpass', 320 * pitch, 0.5);
  }

  vent(): void {
    this.noiseBurst(1.8, 0.22, 'highpass', 1800, 0.4);
  }

  slash(): void {
    this.noiseBurst(0.16, 0.34, 'highpass', 2600, 0.7);
  }

  bowDraw(): void {
    this.noiseBurst(0.22, 0.1, 'bandpass', 700, 2);
  }

  bowRelease(): void {
    const ctx = this.context;
    if (!ctx) return;
    this.noiseBurst(0.09, 0.3, 'highpass', 1400, 0.8);
    const env = this.env(0.14, 0.12, 0.002);
    if (!env) return;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(680, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(220, ctx.currentTime + 0.1);
    osc.connect(env);
    osc.start();
    osc.stop(ctx.currentTime + 0.16);
  }

  hit(): void {
    this.noiseBurst(0.12, 0.42, 'lowpass', 700, 0.6);
  }

  /** Wet flesh impact for every bullet that lands. */
  impact(): void {
    this.noiseBurst(0.06, 0.22, 'bandpass', 620, 1.4);
  }

  /** Meaty kill thump — body catch + low crunch. */
  splat(): void {
    const ctx = this.context;
    if (!ctx) return;
    this.noiseBurst(0.16, 0.5, 'lowpass', 420, 0.5);
    const env = this.env(0.22, 0.3, 0.003);
    if (!env) return;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(130, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(42, ctx.currentTime + 0.16);
    osc.connect(env);
    osc.start();
    osc.stop(ctx.currentTime + 0.24);
  }

  /** Bullet on door-plating: metallic clank. */
  armorClank(): void {
    const ctx = this.context;
    if (!ctx) return;
    this.noiseBurst(0.04, 0.2, 'highpass', 3000, 0.8);
    const env = this.env(0.09, 0.14, 0.002);
    if (!env) return;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1900 + Math.random() * 500, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(700, ctx.currentTime + 0.07);
    osc.connect(env);
    osc.start();
    osc.stop(ctx.currentTime + 0.1);
  }

  /** Door shield shattering off a shieldbearer. */
  shieldBreak(): void {
    const ctx = this.context;
    if (!ctx) return;
    this.noiseBurst(0.3, 0.5, 'bandpass', 900, 0.8);
    this.noiseBurst(0.14, 0.3, 'highpass', 1800, 0.6);
    const env = this.env(0.26, 0.2, 0.003);
    if (!env) return;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(220, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(70, ctx.currentTime + 0.2);
    osc.connect(env);
    osc.start();
    osc.stop(ctx.currentTime + 0.28);
  }

  /** Bloater detonation: deep wet boom + sub drop. */
  boom(): void {
    const ctx = this.context;
    if (!ctx) return;
    this.noiseBurst(0.5, 0.85, 'lowpass', 210, 0.4);
    this.noiseBurst(0.18, 0.4, 'bandpass', 1400, 0.5);
    const env = this.env(0.55, 0.55, 0.004);
    if (!env) return;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(95, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(26, ctx.currentTime + 0.4);
    osc.connect(env);
    osc.start();
    osc.stop(ctx.currentTime + 0.6);
  }

  /** Brute entrance: low plague roar. */
  roar(): void {
    const ctx = this.context;
    if (!ctx) return;
    const env = this.env(1.1, 0.4, 0.08);
    if (!env) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(52, now);
    osc.frequency.linearRampToValueAtTime(38, now + 0.9);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 300;
    osc.connect(filter).connect(env);
    osc.start();
    osc.stop(now + 1.2);
  }

  // ── BGM: Suno score, state machine with crossfades ─────────────────
  // One <audio> element per state; gains wired into the master bus so the
  // procedural ambience and the score mix through one fader.
  private readonly bgm: Map<string, { element: HTMLAudioElement; gain: GainNode }> = new Map();
  private bgmCurrent: string | null = null;
  private bgmWanted: string | null = null;
  private readonly bgmLevel = 0.5;

  /** Crossfade to a named score state: title|wave|tide|bloodnight|lull. */
  setBgmState(name: string): void {
    if (this.bgmWanted === name) return;
    this.bgmWanted = name;
    // Fade the old track out, then hand the bus to the new one.
    const ctx = this.context;
    if (!ctx) return;
    for (const [key, track] of this.bgm) {
      if (key === this.bgmCurrent) {
        track.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.55);
      }
    }
    const next = this.bgm.get(name);
    if (next) {
      if (this.bgmCurrent && this.bgm.get(this.bgmCurrent)) {
        // Pause the outgoing track once its fade lands.
        const outgoing = this.bgm.get(this.bgmCurrent)!;
        window.setTimeout(() => {
          if (this.bgmWanted !== this.bgmCurrent) {
            outgoing.element.pause();
          }
        }, 1800);
      }
      next.element.currentTime = 0;
      next.gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      next.gain.gain.setTargetAtTime(this.bgmLevel, ctx.currentTime, 0.7);
      void next.element.play().catch(() => undefined);
      this.bgmCurrent = name;
    }
    // The score carries the tension bed — stand the procedural drone down.
    this.bgmActive = name !== null;
  }

  /** One-shot sting (death). Crossfades everything else out first. */
  playSting(name: string): void {
    const track = this.bgm.get(name);
    const ctx = this.context;
    if (!track || !ctx) return;
    this.bgmWanted = name;
    for (const [key, other] of this.bgm) {
      if (key !== name) other.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.4);
    }
    track.element.loop = false;
    track.element.currentTime = 0;
    track.gain.gain.setValueAtTime(0.7, ctx.currentTime);
    void track.element.play().catch(() => undefined);
    this.bgmCurrent = name;
    this.bgmActive = false;
  }

  get bgmActive(): boolean {
    return this.bgmWanted !== null && this.bgmWanted !== 'death-sting';
  }

  set bgmActive(value: boolean) {
    if (value === this.bgmDucked) return;
    this.bgmDucked = value;
  }

  private bgmDucked = false;

  get bgmStateName(): string {
    return this.bgmWanted ?? 'none';
  }

  private ensureBgm(): void {
    const ctx = this.context;
    if (!ctx || !this.master || this.bgm.size > 0) return;
    for (const name of ['title', 'wave', 'tide', 'bloodnight', 'lull', 'death-sting']) {
      const element = new Audio(`/bgm/${name}.mp3`);
      element.loop = name !== 'death-sting';
      element.preload = 'auto';
      const gain = ctx.createGain();
      gain.gain.value = 0.0001;
      const source = ctx.createMediaElementSource(element);
      source.connect(gain).connect(this.master);
      this.bgm.set(name, { element, gain });
    }
  }
  // ── Adaptive threat bed: drone + war-drum pulse scale with the horde. ──
  private threat = 0;
  private threatPulse = 0;

  setThreat(level01: number): void {
    this.threat = Math.max(0, Math.min(1, level01));
  }

  /** Per-frame threat mixer; call after setThreat. */
  updateThreat(delta: number): void {
    const ctx = this.context;
    if (!ctx || !this.unlocked) return;
    // The score owns the tension bed — the procedural drone steps down to
    // a whisper instead of fighting the mix.
    const bedScale = this.bgmActive ? 0.3 : 1;
    if (this.droneGain) {
      this.droneGain.gain.setTargetAtTime((0.02 + this.threat * 0.075) * bedScale, ctx.currentTime, 0.5);
    }
    if (!this.bgmActive && this.threat > 0.3) {
      this.threatPulse -= delta;
      if (this.threatPulse <= 0) {
        this.threatPulse = 1.9 - this.threat * 1.1;
        this.drum(0.15 + this.threat * 0.13);
      }
    } else {
      this.threatPulse = Math.min(this.threatPulse, 0.6);
    }
  }

  kill(): void {
    this.noiseBurst(0.2, 0.5, 'lowpass', 480, 0.5);
    const ctx = this.context;
    if (!ctx) return;
    const env = this.env(0.3, 0.14, 0.004);
    if (!env) return;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(160, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(60, ctx.currentTime + 0.22);
    osc.connect(env);
    osc.start();
    osc.stop(ctx.currentTime + 0.32);
  }

  /** 원귀 신음 — throttled polyphonic groan; density scales with proximity count. */
  groan(): void {
    const ctx = this.context;
    if (!ctx) return;
    const now = ctx.currentTime;
    if (now - this.lastGroan < 0.55 || this.groanVoices > 4) return;
    this.lastGroan = now;
    this.groanVoices += 1;
    const env = this.env(0.9 + Math.random() * 0.5, 0.05, 0.18);
    if (!env) {
      this.groanVoices -= 1;
      return;
    }
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const base = 90 + Math.random() * 70;
    osc.frequency.setValueAtTime(base, now);
    osc.frequency.linearRampToValueAtTime(base * 0.72, now + 1.1);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 500;
    osc.connect(filter).connect(env);
    osc.start();
    osc.stop(now + 1.5);
    osc.onended = () => { this.groanVoices -= 1; };
  }

  heartbeat(): void {
    const ctx = this.context;
    if (!ctx) return;
    const now = ctx.currentTime;
    if (now - this.lastHeartbeat < 0.85) return;
    this.lastHeartbeat = now;
    for (const offset of [0, 0.18]) {
      const env = this.env(0.16, 0.24, 0.004);
      if (!env) continue;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(58, now + offset);
      osc.frequency.exponentialRampToValueAtTime(38, now + offset + 0.12);
      osc.connect(env);
      osc.start(now + offset);
      osc.stop(now + offset + 0.2);
    }
  }

  hurt(): void {
    this.noiseBurst(0.24, 0.5, 'lowpass', 380, 0.7);
  }

  pickup(): void {
    const ctx = this.context;
    if (!ctx) return;
    const env = this.env(0.2, 0.14, 0.004);
    if (!env) return;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(520, ctx.currentTime);
    osc.frequency.setValueAtTime(780, ctx.currentTime + 0.07);
    osc.connect(env);
    osc.start();
    osc.stop(ctx.currentTime + 0.22);
  }

  /** 새벽 종 — dawn bell, FM-ish metallic strike. */
  bell(): void {
    const ctx = this.context;
    if (!ctx) return;
    const env = this.env(2.8, 0.3, 0.002);
    if (!env) return;
    const now = ctx.currentTime;
    for (const ratio of [1, 2.02, 2.98, 4.16]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 174 * ratio;
      const partialGain = ctx.createGain();
      partialGain.gain.value = 1 / ratio;
      osc.connect(partialGain).connect(env);
      osc.start(now);
      osc.stop(now + 3);
    }
  }

  uiClick(): void {
    this.noiseBurst(0.05, 0.14, 'highpass', 2000, 0.7);
  }

  dispose(): void {
    try {
      this.cricketOsc?.stop();
      this.droneOscA?.stop();
      this.droneOscB?.stop();
      this.gatlingOsc?.stop();
      for (const track of this.bgm.values()) {
        track.element.pause();
        track.element.src = '';
      }
      this.bgm.clear();
      void this.context?.close();
    } catch {
      // Context may already be closed.
    }
    this.context = null;
  }
}
