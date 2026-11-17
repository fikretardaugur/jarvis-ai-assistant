# J.A.R.V.I.S. Mark VII — Yapay Zekâ Bilgisayar, Telefon & Bulut Asistanı

Windows bilgisayarınızı, Android/iOS telefonunuzu, Gmail'inizi ve Telegram'ınızı tek bir sesli ve yazılı arayüzde birleştiren kişisel yapay zekâ asistanı.

> **Güvenlik Notu:** `data/` klasörü `.gitignore` ile gizlenmiştir. Kendi API anahtarlarınız, telefon numaralarınız ve şifreleriniz GitHub'a **yüklenmez**.

---

## Özellikler
- **Web HUD (`http://localhost:7777`):** Türkçe nöral ses (`msedge-tts`), *"Hey Jarvis"* uyandırma, ses izi (speaker verification) kilidi, canlı ekran akışı ve uzaktan kontrol.
- **Tam Yetki PC Kontrolü:** Uygulama açma/kapatma (`Chrome`, `Spotify`, `Netflix` vb.), ses/parlaklık, pencere yönetimi, dosya arama/düzenleme, ekran/webcam analizi ve PowerShell terminali.
- **Günlük Brifing (`rapor ver` / `günaydın`):** Bulunduğunuz şehrin hava durumu, döviz kuru (USD/EUR) ve güncel haberleri tablo + sesli sunum olarak verir.
- **Gmail Entegrasyonu:** Okunmamış mailleri listeleme/özetleme, yeni mailde bildirim ve e-posta gönderme.
- **7/24 Bulut + PC Köprüsü (`jarvis-cloud`):** Bilgisayar kapalıyken bile Telegram, telefon sesli komutu, SMS, arama, rapor ve mail çalışır; bilgisayar açıkken dışarıdan PC komutları da iletilir.

---

## 1. Bilgisayar Kurulumu (Windows)

**Gereksinimler:** Node.js 20+

```bash
npm install
npm start
```
Veya doğrudan **`Baslat-JARVIS.bat`** dosyasına çift tıklayın (canlı ekran görüntüsü yakalama için `.bat` üzerinden başlatmanız önerilir).

Tarayıcıda `http://localhost:7777` açılır. **Bağlantı** sekmesinden şu alanları doldurup kaydedin *(veya `config.example.json` dosyasını `data/config.json` olarak kopyalayın)*:
- **Gemini API Key:** [Google AI Studio](https://aistudio.google.com/) üzerinden ücretsiz alın.
- **Telegram Bot Token:** Telegram'da `@BotFather` üzerinden yeni bot oluşturup alın.
- **Gmail + Uygulama Şifresi:** Google Hesabınızda 2 Adımlı Doğrulama açıkken [App Passwords](https://myaccount.google.com/apppasswords) sayfasından 16 haneli şifre üretin.
- **Hava Durumu Şehri:** Bulunduğunuz il (örn. `İstanbul`, `Ankara`, `Mersin`).

---

## 2. 7/24 Bulut Kurulumu (Render.com — İsteğe Bağlı)

Bilgisayar kapalıyken de Telegram ve telefon sesli kontrolünün çalışması için `jarvis-cloud/` klasörünü ayrı bir repo olarak GitHub'a yükleyip [Render.com](https://render.com) → **New + → Blueprint** ile deploy edebilirsiniz.
Render Environment Variables kısmına kendi anahtarlarınızı girin (`GEMINI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `SMS_WEBHOOK_URL`, `JARVIS_CONTACTS="Anne=05550000000,Arkadaş=05551111111"`).

---

## 3. Android Kurulumu (MacroDroid)

Ücretsiz MacroDroid'deki 5 makro sınırına takılmamak için tüm telefon işlemleri **2 makro** ile çözülür:

### Makro 1: `JARVIS TELEFON` (Gelen Webhook Eylemleri)
- **Tetikleyici:** `Bağlanabilirlik` → **Webhook (URL)** → tanımlayıcı: `jarvis_sms`
  *(Size verilen `https://trigger.macrodroid.com/.../jarvis_sms` adresini JARVIS Bağlantı sekmesine ve Render `SMS_WEBHOOK_URL` alanına yapıştırın.)*
- **Yerel Değişkenler:** `type` (**Dize**) ve `msg` (**Sözlük**)
- **Eylemler (`Koşullar → Eğer cümleciği` ile 5 blok):**
  1. `type = sms` → **SMS Gönder** (Numara: `{lv=msg[to]}`, Mesaj: `{lv=msg[msg]}`)
  2. `type = wp` → **WhatsApp Gönder** (Numara: `+9{lv=msg[to]}`, Mesaj: `{lv=msg[msg]}`) *(Ekran kilitsiz + Erişilebilirlik izni açık olmalı)*
  3. `type = call` → **Telefon Araması Yap** (Numara: `{lv=msg[to]}`)
  4. `type = spotify` → **Uygulama Başlat (Spotify)**
  5. `type = home` → **Ana Ekrana Git**

### Makro 2: `JARVIS ARABA` (Eller Serbest Sesli Komut)
- **Tetikleyici:** `Ses Düğmesine Uzun Basma` veya `Yüzen Düğme`
- **Yerel Değişkenler:** `voice` (**Dize**) ve `jarvis_reply` (**Dize**)
- **Eylemler:**
  1. **Ses Girişi** → sonucu `voice` değişkenine kaydet
  2. **HTTP İsteği (GET):**
     - URL: `https://<render-adresiniz>/api/voice-cmd?key=<URL_KODLU_JARVIS_SECRET>&q={lv=voice}`
     - **Tamamlanana kadar sonraki eylemleri engelle** işaretli
     - **Dize değişkenine HTTP yanıtını kaydet:** `jarvis_reply`
  3. **Metni Konuş** → `{lv=jarvis_reply}`

---

## 4. iOS Kurulumu (Apple Kestirmeler / Shortcuts)

iPhone cihazlarda MacroDroid yerine yerleşik **Kestirmeler (Shortcuts)** uygulaması kullanılır:

1. **Kestirmeler** uygulamasını açın → **`+`** ile yeni kestirme oluşturun, adını **`Jarvis`** koyun *(böylece "Hey Siri, Jarvis" diyerek çalıştırabilirsiniz)*.
2. Şu 3 eylemi sırayla ekleyin:
   - **Metni Dikte Et** *(Dictate Text — Türkçe)*
   - **URL İçeriğini Al** *(Get Contents of URL)* →
     `https://<render-adresiniz>/api/voice-cmd?key=<URL_KODLU_JARVIS_SECRET>&q=[Dikte Edilen Metin]`
   - **Metni Seslendir** *(Speak Text)* → `[URL İçerikleri]`
3. İsterseniz iPhone **Ayarlar → Eylem Düğmesi / Arkaya Dokunma** ile bu kestirmeyi tek dokunuşa atayabilirsiniz.

> **iOS Notu:** Apple, telefon kilitliyken dışarıdan gelen internet istekleriyle arka planda SMS atmaya veya arama başlatmaya izin vermez. Yukarıdaki kestirme ile rapor alma, mail kontrolü, hatırlatıcı ve açık Windows bilgisayarınızı yönetme özelliklerinin tümünü kullanabilirsiniz.
