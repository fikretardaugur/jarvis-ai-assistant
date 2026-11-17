// ============================================================================
// J.A.R.V.I.S. MARK VII — CLIENT HUD ENGINE
// ============================================================================

let state = {
  voiceEnabled: true,
  sfxEnabled: true,
  wakeWordMode: false,
  isListening: false,
  liveStreamTimer: null,
  shortcuts: {},
  currentDir: '',
  parentDir: '',
  pinCode: localStorage.getItem('jarvis_pin') || '',
  userName: 'Efendim',
  voicePrint: null,
  voicePrintEnabled: false,
  isEnrollingVoice: false
};

// Web Audio API Synthesizer for Futuristic Stark HUD Sound Effects
const audioCtx = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)
  ? new (window.AudioContext || window.webkitAudioContext)()
  : null;

function playHudSound(type = 'click') {
  if (!state.sfxEnabled || !audioCtx) return;
  try {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    const now = audioCtx.currentTime;

    if (type === 'click') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1200, now);
      osc.frequency.exponentialRampToValueAtTime(1800, now + 0.045);
      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
      osc.start(now);
      osc.stop(now + 0.05);
    } else if (type === 'listen') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(520, now);
      osc.frequency.exponentialRampToValueAtTime(1040, now + 0.14);
      gain.gain.setValueAtTime(0.09, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
      osc.start(now);
      osc.stop(now + 0.15);
    } else if (type === 'ack') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.setValueAtTime(1320, now + 0.07);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
      osc.start(now);
      osc.stop(now + 0.18);
    }
  } catch (e) {}
}

function showToast(msg) {
  const el = document.getElementById('hudToast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 2800);
}

async function apiFetch(url, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(state.pinCode ? { 'X-Jarvis-Pin': state.pinCode } : {}),
    ...(options.headers || {})
  };
  const resp = await fetch(url, { ...options, headers });
  if (resp.status === 401) {
    const pin = prompt('JARVIS Güvenlik PIN Kodunu Girin:');
    if (pin !== null) {
      state.pinCode = pin;
      localStorage.setItem('jarvis_pin', pin);
      return apiFetch(url, options);
    }
  }
  return resp.json();
}

// ============================================================================
// NAVIGATION TABS
// ============================================================================
document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    playHudSound('click');
    const target = btn.getAttribute('data-tab');
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    const panel = document.getElementById(target);
    if (panel) panel.classList.add('active');

    if (target === 'tab-files' && !state.currentDir) {
      browseDir(state.shortcuts.desktop || '');
    }
    if (target === 'tab-remote') {
      loadProcesses();
    }
  });
});

document.getElementById('btnShowQr').addEventListener('click', () => {
  document.querySelector('.nav-btn[data-tab="tab-settings"]').click();
});

