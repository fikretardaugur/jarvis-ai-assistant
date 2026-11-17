// ============================================================================
// J.A.R.V.I.S. — GELİŞMİŞ ÖZELLİKLER
//  1) Ekrana/kameraya bakıp yorumlama (Gemini Vision)
//  2) Dosya komutları (bul / aç / listele / zip / düzenle / geri al)
//  3) Telegram'dan dosya alma ve gönderme
//  4) Akıllı bildirimler (CPU, RAM, disk, pil) + hatırlatıcılar
//  5) Makrolar (oyun modu, çalışma modu, kendi makrolarınız)
// ============================================================================
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, execSync } = require('child_process');

module.exports = function createFeatures(ctx) {
  const { psBridge, DATA_DIR, UPLOAD_DIR } = ctx;
  const home = os.homedir();
  const MACROS_FILE = path.join(DATA_DIR, 'macros.json');
  const REMINDERS_FILE = path.join(DATA_DIR, 'reminders.json');
  const ORGANIZE_LOG = path.join(DATA_DIR, 'organize_log.json');

  const trLower = (s) => String(s || '').toLocaleLowerCase('tr-TR');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const readJson = (file, fallback) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
  };
  const writeJson = (file, obj) => {
    try { fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8'); } catch (e) {}
  };
  const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  const fmtDate = (d) => new Date(d).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const telegramTarget = () => {
    const c = ctx.getConfig();
    return c.lastTelegramChatId || c.telegramAllowedChatId || '';
  };

  // ==========================================================================
  // 1) GEMINI VISION — ekran / kamera analizi
  // ==========================================================================
  async function callGeminiVision(prompt, dataUrl) {
    const cfg = ctx.getConfig();
    if (!cfg.geminiApiKey) return null;
    const b64 = String(dataUrl).replace(/^data:image\/\w+;base64,/, '');
    const models = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.7-flash', 'gemini-3.1-flash-lite'];
    for (const model of models) {
      try {
        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${cfg.geminiApiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(25000),
            body: JSON.stringify({
              system_instruction: {
                parts: [{ text: `Sen J.A.R.V.I.S. yapay zeka asistanısın. Kullanıcıya "${cfg.userName}" diye hitap et. Görüntüyü dikkatle incele ve kısa, net, doğru Türkçe ile yanıtla. Hata mesajı varsa nedenini ve adım adım çözümü ver.` }]
              },
              contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: b64 } }] }],
              generationConfig: { temperature: 0.35, maxOutputTokens: 900 }
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

  async function analyzeVisual(params = {}) {
    const source = params.source === 'webcam' ? 'webcam' : 'screen';
    const question = String(params.question || '').trim() ||
      (source === 'webcam' ? 'Kamerada ne görüyorsun? Kısaca anlat.' : 'Ekranda ne olduğunu kısaca anlat.');
    const shot = source === 'webcam' ? await psBridge.captureWebcam(80) : await psBridge.captureScreen(0.85, 78);
    if (!shot || !shot.image) {
      return { ok: false, message: 'Görüntü alınamadı.' };
    }
    if (shot.fallback && source === 'screen') {
      return {
        ok: false,
        type: 'screenshot',
        screenshot: shot,
        message: 'Gerçek ekran görüntüsü alınamıyor: JARVIS sunucusu masaüstü oturumunuzda çalışmıyor. Proje klasöründeki (veya masaüstündeki kısayoldaki) "Baslat-JARVIS.bat" dosyasına çift tıklayarak sunucuyu yeniden başlatın.'
      };
    }
    const answer = await callGeminiVision(question, shot.image);
    if (!answer) {
      return {
        ok: false,
        type: 'screenshot',
        screenshot: shot,
        message: 'Görüntüyü yakaladım ancak yapay zeka görüntü analizi şu an yanıt vermedi (Gemini anahtarını/internetinizi kontrol edin).'
      };
    }
    return { ok: true, type: 'screenshot', screenshot: shot, isWebcam: source === 'webcam', message: answer, analysis: answer };
  }

  // ==========================================================================
  // 2) DOSYA KOMUTLARI
  // ==========================================================================
  const FOLDER_ALIASES = [
    { key: 'downloads', re: /indirilen|downloads?/ },
    { key: 'desktop', re: /masa\s?üst|masaust|desktop/ },
    { key: 'documents', re: /belgeler|dökümanlar|dokumanlar|documents/ },
    { key: 'pictures', re: /resimler|görseller|gorseller|fotoğraflar|fotograflar|pictures/ },
    { key: 'music', re: /müzikler|music/ },
    { key: 'videos', re: /videolar|videos/ }
  ];

  function detectFolderKey(text) {
    const t = trLower(text);
    for (const f of FOLDER_ALIASES) if (f.re.test(t)) return f.key;
    return null;
  }

  function folderDirs(key) {
    const od = path.join(home, 'OneDrive');
    const map = {
      downloads: [path.join(home, 'Downloads')],
      desktop: [path.join(home, 'Desktop'), path.join(od, 'Desktop'), path.join(od, 'Masaüstü')],
      documents: [path.join(home, 'Documents'), path.join(od, 'Documents'), path.join(od, 'Belgeler')],
      pictures: [path.join(home, 'Pictures'), path.join(od, 'Pictures'), path.join(od, 'Resimler')],
      music: [path.join(home, 'Music')],
      videos: [path.join(home, 'Videos')]
    };
    const list = key ? map[key] || [] : [...map.downloads, ...map.desktop, ...map.documents];
    return list.filter((d) => { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } });
  }

  function parseExts(text) {
    const t = trLower(text);
    if (/\bpdf/.test(t)) return ['pdf'];
    if (/word|docx?\b/.test(t)) return ['doc', 'docx'];
    if (/excel|xlsx?\b|csv/.test(t)) return ['xls', 'xlsx', 'csv'];
    if (/sunum|pptx?\b|powerpoint/.test(t)) return ['ppt', 'pptx'];
    if (/\btxt\b|metin belgesi/.test(t)) return ['txt'];
    if (/arşiv|arsiv|\bzip\b|\brar\b/.test(t)) return ['zip', 'rar', '7z'];
    if (/\bapk\b/.test(t)) return ['apk'];
    if (/\bexe\b|kurulum/.test(t)) return ['exe', 'msi'];
    if (/resim|fotoğraf|fotograf|görsel|gorsel|\bpng\b|jpe?g/.test(t)) return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];
    if (/video|\bmp4\b/.test(t)) return ['mp4', 'mkv', 'avi', 'mov', 'webm'];
    if (/müzik|şarkı|sarki|\bmp3\b/.test(t)) return ['mp3', 'wav', 'flac', 'm4a'];
    if (/belge/.test(t)) return ['pdf', 'doc', 'docx', 'txt', 'xls', 'xlsx', 'ppt', 'pptx'];
    return null;
  }

  const SKIP_DIRS = new Set(['node_modules', '.git', 'appdata', '$recycle.bin', 'windows', 'program files', 'program files (x86)', 'jarvis düzenli']);

  function walk(dir, depth, maxDepth, out, extSet, tokens, cap) {
    if (out.length >= cap) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      if (out.length >= cap) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(ent.name.toLowerCase()) && !ent.name.startsWith('.')) {
          walk(full, depth + 1, maxDepth, out, extSet, tokens, cap);
        }
        continue;
      }
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).slice(1).toLowerCase();
      if (['ini', 'lnk', 'url', 'tmp'].includes(ext)) continue;
      if (extSet && !extSet.has(ext)) continue;
      const nameNorm = trLower(ent.name);
      if (tokens.length && !tokens.every((tk) => nameNorm.includes(tk))) continue;
      try {
        const st = fs.statSync(full);
        out.push({ path: full, name: ent.name, size: st.size, mtime: st.mtimeMs, dir: dir });
      } catch (e) {}
    }
  }

  function findFiles({ query = '', folder = null, exts = null, maxDepth = 3, limit = 10 }) {
    const dirs = folderDirs(folder);
    const extSet = exts && exts.length ? new Set(exts) : null;
    const tokens = trLower(query).split(/\s+/).filter(Boolean);
    const out = [];
    for (const d of dirs) walk(d, 0, maxDepth, out, extSet, tokens, 4000);
    out.sort((a, b) => b.mtime - a.mtime);
    return out.slice(0, limit);
  }

  // Parametrelerden tek bir dosya yolu çöz (path | query/folder/ext/latest)
  function resolveFile(params) {
    if (params.path) {
      const p = path.resolve(String(params.path).replace(/^"+|"+$/g, ''));
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return { file: { path: p, name: path.basename(p), size: fs.statSync(p).size, mtime: fs.statSync(p).mtimeMs } };
      return { error: `Dosya bulunamadı: ${p}` };
    }
    const exts = Array.isArray(params.exts) ? params.exts : params.ext ? [String(params.ext).replace(/^\./, '').toLowerCase()] : null;
    const folder = params.folder ? detectFolderKey(params.folder) || String(params.folder) : null;
    const found = findFiles({ query: params.query || '', folder: FOLDER_ALIASES.some((f) => f.key === folder) ? folder : null, exts, limit: 5 });
    if (!found.length) return { error: 'Eşleşen dosya bulunamadı.' };
    return { file: found[0], others: found.slice(1) };
  }

  function listDisplay(files) {
    return files.map((f, i) => `${i + 1}. ${f.name} — ${fmtSize(f.size)}, ${fmtDate(f.mtime)} (${path.basename(f.dir || path.dirname(f.path))})`).join('\n');
  }

  async function openPath(p) {
    await ctx.launchAndFocusOnDesktop(`cmd.exe /c start "" "${p.replace(/"/g, '')}"`, '');
  }

  async function sendTelegramDocument(chatId, filePath, caption) {
    const cfg = ctx.getConfig();
    if (!cfg.telegramBotToken) return { ok: false, error: 'Telegram botu ayarlı değil.' };
    if (!chatId) return { ok: false, error: 'Telegram sohbeti bilinmiyor (bota önce /start yazın).' };
    const st = fs.statSync(filePath);
    if (st.size > 49 * 1024 * 1024) return { ok: false, error: `Dosya Telegram sınırını (50 MB) aşıyor (${fmtSize(st.size)}).` };
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) form.append('caption', String(caption).slice(0, 900));
    form.append('document', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
    try {
      const r = await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendDocument`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(120000)
      });
      const j = await r.json().catch(() => ({}));
      return { ok: Boolean(r.ok && j.ok), error: j.description };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  const ORGANIZE_CATS = {
    Resimler: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic'],
    Belgeler: ['pdf', 'doc', 'docx', 'txt', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'odt', 'rtf'],
    Videolar: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'wmv'],
    Müzikler: ['mp3', 'wav', 'flac', 'm4a', 'ogg'],
    Arşivler: ['zip', 'rar', '7z', 'tar', 'gz', 'iso'],
    Programlar: ['exe', 'msi', 'apk', 'bat'],
    Kodlar: ['js', 'ts', 'py', 'html', 'css', 'json', 'java', 'cs', 'cpp', 'ps1']
  };

  function uniqueTarget(dir, name) {
    let target = path.join(dir, name);
    if (!fs.existsSync(target)) return target;
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    let i = 1;
    while (fs.existsSync(path.join(dir, `${base} (${i})${ext}`))) i++;
    return path.join(dir, `${base} (${i})${ext}`);
  }

  function organizeFolder(folderKey) {
    const dirs = folderDirs(folderKey || 'desktop');
    if (!dirs.length) return { ok: false, message: 'Klasör bulunamadı.' };
    const moves = [];
    for (const dir of dirs) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
      for (const ent of entries) {
        if (!ent.isFile()) continue;
        const ext = path.extname(ent.name).slice(1).toLowerCase();
        if (['lnk', 'url', 'ini'].includes(ext) || ent.name.startsWith('.') || ent.name.startsWith('~$')) continue;
        let cat = 'Diğer';
        for (const [name, list] of Object.entries(ORGANIZE_CATS)) if (list.includes(ext)) { cat = name; break; }
        const destDir = path.join(dir, 'JARVIS Düzenli', cat);
        try {
          fs.mkdirSync(destDir, { recursive: true });
          const to = uniqueTarget(destDir, ent.name);
          fs.renameSync(path.join(dir, ent.name), to);
          moves.push({ from: path.join(dir, ent.name), to });
        } catch (e) {}
      }
    }
    if (!moves.length) return { ok: true, message: 'Düzenlenecek dosya bulunamadı, klasör zaten derli toplu.' };
    writeJson(ORGANIZE_LOG, { at: Date.now(), moves });
    const counts = {};
    for (const m of moves) { const c = path.basename(path.dirname(m.to)); counts[c] = (counts[c] || 0) + 1; }
    const summary = Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', ');
    return {
      ok: true,
      message: `${moves.length} dosya "JARVIS Düzenli" klasöründe türlerine göre ayrıldı (${summary}). İsterseniz "düzenlemeyi geri al" diyebilirsiniz.`
    };
  }

  function undoOrganize() {
    const log = readJson(ORGANIZE_LOG, null);
    if (!log || !Array.isArray(log.moves) || !log.moves.length) return { ok: false, message: 'Geri alınacak bir düzenleme kaydı yok.' };
    let restored = 0;
    for (const m of log.moves.reverse()) {
      try {
        if (fs.existsSync(m.to) && !fs.existsSync(m.from)) {
          fs.renameSync(m.to, m.from);
          restored++;
        }
        // Boşalan kategori klasörlerini ve "JARVIS Düzenli" klasörünü temizle
        const catDir = path.dirname(m.to);
        if (fs.existsSync(catDir) && fs.readdirSync(catDir).length === 0) fs.rmdirSync(catDir);
        const parent = path.dirname(catDir);
        if (path.basename(parent) === 'JARVIS Düzenli' && fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
      } catch (e) {}
    }
    writeJson(ORGANIZE_LOG, { at: Date.now(), moves: [] });
    return { ok: true, message: `${restored} dosya eski yerine geri taşındı.` };
  }

  function zipTarget(srcPath) {
    return new Promise((resolve) => {
      const dest = path.join(UPLOAD_DIR, `${path.basename(srcPath)}_${Date.now()}.zip`);
      const esc = (s) => s.replace(/'/g, "''");
      exec(
        `powershell -NoProfile -Command "Compress-Archive -LiteralPath '${esc(srcPath)}' -DestinationPath '${esc(dest)}' -Force"`,
        { timeout: 180000 },
        (err) => resolve(err || !fs.existsSync(dest) ? null : dest)
      );
    });
  }

  async function fileAction(action, params) {
    switch (action) {
      case 'list_files': {
        const key = params.folder ? detectFolderKey(params.folder) || params.folder : null;
        const exts = params.ext ? [String(params.ext).replace(/^\./, '').toLowerCase()] : parseExts(params.type || '');
        const files = findFiles({ folder: FOLDER_ALIASES.some((f) => f.key === key) ? key : null, exts, maxDepth: 1, limit: Math.min(25, Number(params.count) || 8) });
        if (!files.length) return { ok: false, message: 'Bu kriterlere uyan dosya bulunamadı.' };
        return { ok: true, message: `${files.length} dosya listelendi.`, display: listDisplay(files), files };
      }
      case 'find_file': {
        const files = findFiles({ query: params.query || '', folder: params.folder ? detectFolderKey(params.folder) : null, exts: params.ext ? [String(params.ext).replace(/^\./, '').toLowerCase()] : null, limit: 8 });
        if (!files.length) return { ok: false, message: `"${params.query || ''}" için dosya bulunamadı.` };
        return { ok: true, message: `${files.length} dosya bulundu.`, display: listDisplay(files), files };
      }
      case 'open_file': {
        const r = resolveFile(params);
        if (r.error) return { ok: false, message: r.error };
        await openPath(r.file.path);
        return { ok: true, message: `"${r.file.name}" bilgisayarda açıldı.`, path: r.file.path };
      }
      case 'send_file': {
        const r = resolveFile(params);
        if (r.error) return { ok: false, message: r.error };
        const res = await sendTelegramDocument(telegramTarget(), r.file.path, `📎 ${r.file.name}`);
        if (!res.ok) return { ok: false, message: `Dosya gönderilemedi: ${res.error || 'bilinmeyen hata'}` };
        return { ok: true, message: `"${r.file.name}" (${fmtSize(r.file.size)}) Telegram'a gönderildi.` };
      }
      case 'zip_folder': {
        let src = params.path ? path.resolve(String(params.path)) : null;
        if (!src && params.folder) {
          const key = detectFolderKey(params.folder);
          const d = key ? folderDirs(key)[0] : null;
          if (d) src = d;
          else {
            const hit = findFolderByName(params.folder);
            if (hit) src = hit;
          }
        }
        if (!src || !fs.existsSync(src)) return { ok: false, message: 'Sıkıştırılacak klasör bulunamadı.' };
        const zipPath = await zipTarget(src);
        if (!zipPath) return { ok: false, message: 'Sıkıştırma başarısız oldu.' };
        const size = fs.statSync(zipPath).size;
        if (params.send === false) return { ok: true, message: `Zip oluşturuldu: ${zipPath} (${fmtSize(size)})` };
        const res = await sendTelegramDocument(telegramTarget(), zipPath, `🗜️ ${path.basename(src)}`);
        if (!res.ok) return { ok: false, message: `Zip oluşturuldu (${zipPath}, ${fmtSize(size)}) ancak Telegram'a gönderilemedi: ${res.error || ''}` };
        return { ok: true, message: `"${path.basename(src)}" sıkıştırıldı (${fmtSize(size)}) ve Telegram'a gönderildi.` };
      }
      case 'organize_folder':
        return organizeFolder(params.folder ? detectFolderKey(params.folder) || 'desktop' : 'desktop');
      case 'undo_organize':
        return undoOrganize();
    }
    return undefined;
  }

  function findFolderByName(name) {
    const target = trLower(name).trim();
    for (const base of folderDirs(null)) {
      try {
        for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
          if (ent.isDirectory() && trLower(ent.name).includes(target)) return path.join(base, ent.name);
        }
      } catch (e) {}
    }
    return null;
  }

  // ==========================================================================
  // 3) TELEGRAM — gelen dosyaları kaydet
  // ==========================================================================
  async function handleTelegramFile(chatId, msg) {
    const cfg = ctx.getConfig();
    const token = cfg.telegramBotToken;
    let fileId = null;
    let name = null;
    if (msg.document) { fileId = msg.document.file_id; name = msg.document.file_name; }
    else if (msg.photo && msg.photo.length) { fileId = msg.photo[msg.photo.length - 1].file_id; name = `foto_${Date.now()}.jpg`; }
    else if (msg.video) { fileId = msg.video.file_id; name = msg.video.file_name || `video_${Date.now()}.mp4`; }
    else if (msg.audio) { fileId = msg.audio.file_id; name = msg.audio.file_name || `ses_${Date.now()}.mp3`; }
    else if (msg.voice) { fileId = msg.voice.file_id; name = `sesli_mesaj_${Date.now()}.ogg`; }
    if (!fileId) return;

    try {
      const gf = await (await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`, { signal: AbortSignal.timeout(15000) })).json();
      if (!gf.ok) {
        await ctx.sendTelegramMessage(chatId, `⚠️ Dosya alınamadı: ${gf.description || 'Telegram botları en fazla 20 MB indirebilir.'}`);
        return;
      }
      const resp = await fetch(`https://api.telegram.org/file/bot${token}/${gf.result.file_path}`, { signal: AbortSignal.timeout(120000) });
      const buf = Buffer.from(await resp.arrayBuffer());
      const safe = String(name || path.basename(gf.result.file_path)).replace(/[\\/:*?"<>|]/g, '_');
      const dest = uniqueTarget(UPLOAD_DIR, safe);
      fs.writeFileSync(dest, buf);
      let note = `📥 Dosya bilgisayara kaydedildi:\n${path.basename(dest)} (${fmtSize(buf.length)})\n📁 ${UPLOAD_DIR}`;
      const caption = trLower(msg.caption || '');
      if (/(^|\s)aç(\s|$)/.test(caption)) {
        await openPath(dest);
        note += '\n▶️ Dosya bilgisayarda açıldı.';
      }
      ctx.broadcastSSE({ type: 'alert', message: `📥 Telegram'dan dosya alındı: ${path.basename(dest)}`, speak: 'Telegram üzerinden yeni bir dosya aldım.' });
      await ctx.sendTelegramMessage(chatId, note);
    } catch (e) {
      await ctx.sendTelegramMessage(chatId, `⚠️ Dosya indirilemedi: ${e.message}`);
    }
  }

  // ==========================================================================
  // 4) AKILLI BİLDİRİMLER + HATIRLATICILAR
  // ==========================================================================
  async function notify(message, speak) {
    ctx.broadcastSSE({ type: 'alert', message, speak: speak || message });
    const target = telegramTarget();
    if (ctx.getConfig().telegramBotToken && target) {
      try { await ctx.sendTelegramMessage(target, message); } catch (e) {}
    }
  }

  const alertState = {
    cpuHigh: 0,
    ramHigh: 0,
    last: {}
  };
  const cooldownOk = (key, ms) => {
    const now = Date.now();
    if (alertState.last[key] && now - alertState.last[key] < ms) return false;
    alertState.last[key] = now;
    return true;
  };

  function topCpuProcesses() {
    return new Promise((resolve) => {
      exec(
        `powershell -NoProfile -Command "Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -notin '_Total','Idle' } | Sort-Object PercentProcessorTime -Descending | Select-Object -First 3 | ForEach-Object { $_.Name + ' (%' + $_.PercentProcessorTime + ')' }"`,
        { timeout: 8000 },
        (err, stdout) => resolve(err ? '' : String(stdout).trim().split(/\r?\n/).filter(Boolean).join(', '))
      );
    });
  }

  async function checkAlerts() {
    const cfg = ctx.getConfig();
    if (cfg.alertsEnabled === false) return;
    const t = psBridge.lastTelemetry || {};

    alertState.cpuHigh = Number(t.cpu) >= 92 ? alertState.cpuHigh + 1 : 0;
    alertState.ramHigh = Number(t.ramPercent) >= 93 ? alertState.ramHigh + 1 : 0;

    if (alertState.cpuHigh >= 4 && cooldownOk('cpu', 30 * 60000)) {
      const top = await topCpuProcesses();
      await notify(`⚠️ *İşlemci uzun süredir %${t.cpu} seviyesinde!*${top ? `\nEn çok yükleyenler: ${top}` : ''}`, 'Dikkat, işlemci uzun süredir çok yüksek yükte çalışıyor.');
    }
    if (alertState.ramHigh >= 4 && cooldownOk('ram', 30 * 60000)) {
      await notify(`⚠️ *Bellek (RAM) %${t.ramPercent} dolu!* (${t.ramUsedGB}/${t.ramTotalGB} GB)\nGerekirse "sistemi temizle" diyebilirsiniz.`, 'Dikkat, bellek neredeyse tamamen dolu.');
    }
    if (Number(t.diskPercent) >= 92 && cooldownOk('disk', 12 * 3600000)) {
      await notify(`⚠️ *C: diski %${t.diskPercent} dolu!* Boş alan azalıyor, "sistemi temizle" diyebilirsiniz.`, 'Dikkat, C diskinin doluluğu kritik seviyede.');
    }
    if (t.isCharging === false && Number(t.batteryPercent) <= 20) {
      const critical = Number(t.batteryPercent) <= 10;
      if (cooldownOk(critical ? 'bat_crit' : 'bat', 20 * 60000)) {
        await notify(`🔋 *Pil %${t.batteryPercent}${critical ? ' — KRİTİK' : ''}!* Şarj cihazını takın.`, `Pil yüzde ${t.batteryPercent} seviyesinde, lütfen şarja takın.`);
      }
    }
  }

  // --- Hatırlatıcılar
  let reminders = readJson(REMINDERS_FILE, []);
  if (!Array.isArray(reminders)) reminders = [];
  const saveReminders = () => writeJson(REMINDERS_FILE, reminders);

  function addReminder(params) {
    const text = String(params.text || '').trim() || 'Hatırlatma';
    let at = 0;
    if (params.time) {
      const m = String(params.time).match(/(\d{1,2})[:.](\d{2})/);
      if (m) {
        const d = new Date();
        d.setHours(Number(m[1]), Number(m[2]), 0, 0);
        if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
        at = d.getTime();
      }
    }
    if (!at) {
      const minutes = Number(params.minutes);
      if (!minutes || minutes <= 0) return { ok: false, message: 'Hatırlatma zamanı anlaşılamadı (örn: "20 dakika sonra").' };
      at = Date.now() + minutes * 60000;
    }
    reminders.push({ id: Date.now() + Math.floor(Math.random() * 1000), at, text });
    saveReminders();
    const when = new Date(at).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    return { ok: true, type: 'reminder_set', message: `Hatırlatıcı kuruldu: saat ${when} — "${text}".` };
  }

  async function checkReminders() {
    const now = Date.now();
    const due = reminders.filter((r) => r.at <= now);
    if (!due.length) return;
    reminders = reminders.filter((r) => r.at > now);
    saveReminders();
    for (const r of due) {
      await notify(`⏰ *Hatırlatma:* ${r.text}`, `Hatırlatma: ${r.text}`);
      try { await ctx.executePCAction('speak_on_pc', { text: `Hatırlatma. ${r.text}` }); } catch (e) {}
    }
  }

  // ==========================================================================
  // 5) MAKROLAR
  // ==========================================================================
  const BUILTIN_MACROS = {
    oyun: {
      label: 'Oyun Modu',
      steps: [
        { name: 'set_brightness', params: { level: 100 } },
        { name: 'set_volume', params: { level: 70 } },
        { name: 'open_protocol', params: { protocol: 'steam', url: 'steam://open/main', label: 'Steam' } },
        { name: 'open_protocol', params: { protocol: 'discord', url: 'discord://', label: 'Discord' } }
      ]
    },
    çalışma: {
      label: 'Çalışma Modu',
      steps: [
        { name: 'set_brightness', params: { level: 80 } },
        { name: 'set_volume', params: { level: 25 } },
        { name: 'open_app', params: { app: 'vscode' } },
        { name: 'open_app', params: { app: 'chrome' } }
      ]
    },
    film: {
      label: 'Film Modu',
      steps: [
        { name: 'set_brightness', params: { level: 65 } },
        { name: 'set_volume', params: { level: 60 } },
        { name: 'open_app', params: { app: 'netflix' } }
      ]
    },
    gece: {
      label: 'Gece Modu',
      steps: [
        { name: 'media_control', params: { command: 'play_pause' } },
        { name: 'set_brightness', params: { level: 20 } },
        { name: 'set_volume', params: { level: 15 } }
      ]
    },
    normal: {
      label: 'Normal Mod',
      steps: [
        { name: 'set_brightness', params: { level: 80 } },
        { name: 'set_volume', params: { level: 50 } }
      ]
    }
  };

  const normMacroName = (n) => trLower(n).replace(/\s*(modunu|moduna|modu|makrosunu|makrosu|mod|makro)$/g, '').trim();
  const userMacros = () => readJson(MACROS_FILE, {});
  const allMacros = () => ({ ...BUILTIN_MACROS, ...userMacros() });

  function protocolInstalled(proto) {
    try {
      execSync(`reg query "HKCR\\${proto}" /ve`, { stdio: 'ignore', timeout: 4000 });
      return true;
    } catch (e) {
      return false;
    }
  }

  async function runMacro(name) {
    const key = normMacroName(name);
    const macros = allMacros();
    const macro = macros[key];
    if (!macro) {
      return { ok: false, message: `"${name}" adında bir makro yok. Mevcut makrolar: ${Object.keys(macros).join(', ')}.` };
    }
    const log = [];
    let n = 0;
    for (const step of macro.steps || []) {
      if (!step || !step.name || step.name === 'run_macro') continue;
      try {
        if (step.name === 'wait') {
          await sleep(Math.min(10, Number(step.params?.seconds) || 1) * 1000);
        } else if (step.name === 'open_protocol') {
          const p = step.params || {};
          if (protocolInstalled(p.protocol)) {
            await ctx.launchAndFocusOnDesktop(`cmd.exe /c start "" "${String(p.url).replace(/"/g, '')}"`, '');
            log.push(`${p.label || p.protocol} açıldı`);
          } else {
            log.push(`${p.label || p.protocol} kurulu değil, atlandı`);
          }
        } else {
          const r = await ctx.executePCAction(step.name, step.params || {});
          if (r && r.message) log.push(r.message);
        }
        n++;
      } catch (e) {
        log.push(`${step.name} adımı başarısız: ${e.message}`);
      }
    }
    return { ok: true, type: 'macro', message: `${macro.label || key} çalıştırıldı (${n} adım).`, display: log.map((l) => `• ${l}`).join('\n') };
  }

  function saveMacro(params) {
    const key = normMacroName(params.name || '');
    if (!key) return { ok: false, message: 'Makro adı belirtilmedi.' };
    const steps = (Array.isArray(params.steps) ? params.steps : [])
      .filter((s) => s && typeof s.name === 'string' && s.name !== 'run_macro')
      .map((s) => ({ name: s.name, params: s.params || {} }));
    if (!steps.length) return { ok: false, message: 'Makro için en az bir adım gerekli.' };
    const macros = userMacros();
    macros[key] = { label: `${params.name} makrosu`, steps };
    writeJson(MACROS_FILE, macros);
    return { ok: true, message: `"${key}" makrosu kaydedildi (${steps.length} adım). "${key} modu" diyerek çalıştırabilirsiniz.` };
  }

  function deleteMacro(name) {
    const key = normMacroName(name);
    const macros = userMacros();
    if (!macros[key]) return { ok: false, message: BUILTIN_MACROS[key] ? 'Hazır makrolar silinemez.' : `"${name}" adında bir makro yok.` };
    delete macros[key];
    writeJson(MACROS_FILE, macros);
    return { ok: true, message: `"${key}" makrosu silindi.` };
  }

  // ==========================================================================
  // EYLEM YÖNLENDİRİCİ (executePCAction varsayılan dalı)
  // ==========================================================================
  async function run(action, params = {}) {
    switch (action) {
      case 'analyze_screen':
      case 'analyze_webcam':
        return analyzeVisual({ ...params, source: action === 'analyze_webcam' ? 'webcam' : params.source });
      case 'list_files':
      case 'find_file':
      case 'open_file':
      case 'send_file':
      case 'zip_folder':
      case 'organize_folder':
      case 'undo_organize':
        return fileAction(action, params);
      case 'set_reminder':
        return addReminder(params);
      case 'list_reminders':
        return reminders.length
          ? { ok: true, message: `${reminders.length} aktif hatırlatıcı.`, display: reminders.map((r) => `• ${new Date(r.at).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })} — ${r.text}`).join('\n') }
          : { ok: true, message: 'Aktif hatırlatıcı yok.' };
      case 'cancel_reminders': {
        const c = reminders.length;
        reminders = [];
        saveReminders();
        return { ok: true, message: `${c} hatırlatıcı iptal edildi.` };
      }
      case 'run_macro':
        return runMacro(params.name || '');
      case 'save_macro':
        return saveMacro(params);
      case 'delete_macro':
        return deleteMacro(params.name || '');
      case 'list_macros': {
        const m = allMacros();
        return { ok: true, message: 'Mevcut makrolar:', display: Object.entries(m).map(([k, v]) => `• ${k} — ${v.label || ''} (${(v.steps || []).length} adım)`).join('\n') };
      }
      case 'set_alerts': {
        const enable = params.enable !== false;
        ctx.getConfig().alertsEnabled = enable;
        ctx.saveConfig();
        return { ok: true, message: enable ? 'Akıllı sistem uyarıları açıldı.' : 'Akıllı sistem uyarıları kapatıldı.' };
      }
    }
    return undefined;
  }

  // ==========================================================================
  // HIZLI (LLM'siz) KOMUT EŞLEŞTİRME
  // ==========================================================================
  const FILE_WORDS = 'dosya|pdf|resim|fotoğraf|fotograf|görsel|gorsel|video|belge|müzik|şarkı|sunum|zip|word|excel|docx?|xlsx?|pptx?|txt|apk|exe|mp3|mp4|png|jpe?g|arşiv|arsiv';
  const LATEST_RE = new RegExp(`(^|\\s)son\\s+(\\d+\\s+)?(indirilen\\s+|eklenen\\s+|kaydedilen\\s+|değiştirilen\\s+)?(${FILE_WORDS})`);

  async function matchFast(lower, original) {
    const u = ctx.getConfig().userName;
    const wrap = (reply, actionResult) => ({ reply, actionResult });

    // --- Görsel analiz (ekran / kamera)
    if (/(kameraya bak|kamerada ne var|önümde ne var|beni gör|kamerayı yorumla)/.test(lower)) {
      const r = await analyzeVisual({ source: 'webcam', question: 'Kamerada ne görüyorsun? Kısaca ve doğal Türkçe ile anlat.' });
      return wrap(r.message, r);
    }
    if (/(ekranda ne var|ekrana bak|ekranı (yorumla|oku|analiz et|özetle|incele)|şu an ne yapıyorum|ekranımda ne var|ekranda(ki)? .*(ne yazıyor|anlat|oku)|bu hatayı çöz|bu hata ne|ekrandaki hata)/.test(lower)) {
      const isError = /hata/.test(lower);
      const question = isError
        ? 'Ekrandaki hatayı/sorunu tespit et, nedenini açıkla ve adım adım çözümünü yaz.'
        : /ne yazıyor|oku/.test(lower)
          ? 'Ekranda yazan önemli metinleri oku ve özetle.'
          : 'Ekranda şu an ne olduğunu ve kullanıcının ne yapıyor olabileceğini kısaca anlat.';
      const r = await analyzeVisual({ source: 'screen', question });
      return wrap(r.message, r);
    }

    // --- Hatırlatıcılar: "20 dakika sonra su içmemi hatırlat" / "saat 18:30'da toplantıyı hatırlat"
    let m = lower.match(/^(?:bana\s+)?(\d+)\s*(dakika|dk|saat|saniye|sn)\s+(?:sonra|içinde)\s+(.+?)\s*(?:diye\s+)?hatırlat\w*$/);
    if (m) {
      const n = Number(m[1]);
      const minutes = /saat/.test(m[2]) ? n * 60 : /saniye|sn/.test(m[2]) ? n / 60 : n;
      const r = addReminder({ minutes, text: m[3] });
      return wrap(`Tabii ${u}. ${r.message}`, r);
    }
    m = lower.match(/^(?:bana\s+)?saat\s*(\d{1,2})[:.]?(\d{2})?\s*(?:'?[dt][ae])?\s+(.+?)\s*(?:diye\s+)?hatırlat\w*$/);
    if (m) {
      const r = addReminder({ time: `${m[1]}:${m[2] || '00'}`, text: m[3] });
      return wrap(`Tabii ${u}. ${r.message}`, r);
    }
    if (/^(hatırlatıcıları|hatırlatmaları) (listele|göster)$/.test(lower) || lower === 'hatırlatıcılar') {
      const r = await run('list_reminders');
      return wrap(enrich(r), r);
    }
    if (/^(hatırlatıcıları|hatırlatmaları) (iptal et|sil|temizle)$/.test(lower)) {
      const r = await run('cancel_reminders');
      return wrap(r.message, r);
    }

    // --- Akıllı uyarılar
    m = lower.match(/(sistem|performans|akıllı)\s+(uyarı|bildirim)\w*\s*(kapat|aç)/);
    if (m) {
      const r = await run('set_alerts', { enable: m[3] === 'aç' });
      return wrap(r.message, r);
    }

    // --- Dosya düzenleme
    if (/(düzenlemeyi|toparlamayı|düzenlediğini)\s*geri\s*al/.test(lower)) {
      const r = undoOrganize();
      return wrap(r.message, r);
    }
    if (/(düzenle|toparla|derle|sınıflandır)/.test(lower) && detectFolderKey(lower) && !/(not|metin)/.test(lower)) {
      const r = organizeFolder(detectFolderKey(lower));
      return wrap(r.message, r);
    }

    // --- Son dosya: aç / gönder / listele
    const lm = lower.match(LATEST_RE);
    if (lm) {
      const count = lm[2] ? Math.min(25, Number(lm[2])) : 1;
      const folder = detectFolderKey(lower);
      const exts = parseExts(lower);
      const wantsSend = /(gönder|ilet|yolla|paylaş)/.test(lower);
      const wantsOpen = /(^|\s)(aç|açar mısın|başlat)(\s|$)/.test(lower);
      if (wantsSend) {
        const r = await fileAction('send_file', { folder, exts });
        return wrap(r.ok ? `${r.message}` : r.message, r);
      }
      if (wantsOpen && count === 1) {
        const r = await fileAction('open_file', { folder, exts });
        return wrap(r.message, r);
      }
      const r = await fileAction('list_files', { folder, ext: null, type: lower, count });
      return wrap(enrich(r), r);
    }

    // --- Makrolar
    if (/^(makrolar|makroları listele|makroları göster|modlar|hangi modlar var)$/.test(lower)) {
      const r = await run('list_macros');
      return wrap(enrich(r), r);
    }
    const macros = allMacros();
    if (macros[lower]) {
      const r = await runMacro(lower);
      return wrap(`${r.message}${r.display ? '\n' + r.display : ''}`, r);
    }
    m = lower.match(/^(.+?)\s*(modunu|moduna|modu|makrosunu|makrosu)\s*(aç|başlat|çalıştır|etkinleştir|devreye al|geç|al|aktif et)?$/);
    if (m && macros[normMacroName(m[1])]) {
      const r = await runMacro(m[1]);
      return wrap(`${r.message}${r.display ? '\n' + r.display : ''}`, r);
    }

    return null;
  }

  function enrich(r) {
    return r && r.display ? `${r.message}\n${r.display}` : r ? r.message : '';
  }

  // ==========================================================================
  // ARKA PLAN DÖNGÜLERİ
  // ==========================================================================
  setInterval(() => { checkAlerts().catch(() => {}); }, 20000);
  setInterval(() => { checkReminders().catch(() => {}); }, 5000);

  const promptSection = `
- Ekran/Kamera analizi (görüntüye bakıp soruyu yanıtla; hata çözme, metin okuma): {"name": "analyze_screen", "params": {"question": "kullanıcının ekranla ilgili sorusu"}} veya {"name": "analyze_webcam", "params": {"question": "..."}}
- Dosyaları listeleme: {"name": "list_files", "params": {"folder": "indirilenler|masaüstü|belgeler|resimler|müzik|videolar", "ext": "pdf (isteğe bağlı)", "count": 8}}
- Dosya arama: {"name": "find_file", "params": {"query": "dosya adından kelimeler", "folder": "(isteğe bağlı)", "ext": "(isteğe bağlı)"}}
- Dosya açma: {"name": "open_file", "params": {"query": "...", "folder": "...", "ext": "..."}} (veya tam yol: "path")
- Dosyayı Telegram'a gönderme (telefona yollama): {"name": "send_file", "params": {"query": "...", "folder": "...", "ext": "...", "path": "(biliniyorsa tam yol)"}}
- Klasörü zip'leyip Telegram'a gönderme: {"name": "zip_folder", "params": {"folder": "klasör adı veya masaüstü/indirilenler", "path": "(biliniyorsa tam yol)", "send": true}}
- Klasördeki dosyaları türe göre düzenleme (geri alınabilir): {"name": "organize_folder", "params": {"folder": "masaüstü"}} ve geri alma: {"name": "undo_organize", "params": {}}
- Hatırlatıcı kurma: {"name": "set_reminder", "params": {"minutes": 20, "time": "18:30 (saat verildiyse)", "text": "hatırlatılacak şey"}} / {"name": "list_reminders", "params": {}} / {"name": "cancel_reminders", "params": {}}
- Makro çalıştırma (hazır: oyun, çalışma, film, gece, normal, günaydın): {"name": "run_macro", "params": {"name": "oyun"}}
- Makro oluşturma (adımlar yukarıdaki eylemlerdir, bekleme için {"name":"wait","params":{"seconds":2}}): {"name": "save_macro", "params": {"name": "ders", "steps": [{"name": "open_app", "params": {"app": "chrome"}}, {"name": "set_volume", "params": {"level": 20}}]}} / {"name": "list_macros", "params": {}} / {"name": "delete_macro", "params": {"name": "ders"}}
- Akıllı sistem uyarılarını (CPU/RAM/disk/pil) aç/kapat: {"name": "set_alerts", "params": {"enable": true veya false}}`;

  return { run, matchFast, handleTelegramFile, sendTelegramDocument, promptSection, enrich };
};
