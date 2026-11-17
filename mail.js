// ============================================================================
// J.A.R.V.I.S. — GMAIL IMAP + SMTP MODÜLÜ
//  - Okunmamış / son mailleri okuma ve özetleme
//  - Yeni gelen maillerde Telegram + HUD bildirimi
//  - Onay mekanizmalı mail taslağı ve SMTP gönderimi
// ============================================================================
const fs = require('fs');
const path = require('path');

let ImapFlow = null;
let simpleParser = null;
let nodemailer = null;
try { ({ ImapFlow } = require('imapflow')); } catch (e) {}
try { ({ simpleParser } = require('mailparser')); } catch (e) {}
try { nodemailer = require('nodemailer'); } catch (e) {}

module.exports = function createMailModule(ctx) {
  const { DATA_DIR, broadcastSSE } = ctx;
  const STATE_FILE = path.join(DATA_DIR, 'mail_state.json');

  let pendingDraft = null;
  let polling = false;
  let mailState = { lastNotifiedUid: 0 };
  try {
    if (fs.existsSync(STATE_FILE)) {
      mailState = { ...mailState, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
    }
  } catch (e) {}

  const saveMailState = () => {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(mailState, null, 2), 'utf8'); } catch (e) {}
  };

  function getCreds() {
    const cfg = ctx.getConfig();
    const user = String(cfg.gmailAddress || '').trim();
    const pass = String(cfg.gmailAppPassword || '').replace(/\s+/g, '').trim();
    return { user, pass, configured: Boolean(user && pass) };
  }

  function createImapClient(user, pass) {
    if (!ImapFlow) throw new Error('imapflow paketi yüklü değil.');
    return new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: { user, pass },
      logger: false,
      emitLogs: false
    });
  }

  async function withImap(fn) {
    const { user, pass, configured } = getCreds();
    if (!configured) {
      throw new Error('Gmail adresi ve Uygulama Şifresi ayarlanmamış. Ayarlar sekmesinden girin.');
    }
    const client = createImapClient(user, pass);
    await client.connect();
    try {
      return await fn(client, user);
    } finally {
      try { await client.logout(); } catch (e) { try { client.close(); } catch (_) {} }
    }
  }

  async function summarizeWithGemini(promptText) {
    const cfg = ctx.getConfig();
    if (!cfg.geminiApiKey) return null;
    const models = ['gemini-3.5-flash-lite', 'gemini-3.5-flash'];
    for (const m of models) {
      try {
        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${cfg.geminiApiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(12000),
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: promptText }] }],
              generationConfig: { temperature: 0.3, maxOutputTokens: 600 }
            })
          }
        );
        if (!resp.ok) continue;
        const data = await resp.json();
        const txt = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
        if (txt) return txt;
      } catch (e) {}
    }
    return null;
  }

  async function parseMessage(rawSource) {
    if (!simpleParser) {
      const raw = Buffer.isBuffer(rawSource) ? rawSource.toString('utf8') : String(rawSource || '');
      return { from: 'Bilinmiyor', subject: '(Konusuz)', text: raw.slice(0, 400), date: new Date() };
    }
    const parsed = await simpleParser(rawSource);
    const fromObj = parsed.from?.value?.[0];
    const fromStr = fromObj
      ? (fromObj.name ? `${fromObj.name} <${fromObj.address}>` : fromObj.address)
      : (parsed.from?.text || 'Bilinmiyor');
    const cleanBody = String(parsed.text || '')
      .replace(/\r/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return {
      from: fromStr,
      subject: parsed.subject || '(Konusuz)',
      date: parsed.date || new Date(),
      text: cleanBody
    };
  }

  async function fetchEmails({ unseenOnly = true, limit = 6, query = '' } = {}) {
    return withImap(async (client) => {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const criteria = unseenOnly ? { seen: false } : { all: true };
        let uids = await client.search(criteria, { uid: true });
        if (!Array.isArray(uids)) uids = [];
        const totalMatching = uids.length;
        if (!uids.length) return { totalMatching: 0, emails: [] };

        // En yeni mailleri al (sondan başa)
        const targetUids = uids.slice(-Math.min(20, Math.max(limit * 2, 10))).reverse();
        const emails = [];
        for await (const msg of client.fetch(targetUids, { uid: true, flags: true, source: true }, { uid: true })) {
          const p = await parseMessage(msg.source);
          const q = String(query || '').toLocaleLowerCase('tr-TR').trim();
          if (q) {
            const hay = `${p.from} ${p.subject} ${p.text}`.toLocaleLowerCase('tr-TR');
            if (!hay.includes(q)) continue;
          }
          emails.push({
            uid: msg.uid,
            seen: msg.flags ? msg.flags.has('\\Seen') : false,
            from: p.from,
            subject: p.subject,
            date: p.date,
            snippet: p.text.slice(0, 260).replace(/\s+/g, ' ').trim(),
            body: p.text.slice(0, 1500)
          });
        }
        emails.sort((a, b) => b.uid - a.uid);
        return { totalMatching, emails: emails.slice(0, limit) };
      } finally {
        lock.release();
      }
    });
  }

  function formatImapError(e) {
    const raw = [e?.responseText, e?.message].filter(Boolean).join(' ');
    if (/Application-specific password required/i.test(raw)) {
      return 'Google normal Gmail şifresini kabul etmiyor — 16 haneli "Uygulama Şifresi" (App Password) gerekiyor. Google Hesabınızda 2 Adımlı Doğrulama\'yı açıp myaccount.google.com/apppasswords adresinden 16 harfli şifre oluşturun.';
    }
    if (/Username and Password not accepted|Invalid credentials/i.test(raw) || e?.authenticationFailed) {
      return 'Gmail adresi veya 16 haneli Uygulama Şifresi hatalı. Lütfen kontrol edin.';
    }
    return `Gmail bağlantı hatası: ${raw || 'Bilinmeyen hata'}`;
  }

  async function testConnection() {
    if (!ImapFlow) return { ok: false, message: 'imapflow paketi henüz hazır değil.' };
    try {
      const info = await withImap(async (client) => {
        const status = await client.status('INBOX', { messages: true, unseen: true });
        return { messages: status.messages || 0, unseen: status.unseen || 0 };
      });
      return {
        ok: true,
        ...info,
        message: `Gmail bağlantısı başarılı! Gelen kutusunda ${info.messages} mail (${info.unseen} okunmamış) var.`
      };
    } catch (e) {
      return { ok: false, message: formatImapError(e) };
    }
  }

  async function checkMailAction(params = {}) {
    try {
      const unseenOnly = params.unseenOnly !== false;
      const limit = Math.min(10, Math.max(1, Number(params.limit) || 5));
      const query = String(params.query || '').trim();
      const summarize = Boolean(params.summarize);

      const res = await fetchEmails({ unseenOnly: query ? false : unseenOnly, limit, query });
      if (!res.emails.length) {
        return {
          ok: true,
          message: query
            ? `"${query}" ile eşleşen mail bulunamadı.`
            : (unseenOnly ? 'Okunmamış yeni mailiniz yok.' : 'Gelen kutunuz boş.')
        };
      }

      const listText = res.emails
        .map((m, i) => {
          const d = new Date(m.date).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
          return `${i + 1}. ${m.subject}\n   Kimden: ${m.from} (${d})\n   Özet: ${m.snippet || '(İçerik yok)'}`;
        })
        .join('\n\n');

      if (summarize) {
        const aiSummary = await summarizeWithGemini(
          `Aşağıdaki e-postaları kullanıcıya (${ctx.getConfig().userName}) kısa, net Türkçe maddelerle özetle:\n\n${listText}`
        );
        if (aiSummary) {
          return {
            ok: true,
            message: `${res.totalMatching} ${unseenOnly && !query ? 'okunmamış ' : ''}mail özetlendi.`,
            display: aiSummary
          };
        }
      }

      return {
        ok: true,
        message: query
          ? `"${query}" için ${res.emails.length} mail bulundu.`
          : `${res.totalMatching} okunmamış mailden son ${res.emails.length} tanesi:`,
        display: listText
      };
    } catch (e) {
      return { ok: false, message: formatImapError(e) };
    }
  }

  async function draftMailAction(params = {}) {
    const { configured } = getCreds();
    if (!configured) {
      return { ok: false, message: 'Mail göndermek için önce Ayarlar sekmesinden Gmail adresi ve Uygulama Şifresini kaydedin.' };
    }
    const to = String(params.to || '').trim();
    const subject = String(params.subject || 'Konusuz').trim();
    const body = String(params.body || '').trim();
    if (!to || !to.includes('@')) {
      return { ok: false, message: 'Geçerli bir alıcı e-posta adresi belirtilmedi.' };
    }
    if (!body) {
      return { ok: false, message: 'Mail içeriği boş olamaz.' };
    }
    pendingDraft = {
      id: Date.now(),
      to,
      subject,
      body,
      createdAt: new Date().toISOString()
    };
    return confirmSendMailAction();
  }

  async function confirmSendMailAction() {
    if (!pendingDraft) {
      return { ok: false, message: 'Onay bekleyen bir mail taslağı yok.' };
    }
    const { user, pass, configured } = getCreds();
    if (!configured) return { ok: false, message: 'Gmail bilgileri eksik.' };
    if (!nodemailer) return { ok: false, message: 'nodemailer paketi yüklü değil.' };

    const draft = pendingDraft;
    try {
      const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: { user, pass }
      });
      await transporter.sendMail({
        from: user,
        to: draft.to,
        subject: draft.subject,
        text: draft.body
      });
      pendingDraft = null;
      return {
        ok: true,
        type: 'mail_sent',
        message: `E-posta başarıyla gönderildi (${draft.to} — "${draft.subject}").`
      };
    } catch (e) {
      return { ok: false, message: `Mail gönderilemedi: ${e.message}` };
    }
  }

  function cancelMailAction() {
    if (!pendingDraft) return { ok: false, message: 'İptal edilecek mail taslağı yok.' };
    pendingDraft = null;
    return { ok: true, message: 'Mail taslağı iptal edildi, gönderilmedi.' };
  }

  // Yeni gelen okunmamış mailleri arka planda izle ve Telegram + HUD'a bildir
  async function pollInbox() {
    const cfg = ctx.getConfig();
    if (polling || cfg.mailNotifyEnabled === false) return;
    const { configured } = getCreds();
    if (!configured || !ImapFlow) return;

    polling = true;
    try {
      await withImap(async (client) => {
        const lock = await client.getMailboxLock('INBOX');
        try {
          let uids = await client.search({ seen: false }, { uid: true });
          if (!Array.isArray(uids) || !uids.length) return;
          const maxUid = Math.max(...uids);

          // İlk çalıştırmada mevcut okunmamışları bildirim olarak yağdırma, referans noktasını al
          if (!mailState.lastNotifiedUid) {
            mailState.lastNotifiedUid = maxUid;
            saveMailState();
            return;
          }

          const newUids = uids.filter((u) => u > mailState.lastNotifiedUid).slice(-3);
          if (!newUids.length) return;

          for await (const msg of client.fetch(newUids, { uid: true, source: true }, { uid: true })) {
            const p = await parseMessage(msg.source);
            const snippet = p.text.slice(0, 180).replace(/\s+/g, ' ').trim();
            const alertText = `📩 *Yeni E-posta!*\n*Kimden:* ${p.from}\n*Konu:* ${p.subject}${snippet ? `\n*Özet:* ${snippet}` : ''}`;
            broadcastSSE({
              type: 'alert',
              message: alertText.replace(/\*/g, ''),
              speak: `${p.from.split('<')[0].trim()} kişisinden yeni e-posta geldi. Konu: ${p.subject}`
            });
            const targetChat = cfg.lastTelegramChatId || cfg.telegramAllowedChatId;
            if (cfg.telegramBotToken && targetChat) {
              await ctx.sendTelegramMessage(targetChat, alertText);
            }
          }
          mailState.lastNotifiedUid = maxUid;
          saveMailState();
        } finally {
          lock.release();
        }
      });
    } catch (e) {
      // Ağ veya geçici IMAP hatasında sessizce bir sonraki döngüyü bekle
    } finally {
      polling = false;
    }
  }

  setInterval(() => { pollInbox().catch(() => {}); }, 60000);
  setTimeout(() => { pollInbox().catch(() => {}); }, 8000);

  async function run(action, params = {}) {
    switch (action) {
      case 'check_mail':
        return checkMailAction(params);
      case 'draft_mail':
        return draftMailAction(params);
      case 'confirm_send_mail':
        return confirmSendMailAction();
      case 'cancel_mail':
        return cancelMailAction();
    }
    return undefined;
  }

  async function matchFast(lower) {
    // Bekleyen mail taslağı varken onay / iptal komutlarını anında yakala
    if (pendingDraft) {
      if (/^(onayla|gönder|evet|evet gönder|maili gönder|onaylıyorum|tamam gönder)$/.test(lower)) {
        const r = await confirmSendMailAction();
        return { reply: r.message, actionResult: r };
      }
      if (/^(iptal|iptal et|vazgeç|gönderme|hayır)$/.test(lower)) {
        const r = cancelMailAction();
        return { reply: r.message, actionResult: r };
      }
    }

    if (/^(mail(im)?i kontrol et|maillerimi kontrol et|yeni mail var mı|okunmamış mailler(im)?|okunmamış e-?postalar|gelen kutusu|mail var mı)$/.test(lower)) {
      const r = await checkMailAction({ unseenOnly: true, limit: 5, summarize: false });
      return { reply: r.display ? `${r.message}\n\n${r.display}` : r.message, actionResult: r };
    }
    if (/^(maillerimi özetle|okunmamış mailleri özetle|mail özeti|e-?postalarımı özetle)$/.test(lower)) {
      const r = await checkMailAction({ unseenOnly: true, limit: 6, summarize: true });
      return { reply: r.display ? `${r.message}\n\n${r.display}` : r.message, actionResult: r };
    }
    if (/^(son mailleri (göster|oku|listele)|son e-?postalar)$/.test(lower)) {
      const r = await checkMailAction({ unseenOnly: false, limit: 5, summarize: false });
      return { reply: r.display ? `${r.message}\n\n${r.display}` : r.message, actionResult: r };
    }
    return null;
  }

  const promptSection = `
- Gmail okuma / kontrol / arama / özetleme: {"name": "check_mail", "params": {"unseenOnly": true/false, "limit": 5, "query": "(isteğe bağlı gönderen/konu araması)", "summarize": true/false}}
- Doğrudan e-posta gönderme (onay beklemeden anında gönderir): {"name": "draft_mail", "params": {"to": "alici@ornek.com", "subject": "Konu", "body": "Mail metni"}}`;

  return { run, matchFast, testConnection, pollInbox, promptSection };
};