document.getElementById('btnToggleVoice').addEventListener('click', () => {
  state.voiceEnabled = !state.voiceEnabled;
  const btn = document.getElementById('btnToggleVoice');
  btn.textContent = state.voiceEnabled ? '🔊' : '🔇';
  if (!state.voiceEnabled && window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
  showToast(state.voiceEnabled ? 'JARVIS sesli yanıt aktif' : 'JARVIS sesli yanıt kapatıldı');
});

// ============================================================================
// TELEMETRY & INITIAL DATA LOAD
// ============================================================================
function updateTelemetryUI(t) {
  if (!t) return;
  document.getElementById('hdrCpu').textContent = `${t.cpu}%`;
  document.getElementById('hdrRam').textContent = `${t.ramPercent}%`;
  document.getElementById('hdrVol').textContent = t.muted ? 'SESSİZ' : `${t.volume}%`;
  document.getElementById('hdrBat').textContent = `${t.batteryPercent}%`;

  document.getElementById('tCpu').textContent = `${t.cpu}%`;
  document.getElementById('barCpu').style.width = `${t.cpu}%`;

  document.getElementById('tRam').textContent = `${t.ramUsedGB} / ${t.ramTotalGB} GB`;
  document.getElementById('barRam').style.width = `${t.ramPercent}%`;

  document.getElementById('tDisk').textContent = `${t.diskPercent}% (${t.diskUsedGB}GB)`;
  document.getElementById('barDisk').style.width = `${t.diskPercent}%`;

  document.getElementById('tWin').textContent = t.activeWindow || 'Masaüstü';
  document.getElementById('activeWindowSub').textContent = `AKTİF: ${t.activeWindow || 'Masaüstü'} // ${t.hostname || 'PC'}`;

  const slider = document.getElementById('volSlider');
  if (slider && document.activeElement !== slider) {
    slider.value = t.volume ?? 50;
  }
  const volBig = document.getElementById('volLabelBig');
  if (volBig) volBig.textContent = t.muted ? 'SESSİZ' : `${t.volume ?? 50}%`;

  const bSlider = document.getElementById('brightSlider');
  if (bSlider && document.activeElement !== bSlider && t.brightness !== undefined) {
    bSlider.value = t.brightness;
  }
  const bBig = document.getElementById('brightLabelBig');
  if (bBig && t.brightness !== undefined) bBig.textContent = `${t.brightness}%`;
}

async function initJarvis() {
  try {
    const info = await apiFetch('/api/info');
    if (info.telemetry) updateTelemetryUI(info.telemetry);
    if (info.shortcuts) state.shortcuts = info.shortcuts;
    if (info.config) {
      state.userName = info.config.userName || 'Efendim';
      state.voiceEnabled = info.config.voiceEnabled !== false;
      state.voiceProfile = info.config.voiceProfile || 'jarvis-ahmet';
      state.voicePrint = info.config.voicePrint || null;
      state.voicePrintEnabled = Boolean(info.config.voicePrintEnabled);
      if (typeof updateVoiceLockUI === 'function') updateVoiceLockUI();
      document.getElementById('btnToggleVoice').textContent = state.voiceEnabled ? '🔊' : '🔇';
      document.getElementById('cfgUserName').value = state.userName;
      const qv = document.getElementById('quickVoiceSelect');
      const cv = document.getElementById('cfgVoiceProfile');
      if (qv) qv.value = state.voiceProfile;
      if (cv) cv.value = state.voiceProfile;
      if (info.config.hasGeminiKey) {
        document.getElementById('cfgGeminiKey').placeholder = '•••••••• (Gemini Anahtarı Kayıtlı)';
        document.getElementById('aiEngineBadge').textContent = 'GEMINI AI + YEREL MOTOR AKTİF';
      }
      if (info.config.hasTelegram) {
        document.getElementById('cfgTelegramToken').placeholder = '•••••••• (Telegram Bot Aktif)';
      }
      if (info.config.gmailAddress) {
        const gAddr = document.getElementById('cfgGmailAddress');
        if (gAddr) gAddr.value = info.config.gmailAddress;
      }
      if (info.config.hasGmail) {
        const gPass = document.getElementById('cfgGmailAppPassword');
        if (gPass) gPass.placeholder = '•••••••• (Gmail Bağlı)';
      }
      if (info.config.smsWebhookUrl) {
        const sw = document.getElementById('cfgSmsWebhookUrl');
        if (sw) sw.value = info.config.smsWebhookUrl;
      }
      if (info.config.smsContactsText !== undefined) {
        const sc = document.getElementById('cfgSmsContacts');
        if (sc) sc.value = info.config.smsContactsText;
      }
      if (info.config.weatherCity !== undefined) {
        const wc = document.getElementById('cfgWeatherCity');
        if (wc) wc.value = info.config.weatherCity;
      }
      if (!info.config.weatherCity && navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const coords = `${pos.coords.latitude.toFixed(4)},${pos.coords.longitude.toFixed(4)}`;
            apiFetch('/api/settings', { method: 'POST', body: JSON.stringify({ geoCoords: coords }) }).catch(() => {});
          },
          () => {},
          { timeout: 5000 }
        );
      }
    }

    // Render LAN URL & QR Code
    if (info.network && info.network.primaryUrl) {
      const url = info.network.primaryUrl;
      document.getElementById('lanUrlBox').textContent = url;
      renderQRCode(url);
    }

    // Render Notes
    if (info.notes) renderNotes(info.notes);

    // Render Chat History or Welcome Message
    const stream = document.getElementById('chatStream');
    stream.innerHTML = '';
    if (info.chatHistory && info.chatHistory.length > 0) {
      info.chatHistory.forEach((m) => appendChatBubble(m.role, m.text, m.action, false));
    } else {
      appendChatBubble(
        'jarvis',
        `J.A.R.V.I.S. Mark VII çevrimiçi, ${state.userName}. Bilgisayarınızın ses, medya, uygulama, canlı ekran, dosya ve terminal sistemleri telefonunuzun emrinde. Ortadaki Arc Reactor çekirdeğine dokunarak sesli emir verebilirsiniz.`,
        null,
        false
      );
    }
  } catch (e) {
    console.error('Init error:', e);
  }

  // Connect Server-Sent Events for real-time telemetry & intruder alerts
  try {
    const es = new EventSource('/api/stream');
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === 'telemetry') updateTelemetryUI(data.telemetry);
        if (data.type === 'chat_cleared') {
          const stream = document.getElementById('chatStream');
          if (stream) stream.innerHTML = '';
        }
        if (data.type === 'alert' || data.type === 'reminder') {
          playHudSound('ack');
          const plain = String(data.message || '').replace(/[*_`]/g, '');
          showToast(plain.slice(0, 140));
          appendChatBubble('jarvis', plain, null);
          speakJarvis(String(data.speak || plain).replace(/[*_`]/g, ''));
        }
        if (data.type === 'intruder_alert') {
          playHudSound('ack');
          showToast('🚨 GÜVENLİK ALARMI TETİKLENDİ!');
          appendChatBubble('jarvis', data.message, data.webcam ? { type: 'screenshot', screenshot: data.webcam } : null);
          speakJarvis('Uyarı! Bilgisayarınızda yetkisiz erişim tespit edildi ve kilitlendi.');
        }
      } catch (e) {}
    };
  } catch (e) {}
}

