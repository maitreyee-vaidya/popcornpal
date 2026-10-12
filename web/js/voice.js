// Voice in and out, all free:
//  - "browser" engine: the Web Speech API (Chrome, Edge, Safari). Live partial
//    transcripts, no download. Note Chrome sends audio to Google's speech service.
//  - "local" engine: Whisper (tiny.en) running on-device via transformers.js.
//    ~40 MB one-time download, audio never leaves the machine, works in Firefox.
//  - Replies are read aloud with the browser's built-in speechSynthesis.

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const browserSTTAvailable = !!SR;

export class Voice {
  constructor({ onInterim, onFinal, onState, onStatus }) {
    Object.assign(this, { onInterim, onFinal, onState, onStatus });
    this.engine = SR ? 'browser' : 'local';
    this.listening = false;
  }

  toggle() { return this.listening ? this.stop() : this.start(); }

  async start() {
    if (this.listening) return;
    window.speechSynthesis?.cancel();
    if (this.engine === 'browser' && SR) return this.startBrowser();
    return this.startLocal();
  }

  stop() {
    if (this.rec) this.rec.stop();
    if (this.recorder && this.recorder.state === 'recording') this.recorder.stop();
  }

  setListening(v) { this.listening = v; this.onState(v); }

  startBrowser() {
    const rec = new SR();
    this.rec = rec;
    rec.lang = this.lang || navigator.language || 'en-IN';
    rec.interimResults = true;
    rec.continuous = false;
    let finalText = '';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      this.onInterim((finalText + interim).trim());
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed') this.onStatus('Microphone permission was blocked.');
      else if (e.error === 'network') { this.onStatus('Browser speech service unreachable — switching to on-device Whisper.'); this.engine = 'local'; }
      else if (e.error !== 'no-speech' && e.error !== 'aborted') this.onStatus(`Speech error: ${e.error}`);
    };
    rec.onend = () => {
      this.rec = null;
      this.setListening(false);
      if (finalText.trim()) this.onFinal(finalText.trim());
    };
    rec.start();
    this.setListening(true);
  }

  // English uses the small English-only model (~40 MB). Indian languages use multilingual
  // whisper-base (~77 MB, once) in "transcribe" mode: tested on Hindi and Tamil speech it writes
  // the words accurately in their own script (which the parser understands), whereas its
  // "translate" mode garbled them ("show me a scary film" -> "I will show you a new movie").
  async loadWhisper() {
    const english = !this.lang || this.lang.startsWith('en');
    const id = english ? 'Xenova/whisper-tiny.en' : 'Xenova/whisper-base';
    this.whisperModels ??= {};
    if (this.whisperModels[id]) return this.whisperModels[id];
    const { pipeline } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1');
    const files = {};
    this.whisperModels[id] = await pipeline('automatic-speech-recognition', id, {
      dtype: 'q8',
      progress_callback: (p) => {
        if (p.status === 'progress' && p.total) {
          files[p.file] = [p.loaded, p.total];
          const [l, t] = Object.values(files).reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
          this.onStatus(`Loading on-device speech model (one time)… ${Math.round((100 * l) / t)}%`);
        }
      },
    });
    this.onStatus('');
    return this.whisperModels[id];
  }

  whisperOptions() {
    if (!this.lang || this.lang.startsWith('en')) return {};
    const names = { hi: 'hindi', te: 'telugu', ta: 'tamil', ml: 'malayalam', kn: 'kannada', bn: 'bengali', mr: 'marathi' };
    return { language: names[this.lang.slice(0, 2)] || 'hindi', task: 'transcribe' };
  }

  async startLocal() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      this.onStatus('Microphone permission was blocked.');
      return;
    }
    const whisperReady = this.loadWhisper();
    const chunks = [];
    const recorder = new MediaRecorder(stream);
    this.recorder = recorder;
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      this.setListening(false);
      clearTimeout(this.silenceTimer);
      this.audioCtx?.close();
      this.onInterim('Transcribing…');
      try {
        const audio = await decodeTo16k(new Blob(chunks, { type: recorder.mimeType }));
        const asr = await whisperReady;
        const { text } = await asr(audio, this.whisperOptions());
        const clean = text.replace(/\[.*?\]|\(.*?\)/g, '').trim();
        this.onInterim(clean);
        if (clean) this.onFinal(clean);
      } catch (err) {
        this.onStatus(`Couldn’t transcribe: ${err.message}`);
        this.onInterim('');
      }
    };
    recorder.start();
    this.setListening(true);
    this.onInterim('Listening… (tap the mic again to stop)');
    this.autoStopOnSilence(stream);
  }

  // Stops recording after ~1.4s of quiet once speech has started.
  autoStopOnSilence(stream) {
    const ctx = new AudioContext();
    this.audioCtx = ctx;
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    let spoke = false, quietSince = performance.now();
    const started = performance.now();
    const tick = () => {
      if (!this.listening) return;
      an.getFloatTimeDomainData(buf);
      const rms = Math.sqrt(buf.reduce((s, x) => s + x * x, 0) / buf.length);
      const now = performance.now();
      if (rms > 0.02) { spoke = true; quietSince = now; }
      if ((spoke && now - quietSince > 1400) || now - started > 15000) return this.stop();
      this.silenceTimer = setTimeout(tick, 80);
    };
    tick();
  }

  speak(text, onEnd) {
    const synth = window.speechSynthesis;
    if (!synth) return onEnd?.();
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const voices = synth.getVoices();
    u.voice = voices.find((v) => /en[-_]IN/i.test(v.lang))
      || voices.find((v) => /en[-_]/i.test(v.lang) && /natural|samantha|google us|aria|jenny/i.test(v.name))
      || voices.find((v) => /^en/i.test(v.lang)) || null;
    u.lang = u.voice?.lang || 'en-IN';
    u.rate = 1.03;
    u.onend = () => onEnd?.();
    u.onerror = () => onEnd?.();
    synth.speak(u);
  }
}

async function decodeTo16k(blob) {
  const raw = await blob.arrayBuffer();
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(raw);
  ctx.close();
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  return out.getChannelData(0);
}
