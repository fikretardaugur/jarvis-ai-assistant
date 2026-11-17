// ============================================================================
// J.A.R.V.I.S. — EK ÖZELLİKLER MODÜLÜ (extras.js)
//  1) Telegram Sesli Mesaj -> Gemini ile metne çevirme ve komut çalıştırma
//  2) Panik Modu & Zamanlı Kapatma / İptal
//  3) Günlük Brifing (Hava durumu + Döviz + Sistem + Okunmamış Mail)
//  4) Açık Program / Pencere Yönetimi (listele, öne getir, kapat)
//  5) Windows Açılışında Otomatik Başlama (Registry HKCU Run)
// ============================================================================
const path = require('path');
const { exec } = require('child_process');

module.exports = function createExtrasModule(ctx) {
  const { psBridge, ROOT_DIR } = ctx;
  const REG_PATH = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  const REG_NAME = 'JARVIS_Mark_VII';
  const STARTUP_VBS = path.join(ROOT_DIR, 'ArkaPlanda-Baslat.vbs');

  const trLower = (s) => String(s || '').toLocaleLowerCase('tr-TR');
  const normAscii = (s) => trLower(s).replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u');

  // Türkiye'nin 30 Büyükşehir Belediyesi
  const TR_CITIES = [
    'Adana', 'Ankara', 'Antalya', 'Aydın', 'Balıkesir', 'Bursa', 'Denizli', 'Diyarbakır',
    'Erzurum', 'Eskişehir', 'Gaziantep', 'Hatay', 'İstanbul', 'İzmir', 'Kahramanmaraş',
    'Kayseri', 'Kocaeli', 'Konya', 'Malatya', 'Manisa', 'Mardin', 'Mersin', 'Muğla',
    'Ordu', 'Sakarya', 'Samsun', 'Şanlıurfa', 'Tekirdağ', 'Trabzon', 'Van'
  ];

  function detectCityInText(text) {
    const t = normAscii(text);
    for (const city of TR_CITIES) {
      const c = normAscii(city);
      const re = new RegExp(`(^|[^a-z0-9])${c}(?:'?[a-z]{0,4})?($|[^a-z0-9])`);
      if (re.test(t)) return city;
    }
    return '';
  }

  // ==========================================================================
  // 1) TELEGRAM SESLİ MESAJ ÇÖZÜMLEME (GEMINI MULTIMODAL AUDIO)
  // ==========================================================================
  async function transcribeTelegramVoice(fileId) {
    const cfg = ctx.getConfig();
    if (!cfg.telegramBotToken || !cfg.geminiApiKey) {
      return { ok: false, error: 'Sesli mesaj için Gemini API anahtarı gerekli.' };
    }
    try {
      const gf = await (await fetch(
        `https://api.telegram.org/bot${cfg.telegramBotToken}/getFile?file_id=${fileId}`,
        { signal: AbortSignal.timeout(15000) }
      )).json();
      if (!gf.ok) return { ok: false, error: gf.description || 'Ses dosyası alınamadı.' };

      const resp = await fetch(
        `https://api.telegram.org/file/bot${cfg.telegramBotToken}/${gf.result.file_path}`,
        { signal: AbortSignal.timeout(25000) }
      );
      const buf = Buffer.from(await resp.arrayBuffer());
      const b64 = buf.toString('base64');

      const models = ['gemini-3.5-flash-lite', 'gemini-3.5-flash'];
      for (const m of models) {
        try {
          const gResp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${cfg.geminiApiKey}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              signal: AbortSignal.timeout(20000),
              body: JSON.stringify({
                contents: [{
                  role: 'user',
                  parts: [
                    { text: 'Bu ses kaydındaki Türkçe konuşmayı sadece düz metin olarak yazıya dök. Ek açıklama yapma, sadece söylenen cümleyi yaz.' },
                    { inline_data: { mime_type: 'audio/ogg', data: b64 } }
                  ]
                }],
                generationConfig: { temperature: 0.1, maxOutputTokens: 200 }
              })
            }
          );
          if (!gResp.ok) continue;
          const data = await gResp.json();
          const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
          if (text) return { ok: true, text };
        } catch (e) {}
      }
      return { ok: false, error: 'Ses kaydı yazıya çevrilemedi.' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ==========================================================================
  // 2) PANİK MODU & ZAMANLI KAPATMA
  // ==========================================================================
  async function panicMode() {
    await psBridge.run(`
      try { (New-Object -ComObject Shell.Application).MinimizeAll() } catch {}
      try { [JarvisAudio]::SetMute($true) } catch {}
      try { [JarvisWin32]::LockWorkStation() } catch {}
      @{ ok = $true }
    `, 6000);
    psBridge.lastTelemetry.muted = true;
    return { ok: true, message: '🚨 Panik Modu uygulandı: Tüm pencereler gizlendi, ses kapatıldı ve ekran kilitlendi.' };
  }

  function scheduleShutdown(minutes = 0) {
    const mins = Math.max(0, Math.round(Number(minutes) || 0));
    const secs = mins * 60;
    return new Promise((resolve) => {
      exec(`shutdown /s /t ${secs}`, (err) => {
        if (err) return resolve({ ok: false, message: `Kapatma zamanlanamadı: ${err.message}` });
        resolve({
          ok: true,
          message: mins > 0
            ? `⏳ Bilgisayar ${mins} dakika sonra kapanacak. İptal etmek için "kapatmayı iptal et" deyin.`
            : 'Bilgisayar kapatılıyor...'
        });
      });
    });
  }

  function cancelShutdown() {
    return new Promise((resolve) => {
      exec('shutdown /a', (err) => {
        if (err) return resolve({ ok: false, message: 'Aktif bir kapatma zamanlayıcısı yok.' });
        resolve({ ok: true, message: '✅ Zamanlanmış bilgisayar kapatma iptal edildi.' });
      });
    });
  }

  // ==========================================================================
  // 3) GÜNLÜK BRİFİNG (Hava + Döviz + Sistem + Mail)
  // ==========================================================================
  async function fetchWeather(cityOverride = '') {
    try {
      const cfg = ctx.getConfig();
      const target = String(cityOverride || '').trim();
      const loc = target
        ? encodeURIComponent(target)
        : (cfg.weatherCity
          ? encodeURIComponent(cfg.weatherCity.trim())
          : (cfg.geoCoords ? encodeURIComponent(cfg.geoCoords.trim()) : ''));
      const url = `https://wttr.in/${loc}?format=%l:+%c+%t+(%C)&lang=tr`;
      const r = await fetch(url, {
        headers: { 'User-Agent': 'curl/8.0' },
        signal: AbortSignal.timeout(4500)
      });
      if (!r.ok) return null;
      const txt = (await r.text()).trim();
      return txt && !txt.includes('<') ? txt : null;
    } catch (e) { return null; }
  }

  async function fetchRates() {
    try {
      const [uRes, eRes] = await Promise.all([
        fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(4500) }),
        fetch('https://open.er-api.com/v6/latest/EUR', { signal: AbortSignal.timeout(4500) })
      ]);
      const u = uRes.ok ? await uRes.json() : null;
      const e = eRes.ok ? await eRes.json() : null;
      const usd = u?.rates?.TRY ? u.rates.TRY.toFixed(2) : null;
      const eur = e?.rates?.TRY ? e.rates.TRY.toFixed(2) : null;
      return (usd || eur) ? { usd, eur } : null;
    } catch (e) { return null; }
  }

  function decodeXmlEntities(s) {
    return String(s || '')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async function fetchNews() {
    const urls = [
      { url: 'https://news.google.com/rss?hl=tr&gl=TR&ceid=TR:tr', tag: 'Son Dakika' },
      { url: 'https://feeds.bbci.co.uk/turkce/rss.xml', tag: 'Dünya' }
    ];
    const results = [];
    await Promise.all(urls.map(async (src) => {
      try {
        const r = await fetch(src.url, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(4500)
        });
        if (!r.ok) return;
        const xml = await r.text();
        const matches = [...xml.matchAll(/<item>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/g)];
        for (const m of matches.slice(0, 3)) {
          const title = decodeXmlEntities(m[1]);
          if (title) results.push({ source: src.tag, title });
        }
      } catch (e) {}
    }));
    return results.slice(0, 5);
  }

  function getTimeGreeting() {
    const h = new Date().getHours();
    if (h >= 5 && h < 12) return 'Günaydın';
    if (h >= 12 && h < 18) return 'İyi günler';
    if (h >= 18 && h < 23) return 'İyi akşamlar';
    return 'İyi geceler';
  }

  async function formatBriefingWithJarvis(rawLines) {
    const cfg = ctx.getConfig();
    if (!cfg.geminiApiKey) return null;
    const models = ['gemini-3.5-flash-lite', 'gemini-3.5-flash'];
    const greeting = getTimeGreeting();
    const prompt = `Sen Tony Stark'ın yapay zeka asistanı J.A.R.V.I.S.'sin. Kullanıcıya "${cfg.userName}" diye hitap et ve saate uygun olarak "${greeting}" ile başla.
Aşağıdaki anlık verileri kullanarak kullanıcıya samimi, zeki, karizmatik ve sesli okumaya uygun (emoji, yıldız, madde işareti veya markdown kullanmadan) akıcı 3-4 Türkçe cümleyle günlük rapor / brifing sunumu yap:

${rawLines.join('\n')}`;

    for (const m of models) {
      try {
        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${cfg.geminiApiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(12000),
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.55, maxOutputTokens: 350 }
            })
          }
        );
        if (!resp.ok) continue;
        const data = await resp.json();
        const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
        if (text) return text;
      } catch (e) {}
    }
    return null;
  }

  async function dailyBriefing() {
    const cfg = ctx.getConfig();
    const nowStr = new Date().toLocaleString('tr-TR', { weekday: 'long', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' });
    const [weather, rates, news] = await Promise.all([
      fetchWeather(),
      fetchRates(),
      fetchNews()
    ]);

    const cleanWeather = weather ? weather.replace(/[^\p{L}\p{N}\s.,:°+\-()]/gu, '').replace(/\s+/g, ' ').trim() : '';
    const rawLines = [`Tarih: ${nowStr}`];
    if (cleanWeather) rawLines.push(`Hava Durumu: ${cleanWeather}`);
    if (rates) {
      const parts = [];
      if (rates.usd) parts.push(`Dolar ${rates.usd} TL`);
      if (rates.eur) parts.push(`Euro ${rates.eur} TL`);
      rawLines.push(`Döviz kurları: ${parts.join(', ')}`);
    }
    if (news.length) {
      rawLines.push('Gündem ve dünya haberleri:\n' + news.map((n, i) => `${i + 1}. (${n.source}) ${n.title}`).join('\n'));
    }

    const jarvisText = await formatBriefingWithJarvis(rawLines);
    const newsFallback = news.length ? ` Gündemde öne çıkan başlıklar ise şöyle: ${news.slice(0, 3).map((n) => n.title).join('; ')}.` : '';
    const fallbackText = `${getTimeGreeting()} ${cfg.userName}. ${cleanWeather ? `Hava durumu ${cleanWeather}. ` : ''}${rates ? `Dolar ${rates.usd} TL, Euro ${rates.eur} TL seviyesinde.` : ''}${newsFallback}`;
    const speech = jarvisText || fallbackText;

    return {
      ok: true,
      type: 'briefing',
      briefing: {
        date: nowStr,
        weather: cleanWeather || 'Alınamadı',
        usd: rates?.usd ? `${rates.usd} ₺` : '—',
        eur: rates?.eur ? `${rates.eur} ₺` : '—',
        news
      },
      message: speech,
      display: speech
    };
  }

  // ==========================================================================
  // 4) AÇIK PROGRAM / PENCERE YÖNETİMİ
  // ==========================================================================
  async function listWindows() {
    const data = await psBridge.run(`
      $list = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } |
        Select-Object -First 12 @{n='name';e={$_.ProcessName}}, @{n='title';e={$_.MainWindowTitle}}, @{n='pid';e={$_.Id}}
      @{ windows = @($list) }
    `, 5000);
    const wins = Array.isArray(data?.windows) ? data.windows : [];
    if (!wins.length) return { ok: true, message: 'Şu an açık pencere bulunamadı.' };
    const display = wins.map((w, i) => `${i + 1}. ${w.name} — ${String(w.title).slice(0, 60)}`).join('\n');
    return { ok: true, message: `${wins.length} açık uygulama listelendi:`, display, windows: wins };
  }

  async function focusWindow(name) {
    const clean = String(name || '').replace(/[^a-zA-Z0-9çğıöşüÇĞİÖŞÜ _-]/g, '').trim();
    if (!clean) return { ok: false, message: 'Öne getirilecek uygulama adı belirtilmedi.' };
    const r = await psBridge.run(`
      $q = "${clean.toLowerCase()}"
      $p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName.ToLower() -like "*$q*" -or $_.MainWindowTitle.ToLower() -like "*$q*") } | Select-Object -First 1
      if ($p) {
        [JarvisWin32]::ForceForegroundHandle($p.MainWindowHandle)
        @{ ok = $true; title = $p.MainWindowTitle; name = $p.ProcessName }
      } else {
        @{ ok = $false }
      }
    `, 5000);
    if (!r?.ok) return { ok: false, message: `"${name}" adlı açık pencere bulunamadı.` };
    return { ok: true, message: `${r.name} ("${r.title}") öne getirildi.` };
  }

  async function closeApp(name) {
    const clean = String(name || '').replace(/[^a-zA-Z0-9çğıöşüÇĞİÖŞÜ _-]/g, '').trim();
    if (!clean) return { ok: false, message: 'Kapatılacak uygulama adı belirtilmedi.' };
    const r = await psBridge.run(`
      $q = "${clean.toLowerCase()}"
      $procs = Get-Process | Where-Object { $_.ProcessName.ToLower() -like "*$q*" -or ($_.MainWindowTitle -and $_.MainWindowTitle.ToLower() -like "*$q*") }
      $count = ($procs | Measure-Object).Count
      if ($count -gt 0) {
        $procs | ForEach-Object { try { $_.CloseMainWindow() | Out-Null } catch {} }
        Start-Sleep -Milliseconds 350
        $still = Get-Process | Where-Object { $_.ProcessName.ToLower() -like "*$q*" }
        $still | ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch {} }
      }
      @{ count = $count }
    `, 7000);
    if (!r?.count) return { ok: false, message: `"${name}" adında çalışan bir uygulama bulunamadı.` };
    return { ok: true, message: `"${name}" kapatıldı (${r.count} işlem).` };
  }

  // ==========================================================================
  // 5) WINDOWS AÇILIŞINDA OTOMATİK BAŞLAMA
  // ==========================================================================
  async function setAutostart(enable) {
    const cmd = enable
      ? `Set-ItemProperty -Path '${REG_PATH}' -Name '${REG_NAME}' -Value 'wscript.exe "${STARTUP_VBS}"'; @{ ok = $true; enabled = $true }`
      : `Remove-ItemProperty -Path '${REG_PATH}' -Name '${REG_NAME}' -ErrorAction SilentlyContinue; @{ ok = $true; enabled = $false }`;
    await psBridge.run(cmd, 5000);
    return {
      ok: true,
      enabled: Boolean(enable),
      message: enable
        ? '🚀 Windows açılışında otomatik başlatma AÇILDI. Bilgisayar her açıldığında JARVIS arka planda başlayacak.'
        : '🛑 Windows açılışında otomatik başlatma KAPATILDI.'
    };
  }

  async function getAutostartStatus() {
    const r = await psBridge.run(`
      $v = (Get-ItemProperty -Path '${REG_PATH}' -Name '${REG_NAME}' -ErrorAction SilentlyContinue).'${REG_NAME}'
      @{ enabled = [bool]$v }
    `, 4000);
    return { ok: true, enabled: Boolean(r?.enabled), message: r?.enabled ? 'Otomatik başlatma şu an AÇIK.' : 'Otomatik başlatma şu an KAPALI.' };
  }

  // ==========================================================================
  // EYLEM & HIZLI KOMUT YÖNLENDİRİCİ
  // ==========================================================================
  async function run(action, params = {}) {
    switch (action) {
      case 'panic_mode':
        return panicMode();
      case 'schedule_shutdown':
        return scheduleShutdown(params.minutes ?? 30);
      case 'cancel_shutdown':
        return cancelShutdown();
      case 'daily_briefing':
        return dailyBriefing();
      case 'list_windows':
        return listWindows();
      case 'focus_window':
        return focusWindow(params.name || params.app || '');
      case 'close_app':
        return closeApp(params.name || params.app || '');
      case 'set_autostart':
        return setAutostart(params.enable !== false);
      case 'autostart_status':
        return getAutostartStatus();
    }
    return undefined;
  }

  async function matchFast(lower) {
    if (/^(panik modu|acil durum|panik|her şeyi gizle ve kilitle)$/.test(lower)) {
      const r = await panicMode();
      return { reply: r.message, actionResult: r };
    }
    if (/^(günaydın|günaydın jarvis|iyi akşamlar|iyi günler|rapor ver|rapor|günlük rapor|durum raporu|haberler|haberleri ver|haberler neler|gündem|gündem ne|günlük brifing|brifing|brifing ver|günün özeti|sabah brifingi|akşam brifingi|günaydın brifingi)$/.test(lower)) {
      const r = await dailyBriefing();
      return { reply: r.display || r.message, actionResult: r };
    }
    if (/hava\s+(durumu|nasıl)/.test(lower) && !/(whats?ap+|watsap|\bwp\b|\bsms\b|gönder|at|yolla)/.test(lower)) {
      const city = detectCityInText(lower);
      const w = await fetchWeather(city);
      if (w) {
        const cleanW = w.replace(/[^\p{L}\p{N}\s.,:°+\-()]/gu, '').replace(/\s+/g, ' ').trim();
        return { reply: `${cleanW}`, actionResult: { ok: true } };
      }
    }
    let locMatch = lower.match(/^(?:konumumu|şehrimi|bulunduğum şehri|hava durumu şehrini)\s+(.+?)\s+(?:yap|olarak kaydet|olarak ayarla|ayarla)$/);
    if (locMatch) {
      const city = locMatch[1].trim();
      ctx.getConfig().weatherCity = city;
      if (typeof ctx.saveConfig === 'function') ctx.saveConfig();
      const w = await fetchWeather();
      return {
        reply: w
          ? `Konumunuz "${city}" olarak kaydedildi. Anlık hava durumu: ${w.replace(/[^\p{L}\p{N}\s.,:°+\-()]/gu, '').replace(/\s+/g, ' ').trim()}`
          : `Konumunuz "${city}" olarak kaydedildi.`,
        actionResult: { ok: true }
      };
    }
    if (/^(açık uygulamalar|açık pencereler|çalışan programlar|neler açık|pencereleri listele)$/.test(lower)) {
      const r = await listWindows();
      return { reply: r.display ? `${r.message}\n\n${r.display}` : r.message, actionResult: r };
    }
    let m = lower.match(/^(\d+)\s*(dakika|dk|saat)\s+sonra\s+(?:bilgisayarı\s+)?kapat\w*$/);
    if (m) {
      const mins = /saat/.test(m[2]) ? Number(m[1]) * 60 : Number(m[1]);
      const r = await scheduleShutdown(mins);
      return { reply: r.message, actionResult: r };
    }
    if (/^(kapatmayı iptal et|kapatmayı iptal|bilgisayarı kapatmayı iptal et)$/.test(lower)) {
      const r = await cancelShutdown();
      return { reply: r.message, actionResult: r };
    }
    if (/(otomatik başlat|açılışta başlat|bilgisayar açılınca (jarvis )?başlasın)/.test(lower)) {
      const off = /(kapat|iptal|devre dışı)/.test(lower);
      const r = await setAutostart(!off);
      return { reply: r.message, actionResult: r };
    }
    function stripAppSuffix(raw) {
      let s = String(raw || '').trim().replace(/'[a-zçğıöşü]+$/i, '').trim();
      s = s.replace(/^(?:bilgisayarda(?:ki)?|pc'deki)\s+/i, '').trim();
      if (/^(spotify|chrome|youtube|discord|whatsapp|vscode|notepad)$/i.test(s)) return s;
      return s.replace(/(?:yu|yü|yı|yi|[uüıiaeoö])$/i, '').trim() || s;
    }
    m = lower.match(/^(.+?)\s+öne\s+getir$/);
    if (m) {
      const r = await focusWindow(stripAppSuffix(m[1]));
      return { reply: r.message, actionResult: r };
    }
    m = lower.match(/^(.+?)\s+kapat$/);
    if (m && !/(sesi|bilgisayarı|ekranı|alarmı|uyarı|kilidi|mikrofonu)/.test(lower)) {
      const appName = stripAppSuffix(m[1]);
      const r = await closeApp(appName);
      return { reply: r.message, actionResult: r };
    }
    return null;
  }

  const promptSection = `
- Panik Modu (tüm pencereleri gizle + sesi kapat + ekranı kilitle): {"name": "panic_mode", "params": {}}
- Zamanlı kapatma / iptal: {"name": "schedule_shutdown", "params": {"minutes": 30}} / {"name": "cancel_shutdown", "params": {}}
- Günlük Brifing (hava durumu, döviz, sistem durumu, okunmamış mailler): {"name": "daily_briefing", "params": {}}
- Açık pencere/program yönetimi: {"name": "list_windows", "params": {}} / {"name": "focus_window", "params": {"name": "chrome"}} / {"name": "close_app", "params": {"name": "spotify"}}
- Windows açılışında otomatik başlatma: {"name": "set_autostart", "params": {"enable": true veya false}}`;

  return { run, matchFast, transcribeTelegramVoice, fetchWeather, detectCityInText, promptSection };
};