// ============================================================================
// VOICE SYNTHESIS (STUDIO NEURAL TTS + FALLBACK) & SPEECH RECOGNITION (STT)
// ============================================================================
let currentTtsAudio = null;

async function speakJarvis(text, overrideProfile = null) {
  if (!state.voiceEnabled || !text) return;
  const reactor = document.getElementById('arcReactorBtn');
  try {
    if (currentTtsAudio) {
      currentTtsAudio.pause();
      currentTtsAudio = null;
    }
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }

    const profile = overrideProfile || state.voiceProfile || 'jarvis-ahmet';
    const shortText = String(text).split('\n\n💻')[0].trim();
    const ttsUrl = `/api/tts?text=${encodeURIComponent(shortText)}&profile=${encodeURIComponent(profile)}&pin=${encodeURIComponent(state.pinCode || '')}`;

    const audio = new Audio(ttsUrl);
    currentTtsAudio = audio;
    audio.onplay = () => reactor && reactor.classList.add('speaking');
    audio.onended = () => reactor && reactor.classList.remove('speaking');
    audio.onerror = () => {
      reactor && reactor.classList.remove('speaking');
      fallbackBrowserSpeak(shortText);
    };
    await audio.play();
  } catch (e) {
    reactor && reactor.classList.remove('speaking');
    fallbackBrowserSpeak(text);
  }
}

function fallbackBrowserSpeak(text) {
  if (!('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'tr-TR';
    utter.rate = 1.05;
    utter.pitch = 0.9;
    window.speechSynthesis.speak(utter);
  } catch (e) {}
}

async function changeVoiceProfile(profileKey) {
  state.voiceProfile = profileKey;
  const qv = document.getElementById('quickVoiceSelect');
  const cv = document.getElementById('cfgVoiceProfile');
  if (qv) qv.value = profileKey;
  if (cv) cv.value = profileKey;
  const res = await doAction('set_voice', { profile: profileKey });
  if (res && res.ok) {
    speakJarvis(`Ses tonum güncellendi ${state.userName}. Sistemler emrinizde.`, profileKey);
  }
}

function testCurrentVoice() {
  const profile = state.voiceProfile || 'jarvis-ahmet';
  state.voiceEnabled = true;
  document.getElementById('btnToggleVoice').textContent = '🔊';
  speakJarvis(`Merhaba ${state.userName}, ben J.A.R.V.I.S. Tüm sistemler çevrimiçi ve emrinize hazır.`, profile);
}

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;

if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.lang = 'tr-TR';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    state.isListening = true;
    document.getElementById('arcReactorBtn').classList.add('listening');
    document.getElementById('reactorLabel').textContent = 'DİNLİYOR...';
    document.getElementById('voiceStatusText').textContent = 'Sizi dinliyorum efendim, komutunuzu söyleyin...';
    if (state.voicePrintEnabled && state.voicePrint && !state.isEnrollingVoice) {
      startVoiceAnalyser();
    }
    // Not: analyser anında hazır olmayabilir; kilit açıkken hazır değilse vpGate() reddeder.
  };

  // "Hey Jarvis" uyandırma kelimesi (Türkçe tanıma motoru çeşitli yazımlar üretebilir: jarvis, carvis, çarvis, jarviz...)
  const WAKE_RE = /(?:\b(?:hey|hay|hei|hej|ey|hi)\s+)?\b[hcj]a+r+v+[iu]*[sz]*\b/;
  const WAKE_WINDOW_MS = 10000;

  function normalizeTr(s) {
    return String(s).toLocaleLowerCase('tr-TR')
      .replace(/ç/g, 'c').replace(/ş/g, 's').replace(/ı/g, 'i').replace(/ğ/g, 'g')
      .replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/i̇/g, 'i');
  }

  // Wake kelimesini bulur; { found, rest } döner (rest = kelimeden sonra söylenen komut)
  function parseWake(transcript) {
    const norm = normalizeTr(transcript);
    const m = WAKE_RE.exec(norm);
    if (!m) return { found: false, rest: '' };
    const rest = transcript.slice(m.index + m[0].length).replace(/^[\s,.:;!?-]+/, '').trim();
    return { found: true, rest };
  }

  function isJarvisSpeaking() {
    const a = currentTtsAudio;
    const audioPlaying = a && !a.paused && !a.ended;
    const synthPlaying = 'speechSynthesis' in window && window.speechSynthesis.speaking;
    return Boolean(audioPlaying || synthPlaying);
  }

  function setWakeStatus(text) {
    const el = document.getElementById('voiceStatusText');
    if (el) el.textContent = text;
  }

  function runVoiceCommand(transcript) {
    const gate = vpGate();
    if (!gate.allowed) {
      setWakeStatus(gate.message);
      playHudSound('error');
      showToast(gate.message);
      return;
    }
    setWakeStatus(gate.message ? `Algılandı: "${transcript}" — ${gate.message}` : `Algılandı: "${transcript}"`);
    sendJarvisCommand(transcript);
  }

  recognition.onresult = (event) => {
    const last = event.results[event.results.length - 1];
    const transcript = last[0].transcript.trim();
    if (!transcript) return;

    // Sürekli dinleme modu: "Hey Jarvis" olmadan komut çalıştırma
    if (state.wakeWordMode) {
      if (isJarvisSpeaking()) { vpFrames = []; return; } // kendi sesimizi duymayalım

      const wake = parseWake(transcript);
      if (wake.found) {
        if (wake.rest.length > 1) {
          state.wakeActiveUntil = 0;
          runVoiceCommand(wake.rest);
        } else {
          // Sadece "Hey Jarvis" dendi -> sonraki cümleyi bekle
          const gate = vpGate();
          if (!gate.allowed) {
            setWakeStatus(gate.message);
            playHudSound('error');
            return;
          }
          state.wakeActiveUntil = Date.now() + WAKE_WINDOW_MS;
          playHudSound('listen');
          setWakeStatus('👂 Dinliyorum efendim, komutunuzu söyleyin...');
        }
        return;
      }

      if (Date.now() < (state.wakeActiveUntil || 0)) {
        state.wakeActiveUntil = 0;
        runVoiceCommand(transcript);
        return;
      }

      vpFrames = [];
      setWakeStatus('Uyandırma kelimesi bekleniyor — "Hey Jarvis" deyin.');
      return;
    }

    runVoiceCommand(transcript);
  };

  recognition.onerror = (event) => {
    state.isListening = false;
    document.getElementById('arcReactorBtn').classList.remove('listening');
    document.getElementById('reactorLabel').textContent = 'DOKUN & KONUŞ';
    if (event && (event.error === 'not-allowed' || event.error === 'service-not-allowed')) {
      state.wakeWordMode = false;
      const btn = document.getElementById('btnWakeWord');
      if (btn) {
        btn.textContent = '👂 "Hey Jarvis": Kapalı';
        btn.classList.remove('primary');
      }
      showToast('Mikrofon izni verilmedi — "Hey Jarvis" dinleme kapatıldı.');
    }
    if (!state.wakeWordMode) stopVoiceAnalyser(false);
  };

  recognition.onend = () => {
    state.isListening = false;
    document.getElementById('arcReactorBtn').classList.remove('listening');
    document.getElementById('reactorLabel').textContent = state.wakeWordMode ? 'HEY JARVIS DİYİN' : 'DOKUN & KONUŞ';
    if (state.wakeWordMode) {
      vpFrames = [];
      setTimeout(() => {
        if (state.wakeWordMode) {
          try { recognition.start(); } catch (e) {}
        }
      }, 150);
    } else {
      stopVoiceAnalyser(false);
    }
  };
}

