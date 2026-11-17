// ============================================================================
// J.A.R.V.I.S. — SPEAKER VERIFICATION (VOICEPRINT LOCK) v2
// MFCC (mel-cepstrum) + F0 tabanlı konuşmacı doğrulama. Tamamen tarayıcıda çalışır.
// Kilit AÇIKKEN: ses analizi yapılamıyorsa / yeterli ses yoksa komut REDDEDİLİR (fail-closed).
// ============================================================================
const VP_VERSION = 2;
const VP_NMEL = 26;
const VP_NCEP = 12;
const VP_RMS_MIN = 0.01;
const VP_ENROLL_SECONDS = 10;
const VP_MIN_ENROLL_FRAMES = 60;
const VP_MIN_LIVE_FRAMES = 6;
const VP_SEG = 10;

const VP_STRICTNESS = {
  strict: { dist: 1.35, semitones: 2.5, label: 'Sıkı' },
  normal: { dist: 1.7, semitones: 3.5, label: 'Normal' },
  loose: { dist: 2.1, semitones: 5.0, label: 'Esnek' }
};

let vpStream = null;
let vpAnalyser = null;
let vpSource = null;
let vpTimer = null;
let vpFrames = [];
let vpCap = 120;
let vpMelBank = null;
let vpMelKey = '';

function vpHasPrint() {
  return Boolean(state.voicePrint && state.voicePrint.v === VP_VERSION && Array.isArray(state.voicePrint.mean));
}

function updateVoiceLockUI() {
  const btnToggle = document.getElementById('btnToggleVoiceLock');
  const btnClear = document.getElementById('btnClearVoicePrint');
  const status = document.getElementById('voiceLockStatus');
  const sel = document.getElementById('voiceStrictness');
  if (!btnToggle || !status) return;

  const legacy = state.voicePrint && state.voicePrint.v !== VP_VERSION;
  const hasPrint = vpHasPrint();
  if (btnClear) btnClear.style.display = state.voicePrint ? 'inline-block' : 'none';
  if (sel) {
    sel.style.display = hasPrint ? 'inline-block' : 'none';
    sel.value = (state.voicePrint && state.voicePrint.strictness) || 'normal';
  }

  if (legacy) {
    btnToggle.textContent = '🔓 Ses Kilidi: Kapalı';
    btnToggle.classList.remove('primary');
    status.textContent = '⚠️ Eski ses izi geçersiz — lütfen "Sesimi Tanıt" ile yeniden kaydedin.';
    status.style.color = '#f59e0b';
  } else if (!hasPrint) {
    btnToggle.textContent = '🔓 Ses Kilidi: Kapalı';
    btnToggle.classList.remove('primary');
    status.textContent = 'Ses izi kayıtlı değil — herkes komut verebilir.';
    status.style.color = '#8aa4c8';
  } else if (state.voicePrintEnabled) {
    btnToggle.textContent = '🔒 Ses Kilidi: AKTİF';
    btnToggle.classList.add('primary');
    status.textContent = `🔒 Sadece sahibimin sesi tanınıyor (~${Math.round(state.voicePrint.pitch)} Hz).`;
    status.style.color = '#00f0ff';
  } else {
    btnToggle.textContent = '🔓 Ses Kilidi: Kapalı';
    btnToggle.classList.remove('primary');
    status.textContent = 'Ses izi kayıtlı ancak kilit şu an devre dışı.';
    status.style.color = '#f59e0b';
  }
}

// ---------------------------------------------------------------- DSP ----
function vpEstimatePitch(timeData, sampleRate) {
  let rms = 0;
  for (let i = 0; i < timeData.length; i++) rms += timeData[i] * timeData[i];
  rms = Math.sqrt(rms / timeData.length);
  if (rms < VP_RMS_MIN) return { rms, pitch: 0 };

  const minLag = Math.floor(sampleRate / 340);
  const maxLag = Math.min(Math.floor(sampleRate / 70), Math.floor(timeData.length / 2));
  let energy0 = 0;
  for (let i = 0; i < timeData.length - maxLag; i++) energy0 += timeData[i] * timeData[i];
  let bestLag = 0;
  let bestCorr = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    let energyL = 0;
    for (let i = 0; i < timeData.length - maxLag; i++) {
      corr += timeData[i] * timeData[i + lag];
      energyL += timeData[i + lag] * timeData[i + lag];
    }
    const r = corr / Math.sqrt((energy0 * energyL) || 1);
    if (r > bestCorr) {
      bestCorr = r;
      bestLag = lag;
    }
  }
  return { rms, pitch: bestCorr > 0.5 && bestLag > 0 ? sampleRate / bestLag : 0 };
}

