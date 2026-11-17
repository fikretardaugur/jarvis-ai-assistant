// ============================================================================
// J.A.R.V.I.S. — ANDROID MACRODROID SMS KÖPRÜSÜ
//  - Onay mekanizmalı giden SMS (MacroDroid Cloud/LAN Webhook üzerinden)
//  - Kişi rehberi desteği ("Anneme ... diye SMS at")
//  - Gelen SMS bildirimi (/api/sms/incoming -> Telegram + HUD)
// ============================================================================
const fs = require('fs');
const path = require('path');

module.exports = function createSmsModule(ctx) {
  const { DATA_DIR, broadcastSSE } = ctx;
  const CONTACTS_FILE = path.join(DATA_DIR, 'sms_contacts.json');

  let pendingSms = null;
  let pendingWhatsapp = null;
  let pendingCall = null;
  let contacts = {};
  try {
    if (fs.existsSync(CONTACTS_FILE)) {
      contacts = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8')) || {};
    }
  } catch (e) {}

  const saveContacts = () => {
    try { fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2), 'utf8'); } catch (e) {}
  };

  function getWebhookUrl() {
    return String(ctx.getConfig().smsWebhookUrl || '').trim();
  }

  function getWhatsappWebhookUrl() {
    const explicit = String(ctx.getConfig().whatsappWebhookUrl || '').trim();
    if (explicit) return explicit;
    const smsUrl = getWebhookUrl();
    if (!smsUrl) return '';
    return smsUrl.replace(/\/[^/?#]+(\?.*)?$/, '/jarvis_wp');
  }

  function getCallWebhookUrl() {
    const explicit = String(ctx.getConfig().callWebhookUrl || '').trim();
    if (explicit) return explicit;
    const smsUrl = getWebhookUrl();
    if (!smsUrl) return '';
    return smsUrl.replace(/\/[^/?#]+(\?.*)?$/, '/jarvis_call');
  }

  function normalizePhone(raw) {
    const cleaned = String(raw || '').replace(/[\s()-]/g, '').trim();
    if (/^\+?\d{7,15}$/.test(cleaned)) return cleaned;
    return null;
  }

  function findContactInText(lowerText) {
    const t = String(lowerText || '').toLocaleLowerCase('tr-TR');
    for (const [name, phone] of Object.entries(contacts)) {
      const k = name.toLocaleLowerCase('tr-TR');
      if (t.includes(k) || (k.length > 3 && t.includes(k.slice(0, -1)))) {
        return { phone, label: `${name} (${phone})` };
      }
    }
    const phoneMatch = t.match(/(\+?\d[\d\s()-]{8,14}\d)/);
    if (phoneMatch) {
      const p = normalizePhone(phoneMatch[1]);
      if (p) return { phone: p, label: p };
    }
    return null;
  }

  function resolveRecipient(input) {
    const raw = String(input || '').trim();
    const direct = normalizePhone(raw);
    if (direct) return { phone: direct, label: direct };

    const key = raw.toLocaleLowerCase('tr-TR').trim();
    for (const [name, phone] of Object.entries(contacts)) {
      if (name.toLocaleLowerCase('tr-TR') === key || name.toLocaleLowerCase('tr-TR').includes(key)) {
        return { phone, label: `${name} (${phone})` };
      }
    }
    return null;
  }

  function findContactInText(lowerText) {
    const t = String(lowerText || '').toLocaleLowerCase('tr-TR');
    for (const [name, phone] of Object.entries(contacts)) {
      const k = name.toLocaleLowerCase('tr-TR');
      if (t.includes(k) || (k.length > 3 && t.includes(k.slice(0, -1)))) {
        return { phone, label: `${name} (${phone})` };
      }
    }
    const phoneMatch = t.match(/(\+?\d[\d\s()-]{8,14}\d)/);
    if (phoneMatch) {
      const p = normalizePhone(phoneMatch[1]);
      if (p) return { phone: p, label: p };
    }
    return null;
  }

  function getContactsText() {
    return Object.entries(contacts)
      .map(([name, phone]) => `${name}=${phone}`)
      .join('\n');
  }

  function setContactsFromText(text) {
    const next = {};
    for (const line of String(text || '').split(/\r?\n/)) {
      const m = line.match(/^\s*([^=:\n]+?)\s*[=:]\s*(\+?\d[\d\s()-]{6,})\s*$/);
      if (m) {
        const phone = normalizePhone(m[2]);
        if (phone) next[m[1].trim()] = phone;
      }
    }
    contacts = next;
    saveContacts();
    return contacts;
  }

  async function draftSmsAction(params = {}) {
    const webhook = getWebhookUrl();
    if (!webhook) {
      return {
        ok: false,
        message: 'Android MacroDroid Webhook URL ayarlanmamış. Bağlantı/Ayarlar sekmesinden MacroDroid Webhook adresini girin.'
      };
    }

    const target = resolveRecipient(params.to || params.phone || '');
    if (!target) {
      return {
        ok: false,
        message: `"${params.to || ''}" için telefon numarası bulunamadı. Numara yazın (örn. 0532...) veya Ayarlar'daki SMS Rehberine ekleyin.`
      };
    }

    const text = String(params.text || params.message || '').trim();
    if (!text) {
      return { ok: false, message: 'SMS mesaj metni boş olamaz.' };
    }

    pendingSms = {
      id: Date.now(),
      to: target.phone,
      label: target.label,
      text,
      createdAt: new Date().toISOString()
    };

    return confirmSendSmsAction();
  }

  async function sendViaMacroDroid(phone, text) {
    const base = getWebhookUrl();
    if (!base) throw new Error('MacroDroid Webhook URL ayarlı değil.');

    // Birleşik tek makro (?type=sms&to=...&msg=...)
    const sep = base.includes('?') ? '&' : '?';
    const url = `${base}${sep}type=sms&to=${encodeURIComponent(phone)}&msg=${encodeURIComponent(text)}`;
    let resp = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(12000)
    });
    if (resp.status === 405) {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: phone, msg: text, text }),
        signal: AbortSignal.timeout(12000)
      });
    }
    if (resp.status === 404) {
      throw new Error('MacroDroid 404: Telefonda makro henüz kaydedilip/aktif edilmemiş veya Webhook URL sonundaki isim (jarvis_sms) uyuşmuyor.');
    }
    if (!resp.ok) {
      throw new Error(`MacroDroid HTTP ${resp.status}`);
    }
    return true;
  }

  async function confirmSendSmsAction() {
    if (!pendingSms) return { ok: false, message: 'Onay bekleyen bir SMS taslağı yok.' };
    const draft = pendingSms;
    try {
      await sendViaMacroDroid(draft.to, draft.text);
      pendingSms = null;
      return {
        ok: true,
        type: 'sms_sent',
        message: `SMS gönderim komutu telefona iletildi (${draft.label}).`
      };
    } catch (e) {
      return { ok: false, message: `SMS gönderilemedi: ${e.message}` };
    }
  }

  function cancelSmsAction() {
    if (!pendingSms) return { ok: false, message: 'İptal edilecek SMS taslağı yok.' };
    pendingSms = null;
    return { ok: true, message: 'SMS taslağı iptal edildi, gönderilmedi.' };
  }

  function toWaPhone(rawPhone) {
    let digits = String(rawPhone || '').replace(/\D/g, '');
    if (digits.startsWith('0') && digits.length === 11) digits = '9' + digits;
    else if (digits.length === 10 && digits.startsWith('5')) digits = '90' + digits;
    return digits;
  }

  async function draftWhatsappAction(params = {}) {
    const target = resolveRecipient(params.to || params.phone || '');
    if (!target) {
      return {
        ok: false,
        message: `"${params.to || ''}" için telefon numarası bulunamadı. Numara yazın veya rehbere ekleyin.`
      };
    }
    const text = String(params.text || params.message || '').trim();
    if (!text) return { ok: false, message: 'WhatsApp mesaj metni boş olamaz.' };

    pendingWhatsapp = {
      id: Date.now(),
      to: target.phone,
      waPhone: toWaPhone(target.phone),
      label: target.label,
      text,
      createdAt: new Date().toISOString()
    };
    return confirmSendWhatsappAction();
  }

  async function confirmSendWhatsappAction() {
    if (!pendingWhatsapp) return { ok: false, message: 'Onay bekleyen bir WhatsApp taslağı yok.' };
    const draft = pendingWhatsapp;
    const wpWebhook = getWebhookUrl();
    if (wpWebhook) {
      try {
        const sep = wpWebhook.includes('?') ? '&' : '?';
        const wpUrl = `${wpWebhook}${sep}type=wp&to=${encodeURIComponent(draft.to)}&msg=${encodeURIComponent(draft.text)}`;
        const resp = await fetch(wpUrl, { method: 'GET', signal: AbortSignal.timeout(12000) });
        if (resp.ok) {
          pendingWhatsapp = null;
          return {
            ok: true,
            type: 'whatsapp_sent',
            message: `WhatsApp mesajı telefondan gönderildi (${draft.label}).`
          };
        }
        if (resp.status === 404) {
          return {
            ok: false,
            message: 'Telefonda MacroDroid "jarvis_wp" makrosu henüz aktif değil (404). MacroDroid\'de "jarvis_wp" adıyla ayrı bir Webhook makrosu oluşturup kaydedin.'
          };
        }
        return { ok: false, message: `MacroDroid WhatsApp HTTP ${resp.status}` };
      } catch (e) {
        return { ok: false, message: `MacroDroid WhatsApp hatası: ${e.message}` };
      }
    }

    const url = `whatsapp://send?phone=${encodeURIComponent(draft.waPhone)}&text=${encodeURIComponent(draft.text)}`;
    try {
      await ctx.launchAndFocusOnDesktop(`cmd.exe /c start "" "${url}"`, 'WhatsApp');
      await new Promise((r) => setTimeout(r, 1100));
      await ctx.psBridge.run('[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")', 3000);
      pendingWhatsapp = null;
      return {
        ok: true,
        type: 'whatsapp_sent',
        message: `WhatsApp mesajı bilgisayardan gönderildi (${draft.label}).`
      };
    } catch (e) {
      return { ok: false, message: `WhatsApp mesajı gönderilemedi: ${e.message}` };
    }
  }

  function cancelWhatsappAction() {
    if (!pendingWhatsapp) return { ok: false, message: 'İptal edilecek WhatsApp taslağı yok.' };
    pendingWhatsapp = null;
    return { ok: true, message: 'WhatsApp taslağı iptal edildi, gönderilmedi.' };
  }

  async function draftCallAction(params = {}) {
    const callUrl = getCallWebhookUrl();
    if (!callUrl) {
      return { ok: false, message: 'Telefon araması için önce Bağlantı sekmesinden MacroDroid Webhook URL ayarlanmalıdır.' };
    }
    const target = resolveRecipient(params.to || params.phone || '');
    if (!target) {
      return { ok: false, message: `"${params.to || ''}" için telefon numarası bulunamadı. Numara söyleyin veya rehbere ekleyin.` };
    }
    pendingCall = { id: Date.now(), to: target.phone, label: target.label, createdAt: new Date().toISOString() };
    return confirmCallAction();
  }

  async function confirmCallAction() {
    if (!pendingCall) return { ok: false, message: 'Onay bekleyen bir arama yok.' };
    const draft = pendingCall;
    const base = getWebhookUrl();
    if (!base) return { ok: false, message: 'MacroDroid Webhook URL ayarlı değil.' };
    try {
      const sep = base.includes('?') ? '&' : '?';
      const url = `${base}${sep}type=call&to=${encodeURIComponent(draft.to)}`;
      const resp = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(12000) });
      if (resp.status === 404) {
        return {
          ok: false,
          message: 'Telefonda MacroDroid "jarvis_call" makrosu henüz aktif değil (404). MacroDroid\'de "jarvis_call" adıyla arama makrosu oluşturup kaydedin.'
        };
      }
      if (!resp.ok) return { ok: false, message: `MacroDroid Arama HTTP ${resp.status}` };
      pendingCall = null;
      return { ok: true, type: 'call_started', message: `📞 Telefon araması başlatıldı: ${draft.label}` };
    } catch (e) {
      return { ok: false, message: `Arama başlatılamadı: ${e.message}` };
    }
  }

  function cancelCallAction() {
    if (!pendingCall) return { ok: false, message: 'İptal edilecek arama yok.' };
    pendingCall = null;
    return { ok: true, message: 'Telefon araması iptal edildi.' };
  }

  async function handleIncomingSms(body = {}) {
    const from = String(body.from || body.sender || 'Bilinmeyen Numara').trim();
    const text = String(body.text || body.msg || body.message || '').trim();
    if (!text) return { ok: false, message: 'Boş SMS' };

    const msg = `📱 *Yeni SMS Geldi!*\n*Kimden:* ${from}\n*Mesaj:* ${text}`;
    broadcastSSE({
      type: 'alert',
      message: msg.replace(/\*/g, ''),
      speak: `${from} numarasından yeni SMS geldi: ${text}`
    });
    const cfg = ctx.getConfig();
    const targetChat = cfg.lastTelegramChatId || cfg.telegramAllowedChatId;
    if (cfg.telegramBotToken && targetChat) {
      await ctx.sendTelegramMessage(targetChat, msg);
    }
    return { ok: true, message: 'Gelen SMS işlendi.' };
  }

  async function run(action, params = {}) {
    switch (action) {
      case 'draft_sms':
        return draftSmsAction(params);
      case 'confirm_send_sms':
        return confirmSendSmsAction();
      case 'cancel_sms':
        return cancelSmsAction();
      case 'draft_whatsapp':
        return draftWhatsappAction(params);
      case 'confirm_send_whatsapp':
        return confirmSendWhatsappAction();
      case 'cancel_whatsapp':
        return cancelWhatsappAction();
      case 'draft_call':
        return draftCallAction(params);
      case 'confirm_call':
        return confirmCallAction();
      case 'cancel_call':
        return cancelCallAction();
      case 'add_sms_contact': {
        const name = String(params.name || '').trim();
        const phone = normalizePhone(params.phone || '');
        if (!name || !phone) return { ok: false, message: 'Geçerli isim ve telefon numarası belirtin.' };
        contacts[name] = phone;
        saveContacts();
        return { ok: true, message: `${name} (${phone}) SMS rehberine kaydedildi.` };
      }
      case 'list_sms_contacts': {
        const list = Object.entries(contacts).map(([n, p]) => `• ${n}: ${p}`).join('\n');
        return {
          ok: true,
          message: list ? 'SMS Rehberi:' : 'SMS rehberi henüz boş.',
          display: list || undefined
        };
      }
    }
    return undefined;
  }

  async function matchFast(lower) {
    if (pendingCall) {
      if (/^(onayla|ara|evet|evet ara|onaylıyorum|tamam ara)$/.test(lower)) {
        const r = await confirmCallAction();
        return { reply: r.message, actionResult: r };
      }
      if (/^(iptal|iptal et|vazgeç|arama|hayır)$/.test(lower)) {
        const r = cancelCallAction();
        return { reply: r.message, actionResult: r };
      }
    }
    if (pendingWhatsapp) {
      if (/^(onayla|gönder|evet|evet gönder|whatsapp gönder|onaylıyorum|tamam gönder)$/.test(lower)) {
        const r = await confirmSendWhatsappAction();
        return { reply: r.message, actionResult: r };
      }
      if (/^(iptal|iptal et|vazgeç|gönderme|hayır)$/.test(lower)) {
        const r = cancelWhatsappAction();
        return { reply: r.message, actionResult: r };
      }
    }
    if (pendingSms) {
      if (/^(onayla|gönder|evet|evet gönder|sms gönder|onaylıyorum|tamam gönder)$/.test(lower)) {
        const r = await confirmSendSmsAction();
        return { reply: r.message, actionResult: r };
      }
      if (/^(iptal|iptal et|vazgeç|gönderme|hayır)$/.test(lower)) {
        const r = cancelSmsAction();
        return { reply: r.message, actionResult: r };
      }
    }
    if (/^(sms rehberi|telefon rehberi|rehberi göster)$/.test(lower)) {
      const r = await run('list_sms_contacts');
      return { reply: r.display ? `${r.message}\n\n${r.display}` : r.message, actionResult: r };
    }
    // Örn: "annemi ara" / "babama telefon aç" / "05551234567 numarasını ara"
    const callMatch = lower.match(/^(.+?)\s+(?:numarasını\s+)?(?:telefonla\s+)?(?:ara|telefon aç|arama yap)\w*$/);
    if (callMatch && !/(hava|dosya|google|youtube)/.test(lower)) {
      const target = findContactInText(callMatch[1]);
      if (target) {
        const r = draftCallAction({ to: target.phone });
        return { reply: r.display ? `${r.message}\n\n${r.display}` : r.message, actionResult: r };
      }
    }
    // Örn: "istanbul hava durumunu sevgilime whatsaptan gönder" veya "bulunduğum konumu sevgilime whatsaptan gönder"
    if (/(whats?ap+|watsap|\bwp\b|\bsms\b)/.test(lower) && /(hava\s+durum|bulunduğum\s+konum|konumumu)/.test(lower) && /(gönder|at|yolla|yaz)/.test(lower) && typeof ctx.getWeather === 'function') {
      const target = findContactInText(lower);
      if (target) {
        const requestedCity = typeof ctx.detectCity === 'function' ? ctx.detectCity(lower) : '';
        const wRaw = await ctx.getWeather(requestedCity);
        if (!wRaw) return { reply: 'Anlık hava durumu bilgisi şu an alınamadı.', actionResult: { ok: false } };
        const cleanW = wRaw.replace(/[^\p{L}\p{N}\s.,:°+\-()]/gu, '').replace(/\s+/g, ' ').trim();
        const isOnlyLoc = /(bulunduğum\s+konum|konumumu)/.test(lower) && !/hava\s+durum/.test(lower) && !requestedCity;
        const geoLabel = ctx.getConfig().geoLabel;
        const geoCoords = ctx.getConfig().geoCoords;
        const mapsLink = geoCoords ? ` https://maps.google.com/?q=${geoCoords}` : '';
        const cityOnly = (!requestedCity && geoLabel) ? geoLabel : cleanW.split(':')[0].trim();
        const msgText = isOnlyLoc
          ? `Şu an bulunduğum konum: ${cityOnly}${mapsLink} (Hava durumu: ${cleanW})`
          : requestedCity
            ? `${requestedCity} hava durumu: ${cleanW}`
            : `${geoLabel ? geoLabel + ' konumunda' : 'Şu an bulunduğum konumda'} hava durumu: ${cleanW}`;
        const isSms = /\bsms\b/.test(lower) && !/(whats?ap+|watsap|\bwp\b)/.test(lower);
        const r = await (isSms ? draftSmsAction : draftWhatsappAction)({ to: target.phone, text: msgText });
        return { reply: r.display ? `${r.message}\n\n${r.display}` : r.message, actionResult: r };
      }
    }
    // Örn: "ilaydama whatsaptan naber iloşum yaz gönder" (yalnızca alıcı çözülebiliyorsa hızlı yakala, yoksa Gemini'ye bırak)
    const waMatch = lower.match(/^(.+?)\s+(?:(?:whats?ap+|watsap|wp)(?:'?[td][ae]n|\s+üzerinden)?)\s+(.+)$/);
    if (waMatch) {
      const rawTo = waMatch[1].trim();
      const stripped = rawTo.replace(/(?:'?[ae]|'?n[ae]|'?y[ae]|'?ma|'?me)$/, '').trim();
      const msgText = waMatch[2].replace(/(?:\s+(?:diye|şeklinde))?(?:\s+(?:yaz|gönder|at|yolla))+\s*$/g, '').trim();
      const resolved = resolveRecipient(rawTo) || (stripped && resolveRecipient(stripped)) || (stripped.length > 2 && resolveRecipient(stripped.slice(0, -1)));
      if (msgText && resolved) {
        const r = await draftWhatsappAction({ to: resolved.phone, text: msgText });
        return { reply: r.display ? `${r.message}\n\n${r.display}` : r.message, actionResult: r };
      }
    }
    // Örn: "babama 10 dakikaya evdeyim diye sms at" (yalnızca alıcı çözülebiliyorsa hızlı yakala)
    const m = lower.match(/^(.+?)\s+(?:numarasına\s+)?(.+?)\s+diye\s+sms\s*(?:at|gönder|yolla|yaz)\w*$/);
    if (m) {
      const to = m[1].replace(/(?:'?[ae]|'?n[ae]|'?y[ae])$/, '').trim();
      const resolved = resolveRecipient(m[1].trim()) || resolveRecipient(to);
      if (resolved) {
        const r = await draftSmsAction({ to: resolved.phone, text: m[2].trim() });
        return { reply: r.display ? `${r.message}\n\n${r.display}` : r.message, actionResult: r };
      }
    }
    // Örn: "telefondan spotify aç"
    if (/(telefon(um)?(dan|da)|telden).*(spotify|müzik)|(spotify|müzik).*(telefon(um)?(dan|da)|telden)/.test(lower)) {
      const base = getWebhookUrl();
      if (!base) return { reply: 'MacroDroid Webhook URL ayarlı değil.', actionResult: { ok: false } };
      const sep = base.includes('?') ? '&' : '?';
      const url = `${base}${sep}type=spotify`;
      try {
        const resp = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10000) });
        if (resp.status === 404) return { reply: 'Telefonda MacroDroid webhook aktif değil (404).', actionResult: { ok: false } };
        return { reply: resp.ok ? 'Telefonunuzda Spotify açılıyor.' : `MacroDroid HTTP ${resp.status}`, actionResult: { ok: resp.ok } };
      } catch (e) {
        return { reply: `Telefonda Spotify açılamadı: ${e.message}`, actionResult: { ok: false } };
      }
    }
    // Örn: "telefonda masaüstüne dön" / "telefondan ana ekrana dön" / "telefonda ana menüye dön"
    if (/(telefon(um)?(dan|da)|telden).*(masaüst|ana ekran|ana menü|menüye dön|uygulamadan çık)|(masaüstüne dön|ana ekrana dön|ana menüye dön)/.test(lower) && !/bilgisayar/.test(lower)) {
      const base = getWebhookUrl();
      if (!base) return { reply: 'MacroDroid Webhook URL ayarlı değil.', actionResult: { ok: false } };
      const sep = base.includes('?') ? '&' : '?';
      const url = `${base}${sep}type=home`;
      try {
        const resp = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10000) });
        if (resp.status === 404) return { reply: 'Telefonda MacroDroid webhook aktif değil (404).', actionResult: { ok: false } };
        return { reply: resp.ok ? 'Telefonunuz ana ekrana döndürülüyor.' : `MacroDroid HTTP ${resp.status}`, actionResult: { ok: resp.ok } };
      } catch (e) {
        return { reply: `Telefon ana ekrana döndürülemedi: ${e.message}`, actionResult: { ok: false } };
      }
    }
    if (/\bsms\s*(?:at|gönder|yolla)\b/.test(lower) && !getWebhookUrl()) {
      return {
        reply: 'Android MacroDroid Webhook URL henüz ayarlanmamış. Bağlantı sekmesinden MacroDroid Webhook linkini ve SMS Rehberini kaydedip sunucuyu yeniden başlatın.',
        actionResult: { ok: false, message: 'MacroDroid Webhook URL eksik.' }
      };
    }
    return null;
  }

  function findContactInText(lowerText) {
    const t = String(lowerText || '').toLocaleLowerCase('tr-TR');
    for (const [name, phone] of Object.entries(contacts)) {
      const k = name.toLocaleLowerCase('tr-TR');
      if (t.includes(k) || (k.length > 3 && t.includes(k.slice(0, -1)))) {
        return { phone, label: `${name} (${phone})` };
      }
    }
    const phoneMatch = t.match(/(\+?\d[\d\s()-]{8,14}\d)/);
    if (phoneMatch) {
      const p = normalizePhone(phoneMatch[1]);
      if (p) return { phone: p, label: p };
    }
    return null;
  }

  const promptSection = `
- Android telefon üzerinden doğrudan SMS gönderme (onay beklemeden anında gönderir): {"name": "draft_sms", "params": {"to": "telefon numarası veya rehberdeki kişi adı", "text": "SMS mesaj metni"}}
- WhatsApp üzerinden doğrudan mesaj gönderme (onay beklemeden anında gönderir): {"name": "draft_whatsapp", "params": {"to": "telefon numarası veya rehberdeki kişi adı", "text": "WhatsApp mesaj metni"}}
- Telefon araması başlatma (onay beklemeden anında arar): {"name": "draft_call", "params": {"to": "telefon numarası veya rehberdeki kişi adı"}}
- SMS rehberine kişi ekleme: {"name": "add_sms_contact", "params": {"name": "Kişi Adı", "phone": "05..."}}`;

  return {
    run,
    matchFast,
    handleIncomingSms,
    sendViaMacroDroid,
    getContactsText,
    setContactsFromText,
    promptSection
  };
};