function toggleListening() {
  if (!recognition) {
    showToast('Tarayıcınız ses tanımayı desteklemiyor (Chrome veya Edge önerilir).');
    return;
  }
  playHudSound('listen');
  if (state.wakeWordMode && state.isListening) {
    // "Hey Jarvis" modunda butona basmak = uyandırma kelimesi söylemiş gibi komut penceresini aç
    state.wakeActiveUntil = Date.now() + 10000;
    document.getElementById('voiceStatusText').textContent = '👂 Dinliyorum efendim, komutunuzu söyleyin...';
  } else if (state.isListening) {
    recognition.stop();
  } else {
    try {
      recognition.start();
    } catch (e) {}
  }
}

document.getElementById('arcReactorBtn').addEventListener('click', toggleListening);
document.getElementById('btnMicTrigger').addEventListener('click', toggleListening);

document.getElementById('btnWakeWord').addEventListener('click', () => {
  state.wakeWordMode = !state.wakeWordMode;
  const btn = document.getElementById('btnWakeWord');
  btn.textContent = state.wakeWordMode ? '👂 "Hey Jarvis": AÇIK' : '👂 "Hey Jarvis": Kapalı';
  btn.classList.toggle('primary', state.wakeWordMode);
  state.wakeActiveUntil = 0;
  if (state.wakeWordMode) {
    document.getElementById('voiceStatusText').textContent = 'Uyandırma kelimesi bekleniyor — "Hey Jarvis" deyin.';
  }
  if (state.wakeWordMode && recognition && !state.isListening) {
    try { recognition.start(); } catch (e) {}
  } else if (!state.wakeWordMode && recognition && state.isListening) {
    recognition.stop();
  }
});