function vpGetMelBank(sampleRate, fftSize) {
  const key = `${sampleRate}_${fftSize}`;
  if (vpMelBank && vpMelKey === key) return vpMelBank;
  const lo = 100;
  const hi = Math.min(5000, sampleRate / 2 - 100);
  const mel = (f) => 2595 * Math.log10(1 + f / 700);
  const inv = (m) => 700 * (Math.pow(10, m / 2595) - 1);
  const pts = [];
  for (let i = 0; i < VP_NMEL + 2; i++) pts.push(inv(mel(lo) + ((mel(hi) - mel(lo)) * i) / (VP_NMEL + 1)));
  const binHz = sampleRate / fftSize;
  const bank = [];
  for (let m = 1; m <= VP_NMEL; m++) {
    const f = [];
    const start = Math.max(0, Math.floor(pts[m - 1] / binHz));
    const end = Math.ceil(pts[m + 1] / binHz);
    for (let b = start; b <= end; b++) {
      const hz = b * binHz;
      const w = hz <= pts[m] ? (hz - pts[m - 1]) / (pts[m] - pts[m - 1]) : (pts[m + 1] - hz) / (pts[m + 1] - pts[m]);
      if (w > 0) f.push([b, w]);
    }
    bank.push(f);
  }
  vpMelBank = bank;
  vpMelKey = key;
  return bank;
}

function vpCaptureFrame() {
  if (!vpAnalyser || !audioCtx) return;
  const timeData = new Float32Array(vpAnalyser.fftSize);
  vpAnalyser.getFloatTimeDomainData(timeData);
  const { rms, pitch } = vpEstimatePitch(timeData, audioCtx.sampleRate);
  if (rms < VP_RMS_MIN || pitch <= 0) return; // sessizlik / sürekli gürültü / sessiz harf -> atla

  const db = new Float32Array(vpAnalyser.frequencyBinCount);
  vpAnalyser.getFloatFrequencyData(db);
  const bank = vpGetMelBank(audioCtx.sampleRate, vpAnalyser.fftSize);
  const logE = new Array(VP_NMEL);
  for (let m = 0; m < VP_NMEL; m++) {
    let s = 0;
    for (const [b, w] of bank[m]) {
      const d = Number.isFinite(db[b]) ? Math.max(db[b], -140) : -140;
      s += w * Math.pow(10, d / 10);
    }
    logE[m] = Math.log(s + 1e-14);
  }
  const cep = new Array(VP_NCEP);
  for (let k = 1; k <= VP_NCEP; k++) {
    let c = 0;
    for (let m = 0; m < VP_NMEL; m++) c += logE[m] * Math.cos((Math.PI * k * (m + 0.5)) / VP_NMEL);
    cep[k - 1] = c;
  }
  vpFrames.push({ cep, pitch });
  if (vpFrames.length > vpCap) vpFrames.shift();
}

async function startVoiceAnalyser() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !audioCtx) return false;
  try {
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    if (!vpStream || !vpStream.active) {
      vpStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
      vpSource = audioCtx.createMediaStreamSource(vpStream);
      vpAnalyser = audioCtx.createAnalyser();
      vpAnalyser.fftSize = 2048;
      vpAnalyser.smoothingTimeConstant = 0;
      vpSource.connect(vpAnalyser);
    }
    vpFrames = [];
    if (!vpTimer) vpTimer = setInterval(vpCaptureFrame, 40);
    return true;
  } catch (e) {
    console.warn('VoiceAnalyser start failed:', e);
    return false;
  }
}