// ============================================================================
// CHAT & NATURAL LANGUAGE COMMANDS
// ============================================================================
function appendChatBubble(role, text, actionResult = null, scroll = true) {
  const stream = document.getElementById('chatStream');
  const div = document.createElement('div');
  div.className = `msg-bubble ${role === 'user' ? 'user' : 'jarvis'}`;

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.textContent = role === 'user' ? `SİZ (${state.userName.toUpperCase()})` : 'J.A.R.V.I.S.';
  div.appendChild(meta);

  const body = document.createElement('div');
  body.textContent = text;
  div.appendChild(body);

  if (actionResult && actionResult.type === 'briefing' && actionResult.briefing) {
    const b = actionResult.briefing;
    const tbl = document.createElement('table');
    tbl.style.cssText = 'width:100%;margin-top:10px;border-collapse:collapse;font-size:12px;background:rgba(2,14,32,0.75);border:1px solid rgba(0,240,255,0.28);border-radius:8px;overflow:hidden;';

    const addRow = (label, valHtml, isHeader = false) => {
      const tr = document.createElement('tr');
      tr.style.borderBottom = '1px solid rgba(0,240,255,0.14)';
      const td1 = document.createElement(isHeader ? 'th' : 'td');
      td1.style.cssText = 'padding:7px 10px;text-align:left;color:#00f0ff;font-weight:600;width:32%;vertical-align:top;background:rgba(0,240,255,0.06);';
      td1.textContent = label;
      const td2 = document.createElement(isHeader ? 'th' : 'td');
      td2.style.cssText = 'padding:7px 10px;text-align:left;color:#e2f1ff;';
      td2.innerHTML = valHtml;
      tr.appendChild(td1);
      tr.appendChild(td2);
      tbl.appendChild(tr);
    };

    const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    addRow('📅 Tarih', esc(b.date), true);
    addRow('🌤️ Hava Durumu', esc(b.weather));
    addRow('💱 Döviz Kuru', `<strong>USD:</strong> ${esc(b.usd)} &nbsp;|&nbsp; <strong>EUR:</strong> ${esc(b.eur)}`);
    if (Array.isArray(b.news) && b.news.length) {
      const itemsHtml = b.news.map((n) => `<div style="margin-bottom:4px;"><span style="color:#f59e0b;font-weight:600;">[${esc(n.source)}]</span> ${esc(n.title)}</div>`).join('');
      addRow('🌍 Haberler', itemsHtml);
    }
    div.appendChild(tbl);
  }

  if (actionResult && actionResult.type === 'screenshot' && actionResult.screenshot?.image) {
    const img = document.createElement('img');
    img.src = actionResult.screenshot.image;
    img.className = 'msg-shot-img';
    img.title = 'Canlı Ekran sekmesine gitmek için dokunun';
    img.onclick = () => {
      document.getElementById('liveScreenImg').src = actionResult.screenshot.image;
      document.getElementById('liveScreenImg').style.display = 'block';
      document.getElementById('screenPlaceholder').style.display = 'none';
      document.querySelector('.nav-btn[data-tab="tab-screen"]').click();
    };
    div.appendChild(img);
  }

  stream.appendChild(div);
  if (scroll) stream.scrollTop = stream.scrollHeight;
}

async function sendJarvisCommand(text) {
  const clean = String(text || '').trim();
  if (!clean) return;
  playHudSound('click');
  appendChatBubble('user', clean);

  try {
    const res = await apiFetch('/api/command', {
      method: 'POST',
      body: JSON.stringify({ text: clean })
    });
    playHudSound('ack');
    if (res.actionResult?.type === 'chat_cleared') {
      const stream = document.getElementById('chatStream');
      if (stream) stream.innerHTML = '';
      showToast('🗑️ Eski konuşmalar silindi.');
    }
    if (res.actionResult?.type === 'voice_changed' && res.actionResult.voiceProfile) {
      state.voiceProfile = res.actionResult.voiceProfile;
      const qv = document.getElementById('quickVoiceSelect');
      const cv = document.getElementById('cfgVoiceProfile');
      if (qv) qv.value = state.voiceProfile;
      if (cv) cv.value = state.voiceProfile;
    }
    appendChatBubble('jarvis', res.reply || 'Emredersiniz.', res.actionResult);
    speakJarvis(res.reply || 'Emredersiniz.');

    if (res.actionResult?.type === 'note_added' || res.actionResult?.type === 'notes') {
      const info = await apiFetch('/api/info');
      if (info.notes) renderNotes(info.notes);
    }
  } catch (e) {
    appendChatBubble('jarvis', 'Sunucu ile bağlantı kurulamadı.');
  }
}

document.getElementById('commandForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const inp = document.getElementById('commandInput');
  const val = inp.value;
  inp.value = '';
  sendJarvisCommand(val);
});

document.querySelectorAll('.quick-chips .chip[data-cmd]').forEach((chip) => {
  chip.addEventListener('click', () => {
    sendJarvisCommand(chip.getAttribute('data-cmd'));
  });
});

// ============================================================================
// DIRECT PC REMOTE ACTIONS (TAB 2)
// ============================================================================
async function doAction(action, params = {}) {
  playHudSound('click');
  try {
    const res = await apiFetch('/api/action', {
      method: 'POST',
      body: JSON.stringify({ action, params })
    });
    if (res.message) showToast(res.message);
    if (res.volume !== undefined) {
      document.getElementById('volSlider').value = res.volume;
      document.getElementById('volLabelBig').textContent = `${res.volume}%`;
      document.getElementById('hdrVol').textContent = `${res.volume}%`;
    }
    if (res.brightness !== undefined) {
      const bs = document.getElementById('brightSlider');
      const bl = document.getElementById('brightLabelBig');
      if (bs) bs.value = res.brightness;
      if (bl) bl.textContent = `${res.brightness}%`;
    }
    return res;
  } catch (e) {
    showToast('Komut gönderilemedi.');
  }
}

document.getElementById('volSlider').addEventListener('change', (e) => {
  doAction('set_volume', { level: Number(e.target.value) });
});

const brightSliderEl = document.getElementById('brightSlider');
if (brightSliderEl) {
  brightSliderEl.addEventListener('change', (e) => {
    doAction('set_brightness', { level: Number(e.target.value) });
  });
}

function speakOnPC() {
  const inp = document.getElementById('pcSpeakInput');
  if (!inp.value.trim()) return;
  doAction('speak_on_pc', { text: inp.value.trim() });
  inp.value = '';
}

function copyToPCClipboard() {
  const inp = document.getElementById('pcSpeakInput');
  if (!inp.value.trim()) {
    showToast('Kopyalanacak metni kutuya yazın.');
    return;
  }
  doAction('clipboard_set', { text: inp.value.trim() });
}

async function readPCClipboard() {
  const res = await doAction('clipboard_get', {});
  if (res && res.text) {
    const inp = document.getElementById('pcSpeakInput');
    if (inp) inp.value = res.text;
    showToast('PC Panosu: ' + res.text.slice(0, 60));
  }
}

async function captureWebcamToScreen() {
  showToast('📷 Webcam görüntüsü alınıyor...');
  const res = await doAction('capture_webcam', { quality: 80 });
  if (res && res.screenshot && res.screenshot.image) {
    const img = document.getElementById('liveScreenImg');
    const ph = document.getElementById('screenPlaceholder');
    img.src = res.screenshot.image;
    img.style.display = 'block';
    ph.style.display = 'none';
    document.querySelector('.nav-btn[data-tab="tab-screen"]').click();
  }
}

function quickSearch(engine) {
  const inp = document.getElementById('quickSearchInput');
  const q = inp.value.trim();
  if (!q) return;
  if (q.startsWith('http://') || q.startsWith('https://') || q.includes('.com') || q.includes('.tr')) {
    doAction('open_url', { url: q });
  } else if (engine === 'youtube') {
    doAction('search_youtube', { query: q });
  } else {
    doAction('search_google', { query: q });
  }
  inp.value = '';
}

function confirmShutdown() {
  if (confirm('Bilgisayar 60 saniye içinde kapatılacak. Onaylıyor musunuz?')) {
    doAction('system_control', { command: 'shutdown', seconds: 60 });
  }
}

async function loadProcesses() {
  const container = document.getElementById('processList');
  container.innerHTML = '<div class="empty-hint">İşlemler taranıyor...</div>';
  try {
    const res = await apiFetch('/api/processes');
    const list = res.processes || [];
    if (list.length === 0) {
      container.innerHTML = '<div class="empty-hint">Açık işlem bulunamadı.</div>';
      return;
    }
    container.innerHTML = '';
    list.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'proc-row';
      const title = p.MainWindowTitle ? `${p.ProcessName} — ${p.MainWindowTitle}` : p.ProcessName;
      row.innerHTML = `
        <div style="min-width:0;flex:1;padding-right:8px;">
          <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${title}</div>
          <div style="font-size:0.72rem;color:#7dd3fc;">PID: ${p.Id} • RAM: ${p.MemoryMB} MB</div>
        </div>
        <button class="hud-btn small danger" onclick="killProcess(${p.Id}, '${p.ProcessName.replace(/'/g, '')}')">Kapat</button>
      `;
      container.appendChild(row);
    });
  } catch (e) {
    container.innerHTML = '<div class="empty-hint">İşlem listesi alınamadı.</div>';
  }
}

async function killProcess(pid, name) {
  if (!confirm(`"${name}" (PID: ${pid}) uygulamasını sonlandırmak istiyor musunuz?`)) return;
  const res = await apiFetch('/api/processes/kill', {
    method: 'POST',
    body: JSON.stringify({ pid })
  });
  showToast(res.message || 'İşlem sonlandırıldı.');
  loadProcesses();
}

// ============================================================================
// LIVE SCREEN & TOUCHPAD CONTROL (TAB 3)
// ============================================================================
async function refreshScreen() {
  try {
    const data = await apiFetch('/api/screen?scale=0.65&quality=65');
    if (data && data.image) {
      const img = document.getElementById('liveScreenImg');
      img.src = data.image;
      img.style.display = 'block';
      document.getElementById('screenPlaceholder').style.display = 'none';
    }
  } catch (e) {}
}

function toggleLiveStream() {
  const btn = document.getElementById('btnLiveStream');
  if (state.liveStreamTimer) {
    clearInterval(state.liveStreamTimer);
    state.liveStreamTimer = null;
    btn.textContent = '▶️ Canlı Akış: Kapalı';
    btn.classList.remove('primary');
  } else {
    refreshScreen();
    state.liveStreamTimer = setInterval(refreshScreen, 950);
    btn.textContent = '⏸️ Canlı Akış: AÇIK';
    btn.classList.add('primary');
  }
}