function stopVoiceAnalyser(keepStream = false) {
  if (vpTimer) {
    clearInterval(vpTimer);
    vpTimer = null;
  }
  if (!keepStream && vpStream) {
    vpStream.getTracks().forEach((t) => t.stop());
    vpStream = null;
    vpSource = null;
    vpAnalyser = null;
  }
}

// ----------------------------------------------------------- İstatistik ---
function vpMean(frames) {
  const mean = new Array(VP_NCEP).fill(0);
  for (const f of frames) for (let i = 0; i < VP_NCEP; i++) mean[i] += f.cep[i];
  return mean.map((v) => v / frames.length);
}

function vpMedianPitch(frames) {
  const p = frames.map((f) => f.pitch).sort((a, b) => a - b);
  return p.length ? p[Math.floor(p.length / 2)] : 0;
}

function vpBuildSignature(frames) {
  if (!frames || frames.length < VP_MIN_ENROLL_FRAMES) return null;
  const mean = vpMean(frames);

  // Aynı kişinin kısa parçalar (~kelime) arasındaki doğal değişimi -> konuşmacı içi sapma
  const segMeans = [];
  for (let i = 0; i + VP_SEG <= frames.length; i += Math.floor(VP_SEG / 2)) {
    segMeans.push(vpMean(frames.slice(i, i + VP_SEG)));
  }
  const frameStd = new Array(VP_NCEP).fill(0);
  for (const f of frames) for (let i = 0; i < VP_NCEP; i++) frameStd[i] += (f.cep[i] - mean[i]) ** 2;
  for (let i = 0; i < VP_NCEP; i++) frameStd[i] = Math.sqrt(frameStd[i] / frames.length);

  const std = new Array(VP_NCEP).fill(0);
  for (const s of segMeans) for (let i = 0; i < VP_NCEP; i++) std[i] += (s[i] - mean[i]) ** 2;
  for (let i = 0; i < VP_NCEP; i++) {
    std[i] = Math.sqrt(std[i] / Math.max(1, segMeans.length));
    std[i] = Math.max(std[i], frameStd[i] * 0.25, 1e-3);
  }

  return {
    v: VP_VERSION,
    mean: mean.map((v) => Number(v.toFixed(4))),
    std: std.map((v) => Number(v.toFixed(4))),
    pitch: Math.round(vpMedianPitch(frames)),
    n: frames.length,
    strictness: (state.voicePrint && state.voicePrint.strictness) || 'normal',
    createdAt: new Date().toISOString()
  };
}

function vpVerify(frames, enrolled) {
  if (!frames || frames.length < VP_MIN_LIVE_FRAMES) {
    return { ok: false, reason: 'short', n: frames ? frames.length : 0 };
  }
  const cfg = VP_STRICTNESS[enrolled.strictness] || VP_STRICTNESS.normal;
  const live = vpMean(frames);
  let sum = 0;
  for (let i = 0; i < VP_NCEP; i++) sum += ((live[i] - enrolled.mean[i]) / enrolled.std[i]) ** 2;
  const dist = Math.sqrt(sum / VP_NCEP);
  const pitch = vpMedianPitch(frames);
  const semis = pitch > 0 && enrolled.pitch > 0 ? Math.abs(12 * Math.log2(pitch / enrolled.pitch)) : 99;
  const ok = dist <= cfg.dist && semis <= cfg.semitones;
  return { ok, dist, semis, pitch, n: frames.length, reason: ok ? 'ok' : 'mismatch' };
}

// Konuşma sonucu çağrılır. {allowed, message}
function vpGate() {
  const frames = vpFrames.slice();
  vpFrames = [];
  if (!(state.voicePrintEnabled && vpHasPrint())) return { allowed: true };

  if (!vpAnalyser) {
    return { allowed: false, message: '⛔ Mikrofon ses analizi yapılamadı — Ses Kilidi açıkken komut reddedildi.' };
  }
  const r = vpVerify(frames, state.voicePrint);
  if (r.reason === 'short') {
    return { allowed: false, message: `⛔ Ses izi doğrulanamadı (yetersiz ses: ${r.n} kare). Biraz daha yüksek/uzun konuşun.` };
  }
  const info = `uzaklık ${r.dist.toFixed(2)}, ton farkı ${r.semis >= 99 ? '?' : r.semis.toFixed(1)} yarım ses`;
  if (!r.ok) return { allowed: false, message: `⛔ Tanınmayan ses — komut reddedildi (${info})` };
  return { allowed: true, message: `✅ Ses doğrulandı (${info})` };
}