document.getElementById('liveScreenImg').addEventListener('click', async (e) => {
  const mode = document.getElementById('clickModeSelect').value;
  if (mode === 'none') return;

  const rect = e.target.getBoundingClientRect();
  const xNorm = (e.clientX - rect.left) / rect.width;
  const yNorm = (e.clientY - rect.top) / rect.height;

  // Visual ripple feedback
  const ripple = document.getElementById('clickRipple');
  const vpRect = document.getElementById('screenViewport').getBoundingClientRect();
  ripple.style.left = `${e.clientX - vpRect.left}px`;
  ripple.style.top = `${e.clientY - vpRect.top}px`;
  ripple.classList.remove('animate');
  void ripple.offsetWidth;
  ripple.classList.add('animate');

  await doAction('mouse_click', { x: xNorm, y: yNorm, button: mode });
  setTimeout(refreshScreen, 260);
});

async function sendRemoteText(enter) {
  const inp = document.getElementById('remoteTypeInput');
  if (!inp.value) return;
  await doAction('type_text', { text: inp.value, enter });
  inp.value = '';
  setTimeout(refreshScreen, 300);
}

// ============================================================================
// FILE EXPLORER & TRANSFER (TAB 4)
// ============================================================================
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

async function browseDir(dirPath) {
  try {
    const res = await apiFetch(`/api/files/list?path=${encodeURIComponent(dirPath || '')}`);
    state.currentDir = res.currentPath;
    state.parentDir = res.parentPath;
    document.getElementById('currentPathLabel').textContent = res.currentPath;

    const container = document.getElementById('fileListContainer');
    container.innerHTML = '';

    if (!res.items || res.items.length === 0) {
      container.innerHTML = '<div class="empty-hint">Bu klasör boş.</div>';
      return;
    }

    res.items.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'file-row';

      const info = document.createElement('div');
      info.className = 'file-info';
      info.innerHTML = `
        <span style="font-size:1.2rem;">${item.isDir ? '📁' : '📄'}</span>
        <div style="min-width:0;">
          <div class="file-name">${item.name}</div>
          <div class="file-size">${item.isDir ? 'Klasör' : formatBytes(item.size)}</div>
        </div>
      `;
      info.onclick = () => {
        if (item.isDir) browseDir(item.path);
        else openFileOnPC(item.path);
      };

      const actions = document.createElement('div');
      actions.className = 'file-actions';

      if (!item.isDir) {
        const dlBtn = document.createElement('a');
        dlBtn.className = 'hud-btn small primary';
        dlBtn.style.textDecoration = 'none';
        dlBtn.href = `/api/files/download?path=${encodeURIComponent(item.path)}&pin=${encodeURIComponent(state.pinCode)}`;
        dlBtn.textContent = '⬇️ İndir';
        actions.appendChild(dlBtn);
      }

      const openBtn = document.createElement('button');
      openBtn.className = 'hud-btn small';
      openBtn.textContent = '🖥️ PC\'de Aç';
      openBtn.onclick = () => openFileOnPC(item.path);
      actions.appendChild(openBtn);

      row.appendChild(info);
      row.appendChild(actions);
      container.appendChild(row);
    });
  } catch (e) {
    showToast('Klasör okunamadı.');
  }
}

function browseShortcut(key) {
  if (state.shortcuts[key]) browseDir(state.shortcuts[key]);
}

function browseParent() {
  if (state.parentDir) browseDir(state.parentDir);
}

async function openFileOnPC(filePath) {
  playHudSound('click');
  const res = await apiFetch('/api/files/open', {
    method: 'POST',
    body: JSON.stringify({ path: filePath })
  });
  showToast(res.message || 'Bilgisayarda açıldı.');
}

function uploadFileToPC(inputEl) {
  const file = inputEl.files[0];
  if (!file) return;
  showToast(`"${file.name}" bilgisayara yükleniyor...`);
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const res = await apiFetch('/api/files/upload', {
        method: 'POST',
        body: JSON.stringify({
          fileName: file.name,
          targetDir: state.currentDir,
          data: reader.result
        })
      });
      showToast(res.message || 'Dosya yüklendi!');
      browseDir(state.currentDir);
    } catch (e) {
      showToast('Dosya yükleme başarısız.');
    }
  };
  reader.readAsDataURL(file);
}

// ============================================================================
// REMOTE POWERSHELL TERMINAL (TAB 5)
// ============================================================================
async function execTerminalCommand(cmd) {
  if (!cmd) return;
  playHudSound('click');
  const out = document.getElementById('terminalOutput');
  out.textContent += `\n\nPS> ${cmd}\nÇalıştırılıyor...`;
  out.scrollTop = out.scrollHeight;

  try {
    const res = await apiFetch('/api/terminal/exec', {
      method: 'POST',
      body: JSON.stringify({ command: cmd })
    });
    document.getElementById('termCwdLabel').textContent = `PS ${res.cwd}>`;
    out.textContent += `\n${res.output}`;
    out.scrollTop = out.scrollHeight;
  } catch (e) {
    out.textContent += `\nHata: Komut çalıştırılamadı.`;
  }
}

document.getElementById('terminalForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const inp = document.getElementById('terminalInput');
  const cmd = inp.value.trim();
  inp.value = '';
  execTerminalCommand(cmd);
});

function runQuickTerm(cmd) {
  execTerminalCommand(cmd);
}

function clearTerm() {
  document.getElementById('terminalOutput').textContent = 'Terminal temizlendi.';
}

// ============================================================================
// NOTES, QR CODE & SETTINGS (TAB 6)
// ============================================================================
function renderQRCode(url) {
  const box = document.getElementById('qrContainer');
  const encoded = encodeURIComponent(url);
  box.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encoded}" alt="QR Code" width="150" height="150" onerror="this.outerHTML='<div style=\\'color:#000;padding:12px;font-weight:bold;text-align:center;\\'>${url}</div>'" />`;
}

function renderNotes(notes) {
  const container = document.getElementById('notesListContainer');
  if (!container) return;
  container.innerHTML = '';
  if (!notes || notes.length === 0) {
    container.innerHTML = '<div class="empty-hint">Henüz not eklenmedi.</div>';
    return;
  }
  notes.forEach((n) => {
    const div = document.createElement('div');
    div.className = `note-item ${n.done ? 'done' : ''}`;
    div.innerHTML = `
      <span style="flex:1;cursor:pointer;" onclick="toggleNote('${n.id}')">${n.done ? '✅' : '⬜'} ${n.text}</span>
      <button class="hud-btn small danger" onclick="deleteNote('${n.id}')">Sil</button>
    `;
    container.appendChild(div);
  });
}

async function addNoteUI() {
  const inp = document.getElementById('newNoteInput');
  if (!inp.value.trim()) return;
  const res = await apiFetch('/api/notes', {
    method: 'POST',
    body: JSON.stringify({ action: 'add', text: inp.value.trim() })
  });
  inp.value = '';
  renderNotes(res.notes);
}

async function toggleNote(id) {
  const res = await apiFetch('/api/notes', {
    method: 'POST',
    body: JSON.stringify({ action: 'toggle', id })
  });
  renderNotes(res.notes);
}

async function deleteNote(id) {
  const res = await apiFetch('/api/notes', {
    method: 'POST',
    body: JSON.stringify({ action: 'delete', id })
  });
  renderNotes(res.notes);
}

async function saveSettingsUI() {
  const userName = document.getElementById('cfgUserName').value.trim() || 'Efendim';
  const geminiKey = document.getElementById('cfgGeminiKey').value.trim();
  const telegramToken = document.getElementById('cfgTelegramToken').value.trim();
  const gmailAddress = (document.getElementById('cfgGmailAddress')?.value || '').trim();
  const gmailAppPassword = (document.getElementById('cfgGmailAppPassword')?.value || '').trim();
  const smsWebhookUrl = (document.getElementById('cfgSmsWebhookUrl')?.value || '').trim();
  const smsContactsText = document.getElementById('cfgSmsContacts')?.value;
  const weatherCity = document.getElementById('cfgWeatherCity')?.value;
  const pinCode = document.getElementById('cfgPinCode').value.trim();

  const payload = { userName };
  if (geminiKey) payload.geminiApiKey = geminiKey;
  if (telegramToken) payload.telegramBotToken = telegramToken;
  if (gmailAddress) payload.gmailAddress = gmailAddress;
  if (gmailAppPassword) payload.gmailAppPassword = gmailAppPassword;
  if (document.getElementById('cfgSmsWebhookUrl')) payload.smsWebhookUrl = smsWebhookUrl;
  if (smsContactsText !== undefined) payload.smsContactsText = smsContactsText;
  if (weatherCity !== undefined) payload.weatherCity = weatherCity.trim();
  if (pinCode !== '') {
    payload.pinCode = pinCode;
    state.pinCode = pinCode;
    localStorage.setItem('jarvis_pin', pinCode);
  }

  const res = await apiFetch('/api/settings', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  state.userName = userName;
  showToast(res.message || 'Ayarlar kaydedildi.');
}

async function testGmailUI() {
  const statusEl = document.getElementById('gmailTestStatus');
  if (statusEl) {
    statusEl.style.color = '#00f0ff';
    statusEl.textContent = 'Gmail bağlantısı test ediliyor...';
  }
  await saveSettingsUI();
  try {
    const res = await apiFetch('/api/mail/test', { method: 'POST', body: '{}' });
    if (statusEl) {
      statusEl.style.color = res.ok ? '#10b981' : '#f59e0b';
      statusEl.textContent = res.message || (res.ok ? 'Bağlantı başarılı!' : 'Bağlantı başarısız.');
    }
    showToast(res.message || 'Test tamamlandı.');
  } catch (e) {
    if (statusEl) {
      statusEl.style.color = '#ef4444';
      statusEl.textContent = `Hata: ${e.message}`;
    }
  }
}

window.addEventListener('DOMContentLoaded', initJarvis);