// ------------------------------------------------------------- Kayıt ----
async function enrollUserVoice() {
  if (state.isEnrollingVoice) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast('Ses izi kaydı için mikrofon erişimi gerekli (http://localhost:7777 üzerinden açın).');
    return;
  }
  if (state.isListening && recognition) {
    const wasWake = state.wakeWordMode;
    state.wakeWordMode = false;
    recognition.stop();
    state.wakeWordMode = wasWake;
  }
  state.isEnrollingVoice = true;
  const btn = document.getElementById('btnEnrollVoice');
  const status = document.getElementById('voiceLockStatus');
  if (btn) btn.disabled = true;

  vpCap = 1000;
  const started = await startVoiceAnalyser();
  if (!started) {
    vpCap = 120;
    state.isEnrollingVoice = false;
    if (btn) btn.disabled = false;
    showToast('Mikrofon açılamadı, lütfen izin verin.');
    return;
  }

  let sec = VP_ENROLL_SECONDS;
  const render = () => {
    if (!status) return;
    status.style.color = '#00f0ff';
    status.textContent = `🎙️ (${sec}s) Normal sesinizle sürekli okuyun: "Merhaba Jarvis, ben senin sahibinim. Sistemleri yalnızca benim sesime kilitle, başkasının komutunu dinleme."  [${vpFrames.length}/${VP_MIN_ENROLL_FRAMES}]`;
  };
  render();
  const countdown = setInterval(() => { sec = Math.max(0, sec - 1); render(); }, 1000);

  setTimeout(async () => {
    clearInterval(countdown);
    const sig = vpBuildSignature(vpFrames);
    const got = vpFrames.length;
    stopVoiceAnalyser(false);
    vpCap = 120;
    vpFrames = [];
    state.isEnrollingVoice = false;
    if (btn) btn.disabled = false;

    if (!sig) {
      if (status) {
        status.textContent = `⚠️ Yeterli ses alınamadı (${got}/${VP_MIN_ENROLL_FRAMES}). Mikrofona yakın ve kesintisiz konuşup tekrar deneyin.`;
        status.style.color = '#f59e0b';
      }
      showToast('Ses yetersiz, tekrar deneyin.');
      return;
    }
    state.voicePrint = sig;
    state.voicePrintEnabled = true;
    await apiFetch('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ voicePrint: sig, voicePrintEnabled: true })
    });
    updateVoiceLockUI();
    playHudSound('success');
    showToast('Ses iziniz kaydedildi ve Ses Kilidi aktif!');
    speakJarvis(`Ses iziniz kaydedildi ${state.userName}. Kilit aktif.`);
  }, VP_ENROLL_SECONDS * 1000 + 300);
}

async function toggleVoiceLock() {
  if (!vpHasPrint()) {
    showToast('Önce "Sesimi Tanıt" ile ses izinizi kaydedin.');
    return;
  }
  state.voicePrintEnabled = !state.voicePrintEnabled;
  await apiFetch('/api/settings', {
    method: 'POST',
    body: JSON.stringify({ voicePrintEnabled: state.voicePrintEnabled })
  });
  updateVoiceLockUI();
  showToast(state.voicePrintEnabled ? '🔒 Ses Kilidi aktif.' : '🔓 Ses Kilidi devre dışı.');
}

async function setVoiceStrictness(level) {
  if (!vpHasPrint()) return;
  state.voicePrint.strictness = level;
  await apiFetch('/api/settings', {
    method: 'POST',
    body: JSON.stringify({ voicePrint: state.voicePrint })
  });
  showToast(`Hassasiyet: ${VP_STRICTNESS[level].label}`);
}

async function clearVoicePrint() {
  state.voicePrint = null;
  state.voicePrintEnabled = false;
  await apiFetch('/api/settings', {
    method: 'POST',
    body: JSON.stringify({ voicePrint: null, voicePrintEnabled: false })
  });
  updateVoiceLockUI();
  showToast('Kayıtlı ses izi silindi.');
}
