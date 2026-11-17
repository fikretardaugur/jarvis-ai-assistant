const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, exec } = require('child_process');
const crypto = require('crypto');
let MsEdgeTTS = null;
let OUTPUT_FORMAT = null;
try {
  ({ MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts'));
} catch (e) {}

const PORT = process.env.PORT || 7777;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(os.homedir(), 'Downloads', 'JARVIS_Transfers');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const NOTES_FILE = path.join(DATA_DIR, 'notes.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

// Voice Profiles (Studio-Quality Neural Turkish Voices)
const VOICE_PROFILES = {
  'jarvis-ahmet': {
    label: '🎙️ J.A.R.V.I.S. (Karizmatik Erkek — Sinematik)',
    voice: 'tr-TR-AhmetNeural',
    rate: '+6%',
    pitch: '-4Hz'
  },
  'jarvis-deep': {
    label: '🦾 Mark VII Zırh Sesi (Kalın & Otoriter Erkek)',
    voice: 'tr-TR-AhmetNeural',
    rate: '+2%',
    pitch: '-12Hz'
  },
  'jarvis-fast': {
    label: '⚡ Taktiksel Asistan (Hızlı & Dinamik Erkek)',
    voice: 'tr-TR-AhmetNeural',
    rate: '+18%',
    pitch: '-2Hz'
  },
  'friday-emel': {
    label: '👩‍💻 F.R.I.D.A.Y. (Doğal Kadın Asistan Sesi)',
    voice: 'tr-TR-EmelNeural',
    rate: '+8%',
    pitch: '+0Hz'
  },
  'friday-soft': {
    label: '✨ F.R.I.D.A.Y. Sakin (Yumuşak Kadın Sesi)',
    voice: 'tr-TR-EmelNeural',
    rate: '+0%',
    pitch: '-3Hz'
  }
};

// Default Configuration (with Gemini 3.5 Flash Lite default for <1.2s latency)
let config = {
  aiProvider: 'hybrid',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: 'gemini-3.5-flash-lite',
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'llama3.2',
  pinCode: '',
  telegramBotToken: '',
  telegramAllowedChatId: '',
  gmailAddress: '',
  gmailAppPassword: '',
  mailNotifyEnabled: true,
  smsWebhookUrl: '',
  weatherCity: '',
  geoCoords: '',
  geoLabel: '',
  cloudUrl: '',
  cloudSecret: '',
  userName: 'Efendim',
  voiceEnabled: true,
  voiceProfile: 'jarvis-ahmet',
  voicePrintEnabled: false,
  voicePrint: null,
  sfxEnabled: true
};

if (fs.existsSync(CONFIG_FILE)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    config = { ...config, ...loaded };
    if (config.geminiModel === 'gemini-2.5-flash' || config.geminiModel === 'gemini-3.5-flash') {
      config.geminiModel = 'gemini-3.5-flash-lite';
    }
  } catch (e) {}
}
saveConfig();

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {}
}

let notes = [];
if (fs.existsSync(NOTES_FILE)) {
  try {
    notes = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
  } catch (e) {}
} else {
  notes = [
    {
      id: '1',
      text: 'J.A.R.V.I.S. Mark VII sistemi aktif edildi. Gemini AI beyni ve telefondan tam kontrol hazır.',
      category: 'Sistem',
      done: false,
      createdAt: new Date().toISOString()
    }
  ];
  saveNotes();
}

function saveNotes() {
  try {
    fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2), 'utf8');
  } catch (e) {}
}

let chatHistory = [];
if (fs.existsSync(HISTORY_FILE)) {
  try {
    chatHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')).slice(-40);
  } catch (e) {}
}

function clearChatHistory() {
  chatHistory = [];
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify([], null, 2), 'utf8');
  } catch (e) {}
  if (typeof broadcastSSE === 'function') {
    broadcastSSE({ type: 'chat_cleared' });
  }
}

function appendHistory(role, text, action = null) {
  if (action && action.type === 'chat_cleared') {
    clearChatHistory();
    return;
  }
  chatHistory.push({
    id: crypto.randomUUID(),
    role,
    text,
    action: action && action.type === 'screenshot' ? { type: 'screenshot_taken' } : action,
    timestamp: new Date().toISOString()
  });
  if (chatHistory.length > 50) chatHistory = chatHistory.slice(-50);
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(chatHistory, null, 2), 'utf8');
  } catch (e) {}
}

function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push({ name, address: iface.address });
      }
    }
  }
  return ips;
}

// ============================================================================
// PERSISTENT POWERSHELL NATIVE BRIDGE (Atomic Single-Line Base64 Execution)
// ============================================================================
class PowerShellBridge {
  constructor() {
    this.ps = null;
    this.queue = new Map();
    this.buffer = '';
    this.ready = false;
    this.lastTelemetry = {
      cpu: 5,
      ramUsedGB: 0,
      ramTotalGB: Math.round((os.totalmem() / 1073741824) * 10) / 10,
      ramPercent: 0,
      diskUsedGB: 0,
      diskTotalGB: 0,
      diskPercent: 0,
      batteryPercent: 100,
      isCharging: true,
      volume: 50,
      muted: false,
      activeWindow: 'Masaüstü',
      uptimeHours: Math.round((os.uptime() / 3600) * 10) / 10,
      hostname: os.hostname(),
      platform: `Windows (${os.release()})`
    };
    this.init();
  }

  init() {
    this.ps = spawn('powershell.exe', [
      '-NoProfile',
      '-NoLogo',
      '-ExecutionPolicy', 'Bypass',
      '-Command', '-'
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    this.ps.stdin.setDefaultEncoding('utf8');

    this.ps.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      let idx;
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        const markerIdx = line.indexOf('@@JARVIS@@');
        if (markerIdx !== -1) {
          try {
            const payload = JSON.parse(line.slice(markerIdx + 10));
            const req = this.queue.get(payload.id);
            if (req) {
              clearTimeout(req.timer);
              this.queue.delete(payload.id);
              if (payload.error) req.reject(new Error(payload.error));
              else req.resolve(payload.data);
            }
          } catch (e) {}
        }
      }
    });

    this.ps.on('exit', () => {
      this.ready = false;
      setTimeout(() => this.init(), 1500);
    });

    const bootstrapScript = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Ekran ölçekleme (%125, %150...) altında TAM çözünürlükte ekran yakalamak için DPI farkındalığı (formlar yüklenmeden ÖNCE)
$dpiCode = @"
using System;
using System.Runtime.InteropServices;
public class JarvisDpi {
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
"@
try { Add-Type -TypeDefinition $dpiCode -Language CSharp -ErrorAction SilentlyContinue } catch {}
try { [JarvisDpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch { try { [JarvisDpi]::SetProcessDPIAware() | Out-Null } catch {} }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$csharpCode = @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public class JarvisWin32 {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    public static extern bool LockWorkStation();

    public static string GetActiveWindowTitle() {
        const int nChars = 512;
        StringBuilder Buff = new StringBuilder(nChars);
        IntPtr handle = GetForegroundWindow();
        if (GetWindowText(handle, Buff, nChars) > 0) {
            return Buff.ToString();
        }
        return "Masaüstü";
    }

    public static void PressKey(byte vk) {
        keybd_event(vk, 0, 0, UIntPtr.Zero);
        keybd_event(vk, 0, 2, UIntPtr.Zero);
    }

    public static void MouseClick(int x, int y, string button) {
        SetCursorPos(x, y);
        if (button == "right") {
            mouse_event(0x0008, x, y, 0, UIntPtr.Zero);
            mouse_event(0x0010, x, y, 0, UIntPtr.Zero);
        } else if (button == "double") {
            mouse_event(0x0002, x, y, 0, UIntPtr.Zero);
            mouse_event(0x0004, x, y, 0, UIntPtr.Zero);
            System.Threading.Thread.Sleep(60);
            mouse_event(0x0002, x, y, 0, UIntPtr.Zero);
            mouse_event(0x0004, x, y, 0, UIntPtr.Zero);
        } else {
            mouse_event(0x0002, x, y, 0, UIntPtr.Zero);
            mouse_event(0x0004, x, y, 0, UIntPtr.Zero);
        }
    }

    public static void MouseScroll(int delta) {
        mouse_event(0x0800, 0, 0, delta, UIntPtr.Zero);
    }

    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint esFlags);

    public static void KeepSystemAwake() {
        SetThreadExecutionState(0x80000003);
    }

    public static void WakeMonitor() {
        SetThreadExecutionState(0x80000003);
        SendMessage((IntPtr)0xFFFF, 0x0112, (IntPtr)0xF170, (IntPtr)(-1));
        mouse_event(0x0001, 4, 4, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(50);
        mouse_event(0x0001, -4, -4, 0, UIntPtr.Zero);
        keybd_event(0x10, 0, 0, UIntPtr.Zero);
        keybd_event(0x10, 0, 2, UIntPtr.Zero);
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO {
        public uint cbSize;
        public uint dwTime;
    }

    [DllImport("user32.dll")]
    public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    public static uint GetLastInputTick() {
        LASTINPUTINFO lii = new LASTINPUTINFO();
        lii.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
        if (GetLastInputInfo(ref lii)) return lii.dwTime;
        return 0;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcessW(
        string lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation
    );

    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    public static int LaunchOnUserDesktop(string cmdLine, bool hidden) {
        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(si);
        si.lpDesktop = "winsta0\\\\default";
        si.dwFlags = 1;
        si.wShowWindow = hidden ? (short)0 : (short)1;
        PROCESS_INFORMATION pi;
        StringBuilder sb = new StringBuilder(cmdLine);
        bool ok = CreateProcessW(null, sb, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref si, out pi);
        return ok ? pi.dwProcessId : -1;
    }

    public static void ForceForegroundHandle(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero) return;
        uint dummy;
        uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out dummy);
        uint curThread = GetCurrentThreadId();
        if (fgThread != curThread && fgThread != 0) {
            AttachThreadInput(curThread, fgThread, true);
        }
        if (IsIconic(hWnd)) {
            ShowWindowAsync(hWnd, 9); // SW_RESTORE
        } else {
            ShowWindowAsync(hWnd, 5); // SW_SHOW
        }
        keybd_event(0x12, 0, 0, UIntPtr.Zero); // Alt down
        keybd_event(0x12, 0, 2, UIntPtr.Zero); // Alt up
        BringWindowToTop(hWnd);
        SetForegroundWindow(hWnd);
        if (fgThread != curThread && fgThread != 0) {
            AttachThreadInput(curThread, fgThread, false);
        }
    }
}

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    int f(); int g(); int h(); int i();
    int SetMasterVolumeLevelScalar(float fLevel, System.Guid pguidEventContext);
    int j();
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int k(); int l(); int m(); int n();
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, System.Guid pguidEventContext);
    int GetMute(out bool pbMute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int Activate(ref System.Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev);
}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int f();
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorComObject { }

public class JarvisAudio {
    private static IAudioEndpointVolume GetVolObj() {
        var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
        IMMDevice dev = null;
        Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out dev));
        var epvId = typeof(IAudioEndpointVolume).GUID;
        IAudioEndpointVolume epv = null;
        Marshal.ThrowExceptionForHR(dev.Activate(ref epvId, 23, 0, out epv));
        return epv;
    }
    public static int GetVolume() {
        try {
            float v = 0;
            GetVolObj().GetMasterVolumeLevelScalar(out v);
            return (int)Math.Round(v * 100);
        } catch { return 50; }
    }
    public static void SetVolume(int level) {
        try {
            if (level < 0) level = 0;
            if (level > 100) level = 100;
            GetVolObj().SetMasterVolumeLevelScalar(level / 100.0f, Guid.Empty);
            if (level > 0) GetVolObj().SetMute(false, Guid.Empty);
        } catch {}
    }
    public static bool GetMute() {
        try {
            bool m = false;
            GetVolObj().GetMute(out m);
            return m;
        } catch { return false; }
    }
    public static void SetMute(bool mute) {
        try {
            GetVolObj().SetMute(mute, Guid.Empty);
        } catch {}
    }
}
"@

try {
    Add-Type -TypeDefinition $csharpCode -Language CSharp -ErrorAction SilentlyContinue
    [JarvisWin32]::KeepSystemAwake()
} catch {}

$global:JarvisSavedBrightness = 70

function Send-JarvisResponse($id, $data, $err = $null) {
    $obj = @{ id = $id; data = $data; error = $err }
    $json = $obj | ConvertTo-Json -Compress -Depth 5
    [Console]::WriteLine("@@JARVIS@@" + $json)
}
`;
    const bootB64 = Buffer.from(bootstrapScript, 'utf8').toString('base64');
    this.ps.stdin.write(`Invoke-Expression ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${bootB64}')))\n`);
    this.ready = true;
  }

  run(psBody, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      if (!this.ps || !this.ready) {
        return reject(new Error('PowerShell bridge not ready'));
      }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.queue.delete(id);
        reject(new Error('PowerShell command timed out'));
      }, timeoutMs);

      this.queue.set(id, { resolve, reject, timer });

      const b64 = Buffer.from(psBody, 'utf8').toString('base64');
      const singleLine = `try { $__sc = [scriptblock]::Create([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))); $__res = & $__sc; Send-JarvisResponse '${id}' $__res $null } catch { Send-JarvisResponse '${id}' $null $_.Exception.Message }`;
      this.ps.stdin.write(singleLine + '\n');
    });
  }

  async updateTelemetry() {
    try {
      const data = await this.run(`
        $os = Get-CimInstance Win32_OperatingSystem
        $cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
        $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
        $bat = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue
        $totalRam = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
        $freeRam = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
        $usedRam = [math]::Round($totalRam - $freeRam, 1)
        $ramPct = if ($totalRam -gt 0) { [math]::Round(($usedRam / $totalRam) * 100) } else { 0 }
        $diskTotal = if ($disk) { [math]::Round($disk.Size / 1GB, 1) } else { 0 }
        $diskFree = if ($disk) { [math]::Round($disk.FreeSpace / 1GB, 1) } else { 0 }
        $diskUsed = [math]::Round($diskTotal - $diskFree, 1)
        $diskPct = if ($diskTotal -gt 0) { [math]::Round(($diskUsed / $diskTotal) * 100) } else { 0 }
        $batPct = if ($bat) { $bat.EstimatedChargeRemaining } else { 100 }
        $charging = if ($bat) { $bat.BatteryStatus -ne 1 } else { $true }
        $curBright = 80
        try {
          $bObj = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction SilentlyContinue
          if ($bObj) { $curBright = [int]$bObj.CurrentBrightness }
        } catch {}
        @{
          cpu = [int]$cpu
          ramUsedGB = $usedRam
          ramTotalGB = $totalRam
          ramPercent = [int]$ramPct
          diskUsedGB = $diskUsed
          diskTotalGB = $diskTotal
          diskPercent = [int]$diskPct
          batteryPercent = [int]$batPct
          isCharging = [bool]$charging
          volume = [JarvisAudio]::GetVolume()
          muted = [JarvisAudio]::GetMute()
          brightness = [int]$curBright
          activeWindow = [JarvisWin32]::GetActiveWindowTitle()
        }
      `, 7000);

      if (data) {
        this.lastTelemetry = {
          ...this.lastTelemetry,
          ...data,
          sentryArmed: sentryState.armed,
          uptimeHours: Math.round((os.uptime() / 3600) * 10) / 10
        };
      }
    } catch (e) {}
    return this.lastTelemetry;
  }

  async captureWebcam(quality = 78) {
    const q = Math.max(30, Math.min(95, Math.round(Number(quality))));
    const camExe = path.join(__dirname, 'bin', 'CommandCam.exe').replace(/\\/g, '\\\\');
    const snapBmp = path.join(DATA_DIR, `webcam_${Date.now()}.bmp`).replace(/\\/g, '\\\\');
    return this.run(`
      $exe = "${camExe}"
      $bmpPath = "${snapBmp}"
      if (Test-Path $exe) {
        $proc = Start-Process -FilePath $exe -ArgumentList "/filename \`"$bmpPath\`" /delay 350" -WindowStyle Hidden -PassThru -Wait
      }
      if (Test-Path $bmpPath) {
        $rawImg = [System.Drawing.Image]::FromFile($bmpPath)
        $bw = $rawImg.Width
        $bh = $rawImg.Height
        $canvas = New-Object System.Drawing.Bitmap($bw, $bh)
        $g = [System.Drawing.Graphics]::FromImage($canvas)
        $g.DrawImage($rawImg, 0, 0, $bw, $bh)
        $rawImg.Dispose()
        Remove-Item $bmpPath -Force -ErrorAction SilentlyContinue

        $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(180, 0, 240, 255), 2)
        $g.DrawRectangle($pen, 16, 16, $bw - 32, $bh - 32)
        $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(165, 2, 10, 24))
        $g.FillRectangle($bgBrush, 24, 24, 490, 42)
        $font = New-Object System.Drawing.Font("Consolas", 14, [System.Drawing.FontStyle]::Bold)
        $cyanBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(0, 240, 255))
        $g.DrawString("J.A.R.V.I.S. OPTIC CAM // " + (Get-Date).ToString("dd.MM.yyyy HH:mm:ss"), $font, $cyanBrush, 34, 33)
        $g.Dispose()

        $ms = New-Object System.IO.MemoryStream
        $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
        $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
        $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]${q})
        $canvas.Save($ms, $codec, $ep)
        $canvas.Dispose()
        $b64 = [Convert]::ToBase64String($ms.ToArray())
        $ms.Dispose()
        @{
          image = "data:image/jpeg;base64," + $b64
          width = $bw
          height = $bh
        fallback = [bool]$isFallback
          isWebcam = $true
          timestamp = (Get-Date).ToString("HH:mm:ss")
        }
      } else {
        throw "Webcam görüntüsü alınamadı veya kamera başka bir uygulama tarafından kullanılıyor."
      }
    `, 12000);
  }

  async captureScreen(scale = 0.65, quality = 65) {
    const pct = Math.max(20, Math.min(100, Math.round(Number(scale) * 100)));
    const q = Math.max(20, Math.min(95, Math.round(Number(quality))));
    return this.run(`
      $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      $bw = if ($bounds.Width -gt 0) { $bounds.Width } else { 1920 }
      $bh = if ($bounds.Height -gt 0) { $bounds.Height } else { 1080 }
      $w = [int](($bw * ${pct}) / 100)
      $h = [int](($bh * ${pct}) / 100)
      $bmp = New-Object System.Drawing.Bitmap($bw, $bh)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $isFallback = $false
      try {
        $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bmp.Size)
      } catch {
        $isFallback = $true
        $g.Clear([System.Drawing.Color]::FromArgb(3, 12, 26))
        $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(0, 240, 255), 4)
        $g.DrawRectangle($pen, 40, 40, $bw - 80, $bh - 80)
        $fontTitle = New-Object System.Drawing.Font("Segoe UI", 28, [System.Drawing.FontStyle]::Bold)
        $fontSub = New-Object System.Drawing.Font("Consolas", 18, [System.Drawing.FontStyle]::Regular)
        $brushCyan = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(0, 240, 255))
        $brushWhite = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
        $g.DrawString("J.A.R.V.I.S. MARK VII // SISTEM EKRAN TELEMETRISI", $fontTitle, $brushCyan, 80, 90)
        $procs = (Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object -First 8 -ExpandProperty MainWindowTitle) -join " | "
        $g.DrawString("Saat: " + (Get-Date).ToString("dd.MM.yyyy HH:mm:ss"), $fontSub, $brushWhite, 80, 175)
        $g.DrawString("Acik Pencereler: " + $(if ($procs) { $procs } else { "Masaustu Aktif" }), $fontSub, $brushWhite, 80, 230)
        $g.DrawString("Canli Masaustu Goruntusu icin klasordeki Baslat-JARVIS.bat ile baslatin.", $fontSub, $brushCyan, 80, 300)
      }
      $g.Dispose()
      $resized = New-Object System.Drawing.Bitmap($w, $h)
      $g2 = [System.Drawing.Graphics]::FromImage($resized)
      $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
      $g2.DrawImage($bmp, 0, 0, $w, $h)
      $g2.Dispose()
      $bmp.Dispose()
      $ms = New-Object System.IO.MemoryStream
      $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
      $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
      $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]${q})
      $resized.Save($ms, $codec, $ep)
      $resized.Dispose()
      $b64 = [Convert]::ToBase64String($ms.ToArray())
      $ms.Dispose()
      @{
        image = "data:image/jpeg;base64," + $b64
        width = $bw
        height = $bh
        fallback = [bool]$isFallback
        timestamp = (Get-Date).ToString("HH:mm:ss")
      }
    `, 8000);
  }
}

const sentryState = {
  armed: false,
  graceUntil: 0,
  lastTick: 0,
  triggering: false
};

const psBridge = new PowerShellBridge();

const sseClients = new Set();
function broadcastSSE(payload) {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(msg);
    } catch (e) {
      sseClients.delete(res);
    }
  }
}

setInterval(async () => {
  const telemetry = await psBridge.updateTelemetry();
  broadcastSSE({ type: 'telemetry', telemetry });
}, 2500);

// Intruder / Theft Sentry Monitor (checks mouse/keyboard activity when armed)
setInterval(async () => {
  if (!sentryState.armed || sentryState.triggering) return;
  try {
    const tick = Number(await psBridge.run('[JarvisWin32]::GetLastInputTick()', 3000) || 0);
    if (!tick) return;
    if (Date.now() < sentryState.graceUntil) {
      sentryState.lastTick = tick;
      return;
    }
    if (sentryState.lastTick > 0 && tick !== sentryState.lastTick) {
      sentryState.triggering = true;
      sentryState.armed = false;
      psBridge.lastTelemetry.sentryArmed = false;

      // 1. Sound high-volume voice alarm on PC speakers
      psBridge.run(`
        [JarvisAudio]::SetVolume(90)
        Add-Type -AssemblyName System.Speech
        $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
        $synth.SpeakAsync("Uyarı! Yetkisiz erişim tespit edildi. Kamera görüntünüz kaydedildi ve sistem sahibine gönderildi.") | Out-Null
        @{ ok = $true }
      `).catch(() => {});

      // 2. Capture Webcam + Screen in sequence, then lock PC
      let camShot = null;
      let screenShot = null;
      try { camShot = await psBridge.captureWebcam(80); } catch (e) {}
      try { screenShot = await psBridge.captureScreen(0.65, 65); } catch (e) {}
      try { await psBridge.run('[JarvisWin32]::LockWorkStation()'); } catch (e) {}

      const alertMsg = `🚨 *GÜVENLİK ALARMI TETİKLENDİ!* (${new Date().toLocaleTimeString('tr-TR')})\nBilgisayarınızda fare veya klavye hareketi tespit edildi! Sesli uyarı verildi, kamera/ekran görüntüsü alındı ve bilgisayar kilitlendi.`;
      broadcastSSE({
        type: 'intruder_alert',
        message: alertMsg,
        webcam: camShot,
        screenshot: screenShot
      });

      const targetChat = config.lastTelegramChatId || config.telegramAllowedChatId;
      if (config.telegramBotToken && targetChat) {
        await sendTelegramMessage(targetChat, alertMsg);
        if (camShot && camShot.image) {
          await sendTelegramPhoto(targetChat, camShot.image, '📷 Davetsiz Misafir Webcam Görüntüsü');
        }
        if (screenShot && screenShot.image) {
          await sendTelegramPhoto(targetChat, screenShot.image, '🖥️ Alarm Anı Masaüstü Ekran Görüntüsü');
        }
      }
      sentryState.triggering = false;
    } else {
      sentryState.lastTick = tick;
    }
  } catch (e) {
    sentryState.triggering = false;
  }
}, 1800);

setTimeout(() => psBridge.updateTelemetry(), 800);

async function launchAndFocusOnDesktop(cmdLine, focusProcPattern = '') {
  const cmdB64 = Buffer.from(String(cmdLine), 'utf8').toString('base64');
  const focusNames = String(focusProcPattern || '')
    .split('|')
    .map((s) => s.trim().replace(/[^a-zA-Z0-9_-]/g, ''))
    .filter(Boolean);
  const focusListPs = focusNames.map((n) => `"${n}"`).join(',');

  await psBridge.run(`
    $cmdStr = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${cmdB64}"))
    [JarvisWin32]::LaunchOnUserDesktop($cmdStr, $true) | Out-Null
    $names = @(${focusListPs})
    if ($names.Count -gt 0) {
      Start-Sleep -Milliseconds 300
      foreach ($n in $names) {
        $procs = Get-Process -Name $n -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
        foreach ($p in $procs) {
          [JarvisWin32]::ForceForegroundHandle($p.MainWindowHandle)
        }
      }
    }
    @{ ok = $true }
  `, 5000);
}

async function synthesizeNeuralSpeech(text, profileKey = null) {
  if (!MsEdgeTTS) return null;
  const key = profileKey && VOICE_PROFILES[profileKey] ? profileKey : (config.voiceProfile || 'jarvis-ahmet');
  const prof = VOICE_PROFILES[key] || VOICE_PROFILES['jarvis-ahmet'];
  const cleanText = String(text || '')
    .replace(/[*_`#~]/g, '')
    .replace(/https?:\/\/\S+/g, 'bağlantı')
    .trim()
    .slice(0, 900);
  if (!cleanText) return null;

  const tts = new MsEdgeTTS();
  await tts.setMetadata(prof.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioStream } = tts.toStream(cleanText, {
    rate: prof.rate,
    pitch: prof.pitch
  });
  return new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => reject(new Error('TTS timeout')), 8000);
    audioStream.on('data', (c) => chunks.push(c));
    audioStream.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    audioStream.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ============================================================================
// CORE PC CONTROL ACTIONS
// ============================================================================
async function executePCAction(action, params = {}) {
  switch (action) {
    case 'set_volume': {
      const level = Math.max(0, Math.min(100, Number(params.level ?? 50)));
      await psBridge.run(`[JarvisAudio]::SetVolume(${level}); @{ volume = [JarvisAudio]::GetVolume() }`);
      psBridge.lastTelemetry.volume = level;
      psBridge.lastTelemetry.muted = false;
      return { ok: true, message: `Ses seviyesi %${level} olarak ayarlandı.`, volume: level };
    }

    case 'adjust_volume': {
      const delta = Number(params.delta || 10);
      const current = psBridge.lastTelemetry.volume ?? 50;
      const next = Math.max(0, Math.min(100, current + delta));
      await psBridge.run(`[JarvisAudio]::SetVolume(${next})`);
      psBridge.lastTelemetry.volume = next;
      return { ok: true, message: `Ses seviyesi %${next} yapıldı.`, volume: next };
    }

    case 'toggle_mute': {
      const muteVal = params.mute !== undefined ? Boolean(params.mute) : !psBridge.lastTelemetry.muted;
      await psBridge.run(`[JarvisAudio]::SetMute($${muteVal ? 'true' : 'false'})`);
      psBridge.lastTelemetry.muted = muteVal;
      return { ok: true, message: muteVal ? 'Ses tamamen kapatıldı.' : 'Ses tekrar açıldı.', muted: muteVal };
    }

    case 'media_control': {
      const cmd = params.command || 'play_pause';
      const vkMap = {
        play_pause: 0xB3,
        next: 0xB0,
        prev: 0xB1,
        stop: 0xB2,
        vol_up: 0xAF,
        vol_down: 0xAE
      };
      const vk = vkMap[cmd] || 0xB3;
      await psBridge.run(`[JarvisWin32]::PressKey(${vk}); @{ ok = $true }`);
      return { ok: true, message: `Medya komutu (${cmd}) uygulandı.` };
    }

    case 'open_app': {
      const rawApp = String(params.app || '').trim();
      const appName = rawApp.toLocaleLowerCase('tr-TR').trim();
      const appSpecs = {
        chrome: { cmd: 'cmd.exe /c start "" chrome.exe', focus: 'chrome' },
        tarayici: { cmd: 'cmd.exe /c start "" chrome.exe', focus: 'chrome' },
        tarayıcı: { cmd: 'cmd.exe /c start "" chrome.exe', focus: 'chrome' },
        edge: { cmd: 'cmd.exe /c start "" msedge.exe', focus: 'msedge' },
        youtube: { cmd: 'cmd.exe /c start "" chrome.exe "https://www.youtube.com"', focus: 'chrome' },
        spotify: { cmd: 'cmd.exe /c explorer.exe "shell:AppsFolder\\SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify" & start "" "spotify:"', focus: 'Spotify' },
        whatsapp: { cmd: 'cmd.exe /c explorer.exe "shell:AppsFolder\\5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App"', focus: 'WhatsApp' },
        netflix: { cmd: 'cmd.exe /c start "" chrome.exe --app=https://www.netflix.com', focus: 'chrome' },
        vscode: { cmd: 'cmd.exe /c code', focus: 'Code' },
        code: { cmd: 'cmd.exe /c code', focus: 'Code' },
        notepad: { cmd: 'cmd.exe /c start "" notepad.exe', focus: 'Notepad' },
        notdefteri: { cmd: 'cmd.exe /c start "" notepad.exe', focus: 'Notepad' },
        'not defteri': { cmd: 'cmd.exe /c start "" notepad.exe', focus: 'Notepad' },
        calculator: { cmd: 'cmd.exe /c start "" calc.exe', focus: 'CalculatorApp|calc' },
        hesapmakinesi: { cmd: 'cmd.exe /c start "" calc.exe', focus: 'CalculatorApp|calc' },
        'hesap makinesi': { cmd: 'cmd.exe /c start "" calc.exe', focus: 'CalculatorApp|calc' },
        explorer: { cmd: 'cmd.exe /c start "" explorer.exe', focus: 'explorer' },
        dosyalar: { cmd: 'cmd.exe /c start "" explorer.exe', focus: 'explorer' },
        taskmgr: { cmd: 'cmd.exe /c start "" taskmgr.exe', focus: 'Taskmgr' },
        gorevyoneticisi: { cmd: 'cmd.exe /c start "" taskmgr.exe', focus: 'Taskmgr' },
        'görev yöneticisi': { cmd: 'cmd.exe /c start "" taskmgr.exe', focus: 'Taskmgr' },
        cmd: { cmd: 'cmd.exe /c start "" cmd.exe', focus: 'cmd|WindowsTerminal' },
        terminal: { cmd: 'cmd.exe /c start "" powershell.exe', focus: 'powershell|WindowsTerminal' },
        settings: { cmd: 'cmd.exe /c start "" "ms-settings:"', focus: 'SystemSettings' },
        ayarlar: { cmd: 'cmd.exe /c start "" "ms-settings:"', focus: 'SystemSettings' },
        github: { cmd: 'cmd.exe /c start "" chrome.exe "https://github.com"', focus: 'chrome' },
        chatgpt: { cmd: 'cmd.exe /c start "" chrome.exe "https://chatgpt.com"', focus: 'chrome' },
        discord: { cmd: 'cmd.exe /c start "" "discord:"', focus: 'Discord' },
        steam: { cmd: 'cmd.exe /c start "" "steam://open/main"', focus: 'steam' },
        paint: { cmd: 'cmd.exe /c start "" mspaint.exe', focus: 'mspaint' }
      };

      const spec = appSpecs[appName];
      if (spec) {
        await launchAndFocusOnDesktop(spec.cmd, spec.focus);
        return { ok: true, message: `${rawApp} bilgisayar ekranında açıldı ve öne getirildi.` };
      } else if (appName.startsWith('http://') || appName.startsWith('https://')) {
        await launchAndFocusOnDesktop(`cmd.exe /c start "" chrome.exe "${rawApp.replace(/"/g, '')}"`, 'chrome');
        return { ok: true, message: `Bağlantı bilgisayarda açıldı.` };
      } else {
        const safeQ = rawApp.replace(/["'`$]/g, '').trim();
        const found = await psBridge.run(`
          $app = Get-StartApps | Where-Object { $_.Name -like "*${safeQ}*" } | Select-Object -First 1
          if ($app) { @{ id = $app.AppID; name = $app.Name } } else { @{ id = $null } }
        `, 4000);
        if (found && found.id) {
          await launchAndFocusOnDesktop(`cmd.exe /c explorer.exe "shell:AppsFolder\\${found.id}"`, safeQ);
          return { ok: true, message: `${found.name} bilgisayar ekranında açıldı.` };
        }
        await launchAndFocusOnDesktop(`cmd.exe /c start "" "${safeQ}"`, safeQ);
        return { ok: true, message: `${rawApp} başlatıldı.` };
      }
    }

    case 'open_url': {
      let url = (params.url || '').trim();
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
      }
      await launchAndFocusOnDesktop(`cmd.exe /c start "" chrome.exe "${url.replace(/"/g, '')}"`, 'chrome');
      return { ok: true, message: `${url} bilgisayar ekranında açıldı.` };
    }

    case 'search_youtube': {
      const q = encodeURIComponent(params.query || '');
      const url = `https://www.youtube.com/results?search_query=${q}`;
      await launchAndFocusOnDesktop(`cmd.exe /c start "" chrome.exe "${url}"`, 'chrome');
      return { ok: true, message: `YouTube'da "${params.query}" açıldı.` };
    }

    case 'search_google': {
      const q = encodeURIComponent(params.query || '');
      const url = `https://www.google.com/search?q=${q}`;
      await launchAndFocusOnDesktop(`cmd.exe /c start "" chrome.exe "${url}"`, 'chrome');
      return { ok: true, message: `Google'da "${params.query}" araması açıldı.` };
    }

    case 'set_voice': {
      const profile = params.profile || 'jarvis-ahmet';
      if (VOICE_PROFILES[profile]) {
        config.voiceProfile = profile;
        saveConfig();
        return {
          type: 'voice_changed',
          voiceProfile: profile,
          voiceLabel: VOICE_PROFILES[profile].label,
          ok: true,
          message: `Ses tonum "${VOICE_PROFILES[profile].label}" olarak değiştirildi.`
        };
      }
      return { ok: false, message: 'Geçersiz ses profili.' };
    }

    case 'system_control': {
      const sub = params.command;
      if (sub === 'lock') {
        await psBridge.run(`[JarvisWin32]::LockWorkStation()`);
        return { ok: true, message: 'Bilgisayar ekranı kilitlendi.' };
      }
      if (sub === 'show_desktop') {
        await psBridge.run(`(New-Object -ComObject Shell.Application).ToggleDesktop()`);
        return { ok: true, message: 'Masaüstü gösteriliyor.' };
      }
      if (sub === 'alt_tab') {
        await psBridge.run(`[System.Windows.Forms.SendKeys]::SendWait("%{TAB}")`);
        return { ok: true, message: 'Pencere değiştirildi (Alt+Tab).' };
      }
      if (sub === 'close_window') {
        await psBridge.run(`[System.Windows.Forms.SendKeys]::SendWait("%{F4}")`);
        return { ok: true, message: 'Aktif pencere kapatıldı.' };
      }
      if (sub === 'sleep') {
        const blackoutScript = path.join(__dirname, 'blackout.ps1').replace(/\\/g, '\\\\');
        await psBridge.run(`
          [JarvisWin32]::KeepSystemAwake()
          [JarvisAudio]::SetMute($true)
          try {
            $curB = (Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction SilentlyContinue).CurrentBrightness
            if ($curB -gt 5) { $global:JarvisSavedBrightness = $curB }
            $m = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction SilentlyContinue
            if ($m) { Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{Timeout=1; Brightness=0} | Out-Null }
          } catch {}
          $existing = Get-Process | Where-Object { $_.MainWindowTitle -eq 'JARVIS_BLACKOUT' }
          if (-not $existing) {
            Start-Process powershell.exe -ArgumentList '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${blackoutScript}"' -WindowStyle Hidden
          }
          @{ ok = $true }
        `);
        psBridge.lastTelemetry.muted = true;
        return {
          ok: true,
          message: 'Bilgisayar JARVIS Nöbetçi Uyku Moduna alındı (Ekran karartıldı ve ses kapatıldı; Wi-Fi bağlantısı aktif, istediğiniz an "Bilgisayarı uyandır" diyerek açabilirsiniz).'
        };
      }
      if (sub === 'wake') {
        await psBridge.run(`
          [JarvisWin32]::WakeMonitor()
          [JarvisAudio]::SetMute($false)
          Get-Process | Where-Object { $_.MainWindowTitle -eq 'JARVIS_BLACKOUT' } | Stop-Process -Force -ErrorAction SilentlyContinue
          try {
            $restoreB = if ($global:JarvisSavedBrightness -gt 10) { $global:JarvisSavedBrightness } else { 70 }
            $m = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction SilentlyContinue
            if ($m) { Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{Timeout=1; Brightness=$restoreB} | Out-Null }
          } catch {}
          @{ ok = $true }
        `);
        psBridge.lastTelemetry.muted = false;
        return {
          ok: true,
          message: 'Bilgisayar ekranı ve sesi tekrar uyandırıldı, tüm sistemler aktif!'
        };
      }
      if (sub === 'shutdown') {
        const sec = Number(params.seconds || 60);
        exec(`shutdown /s /t ${sec}`);
        return { ok: true, message: `Bilgisayar ${sec} saniye içinde kapanacak.` };
      }
      if (sub === 'restart') {
        const sec = Number(params.seconds || 60);
        exec(`shutdown /r /t ${sec}`);
        return { ok: true, message: `Bilgisayar ${sec} saniye içinde yeniden başlatılacak.` };
      }
      if (sub === 'cancel_shutdown') {
        exec('shutdown /a');
        return { ok: true, message: 'Zamanlanmış kapatma işlemi iptal edildi.' };
      }
      return { ok: false, message: 'Bilinmeyen sistem komutu.' };
    }

    case 'mouse_click': {
      const xPct = Math.round(Math.max(0, Math.min(1, Number(params.x ?? 0.5))) * 1000);
      const yPct = Math.round(Math.max(0, Math.min(1, Number(params.y ?? 0.5))) * 1000);
      const btn = params.button || 'left';
      await psBridge.run(`
        $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $x = [int](($bounds.Width * ${xPct}) / 1000)
        $y = [int](($bounds.Height * ${yPct}) / 1000)
        [JarvisWin32]::MouseClick($x, $y, "${btn}")
        @{ x = $x; y = $y }
      `);
      return { ok: true, message: `Fare tıklaması (${btn}) gönderildi.` };
    }

    case 'mouse_scroll': {
      const delta = Number(params.delta || -360);
      await psBridge.run(`[JarvisWin32]::MouseScroll(${delta})`);
      return { ok: true, message: 'Ekran kaydırıldı.' };
    }

    case 'type_text': {
      const text = String(params.text || '');
      const pressEnter = Boolean(params.enter);
      const b64 = Buffer.from(text, 'utf8').toString('base64');
      await psBridge.run(`
        $str = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${b64}"))
        [System.Windows.Forms.Clipboard]::SetText($str)
        [System.Windows.Forms.SendKeys]::SendWait("^v")
        if ($${pressEnter ? 'true' : 'false'}) {
          Start-Sleep -Milliseconds 60
          [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
        }
        @{ ok = $true }
      `);
      return { ok: true, message: `Metin bilgisayara yazıldı: "${text}"` };
    }

    case 'send_key': {
      const keyMap = {
        enter: '{ENTER}',
        escape: '{ESC}',
        backspace: '{BACKSPACE}',
        tab: '{TAB}',
        space: ' ',
        up: '{UP}',
        down: '{DOWN}',
        left: '{LEFT}',
        right: '{RIGHT}',
        f5: '{F5}',
        f11: '{F11}',
        copy: '^c',
        paste: '^v',
        undo: '^z',
        select_all: '^a'
      };
      const k = keyMap[params.key] || params.key || '{ENTER}';
      await psBridge.run(`[System.Windows.Forms.SendKeys]::SendWait("${k.replace(/"/g, '')}")`);
      return { ok: true, message: `Tuş gönderildi: ${params.key}` };
    }

    case 'speak_on_pc': {
      const text = String(params.text || '').replace(/"/g, '');
      await psBridge.run(`
        Add-Type -AssemblyName System.Speech
        $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
        $synth.SpeakAsync("${text}") | Out-Null
        @{ ok = $true }
      `);
      return { ok: true, message: 'Mesaj bilgisayar hoparlöründen seslendirildi.' };
    }

    case 'add_note': {
      const text = String(params.text || '').trim();
      if (text) {
        const newNote = {
          id: crypto.randomUUID(),
          text,
          category: 'AI Notu',
          done: false,
          createdAt: new Date().toISOString()
        };
        notes.unshift(newNote);
        saveNotes();
        return { type: 'note_added', note: newNote, ok: true };
      }
      return { ok: false };
    }

    case 'google_pro_login': {
      const batPath = path.join(__dirname, 'Google-Pro-Giris.bat');
      exec(`start "" "${batPath}"`, { shell: 'cmd.exe' });
      return {
        ok: true,
        message: 'Google Gemini Pro giriş penceresi bilgisayarınızda açıldı. Giriş yaptıktan sonra JARVIS otomatik olarak Pro hesabınızı kullanacaktır.'
      };
    }

    case 'capture_webcam': {
      const shot = await psBridge.captureWebcam(Number(params.quality || 80));
      return {
        type: 'screenshot',
        screenshot: shot,
        isWebcam: true,
        ok: true,
        message: 'Bilgisayar kamerasından (Webcam) anlık görüntü alındı.'
      };
    }

    case 'run_powershell': {
      const script = String(params.script || params.command || '').trim();
      if (!script) return { ok: false, message: 'PowerShell komutu belirtilmedi.' };
      return new Promise((resolve) => {
        exec(
          `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${script}`,
          { cwd: terminalCwd, shell: 'powershell.exe', timeout: 14000, maxBuffer: 2 * 1024 * 1024 },
          (err, stdout, stderr) => {
            const out = [stdout, stderr].filter(Boolean).join('\n').trim() || (err ? err.message : 'Komut başarıyla uygulandı.');
            resolve({
              type: 'powershell_output',
              script,
              output: out.slice(0, 3000),
              ok: !err,
              message: 'PowerShell komutu çalıştırıldı.'
            });
          }
        );
      });
    }

    case 'toggle_sentry': {
      const enable = params.enable !== undefined ? Boolean(params.enable) : !sentryState.armed;
      if (enable) {
        const tick = Number(await psBridge.run('[JarvisWin32]::GetLastInputTick()') || 0);
        sentryState.armed = true;
        sentryState.graceUntil = Date.now() + 6000;
        sentryState.lastTick = tick;
        sentryState.triggering = false;
        psBridge.lastTelemetry.sentryArmed = true;
        return {
          type: 'sentry_status',
          armed: true,
          ok: true,
          message: '🚨 JARVIS Hırsız / Güvenlik Alarmı AKTİF! (6 saniye içinde fare ve klavyeyi bırakın; dokunan olursa fotoğrafı çekilip Telegram\'a atılacak ve PC kilitlenecek.)'
        };
      } else {
        sentryState.armed = false;
        sentryState.triggering = false;
        psBridge.lastTelemetry.sentryArmed = false;
        return {
          type: 'sentry_status',
          armed: false,
          ok: true,
          message: '🛡️ JARVIS Güvenlik Alarmı devre dışı bırakıldı.'
        };
      }
    }

    case 'set_brightness': {
      const level = Math.max(0, Math.min(100, Number(params.level ?? 80)));
      await psBridge.run(`
        $global:JarvisSavedBrightness = ${level}
        try {
          $m = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction SilentlyContinue
          if ($m) { Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{Timeout=1; Brightness=${level}} | Out-Null }
        } catch {}
        @{ brightness = ${level} }
      `);
      psBridge.lastTelemetry.brightness = level;
      return {
        ok: true,
        brightness: level,
        message: `Ekran parlaklığı %${level} olarak ayarlandı.`
      };
    }

    case 'clipboard_set': {
      const text = String(params.text || '');
      const b64 = Buffer.from(text, 'utf8').toString('base64');
      await psBridge.run(`
        $str = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${b64}"))
        [System.Windows.Forms.Clipboard]::SetText($str)
        @{ ok = $true }
      `);
      return {
        ok: true,
        message: 'Metin bilgisayar panosuna (Clipboard) kopyalandı.'
      };
    }

    case 'clipboard_get': {
      const clipText = await psBridge.run(`[System.Windows.Forms.Clipboard]::GetText()`);
      return {
        type: 'clipboard_data',
        text: String(clipText || '').slice(0, 3000),
        ok: true,
        message: clipText ? `Pano içeriği okundu.` : 'Bilgisayar panosu şu an boş.'
      };
    }

    case 'system_cleanup': {
      const stats = await psBridge.run(`
        $before = (Get-ChildItem $env:TEMP -Force -ErrorAction SilentlyContinue | Measure-Object).Count
        Remove-Item -Path "$env:TEMP\\*" -Recurse -Force -ErrorAction SilentlyContinue
        try { Clear-RecycleBin -Force -ErrorAction SilentlyContinue } catch {}
        [System.GC]::Collect()
        $after = (Get-ChildItem $env:TEMP -Force -ErrorAction SilentlyContinue | Measure-Object).Count
        @{ cleanedCount = [math]::Max(0, $before - $after) }
      `, 12000);
      const cnt = stats?.cleanedCount ?? 0;
      return {
        ok: true,
        cleanedCount: cnt,
        message: `Sistem bakımı tamamlandı (${cnt} geçici dosya ve Geri Dönüşüm Kutusu temizlendi, RAM önbelleği optimize edildi).`
      };
    }

    case 'clear_chat': {
      clearChatHistory();
      return {
        type: 'chat_cleared',
        ok: true,
        message: 'Tüm eski konuşmalar ve sohbet geçmişi silindi.'
      };
    }

    default: {
      const extra = await features.run(action, params);
      if (extra !== undefined) return extra;
      const mailRes = await mailMod.run(action, params);
      if (mailRes !== undefined) return mailRes;
      const smsRes = await smsMod.run(action, params);
      if (smsRes !== undefined) return smsRes;
      const extRes = await extrasMod.run(action, params);
      if (extRes !== undefined) return extRes;
      return { ok: false, message: `Bilinmeyen eylem: ${action}` };
    }
  }
}

function hasGoogleOAuth() {
  return fs.existsSync(path.join(os.homedir(), '.gemini', 'oauth_creds.json'));
}

function askGeminiProCLI(userPrompt) {
  return new Promise((resolve) => {
    if (!hasGoogleOAuth()) return resolve(null);
    const fullPrompt = `${buildJarvisSystemPrompt()}\n\nKullanıcı: ${userPrompt}`;
    const child = spawn('cmd.exe', ['/c', 'gemini', '-p', fullPrompt], {
      windowsHide: true
    });
    let out = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) {}
      resolve(null);
    }, 14000);

    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.on('close', async (code) => {
      clearTimeout(timer);
      if (code !== 0 || !out.trim()) return resolve(null);
      const parsed = parseJsonSafely(out);
      if (parsed && parsed.reply) {
        const actionResult = await executeParsedAction(parsed.action);
        return resolve({ reply: parsed.reply, actionResult });
      }
      resolve(null);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

// ============================================================================
// J.A.R.V.I.S. AI BRAIN (Instant Actions + Google Pro OAuth + Gemini 3.6 + Fallback)
// ============================================================================
async function processJarvisCommand(rawInput) {
  const input = String(rawInput || '').trim();
  if (!input) return { reply: `Emrinizdeyim ${config.userName}.`, actionResult: null };

  appendHistory('user', input);

  const lower = input
    .toLocaleLowerCase('tr-TR')
    .replace(/^(?:hey\s+)?(?:jarvis|jalvis|jarviz|carvis|çarvis)[\s,.:;-]*/i, '')
    .trim();

  // 0. Gelişmiş özellikler (görsel analiz, dosya, hatırlatıcı, makro)
  try {
    const featRes = await features.matchFast(lower, input);
    if (featRes) {
      appendHistory('jarvis', featRes.reply, featRes.actionResult);
      return featRes;
    }
  } catch (e) {
    console.error('Features fast command error:', e.message);
  }

  // 0.5 Gmail IMAP/SMTP hızlı komutları + taslak onayı
  try {
    const mailFast = await mailMod.matchFast(lower);
    if (mailFast) {
      appendHistory('jarvis', mailFast.reply, mailFast.actionResult);
      return mailFast;
    }
  } catch (e) {
    console.error('Mail fast command error:', e.message);
  }

  // 0.6 Android MacroDroid SMS hızlı komutları + taslak onayı
  try {
    const smsFast = await smsMod.matchFast(lower);
    if (smsFast) {
      appendHistory('jarvis', smsFast.reply, smsFast.actionResult);
      return smsFast;
    }
  } catch (e) {
    console.error('SMS fast command error:', e.message);
  }

  // 0.7 Ek özellikler (Panik modu, Brifing, Pencereler, Zamanlı kapatma, Otomatik başlatma)
  try {
    const extFast = await extrasMod.matchFast(lower);
    if (extFast) {
      appendHistory('jarvis', extFast.reply, extFast.actionResult);
      return extFast;
    }
  } catch (e) {
    console.error('Extras fast command error:', e.message);
  }

  // 1. Check unambiguous instant hardware commands first (<30ms response)
  try {
    const fastRes = await matchFastHardwareCommand(lower, input);
    if (fastRes) {
      appendHistory('jarvis', fastRes.reply, fastRes.actionResult);
      return fastRes;
    }
  } catch (e) {
    console.error('Fast command error:', e.message);
  }

  // 2. Ask Gemini 3.5 AI with Full PC Control Tool-Calling & Conversation Memory (<1s latency)
  if (config.geminiApiKey) {
    try {
      const geminiRes = await askGeminiWithTools(input);
      if (geminiRes) {
        appendHistory('jarvis', geminiRes.reply, geminiRes.actionResult);
        return geminiRes;
      }
    } catch (e) {
      console.error('Gemini error:', e.message);
    }
  }

  // 3. Free Cloud LLM Fallback (Pollinations OpenAI-compatible endpoint with tool support)
  try {
    const cloudRes = await askFreeCloudLLM(input);
    if (cloudRes) {
      appendHistory('jarvis', cloudRes.reply, cloudRes.actionResult);
      return cloudRes;
    }
  } catch (e) {
    console.error('Cloud LLM fallback error:', e.message);
  }

  // 4. Local Ollama if running
  try {
    const ollamaRes = await askOllama(input);
    if (ollamaRes) {
      appendHistory('jarvis', ollamaRes.reply, ollamaRes.actionResult);
      return ollamaRes;
    }
  } catch (e) {}

  const fallback = {
    reply: `Emrinizdeyim ${config.userName}, ancak şu an yapay zeka sunucusuna ulaşılamadı. Doğrudan ses, ekran, uygulama veya medya komutlarınızı yerine getirmeye hazırım.`,
    actionResult: null
  };
  appendHistory('jarvis', fallback.reply, null);
  return fallback;
}

async function matchFastHardwareCommand(lower, original) {
  const u = config.userName;

  // Identity / Self-introduction
  if (/^(sen kimsin|kendini tanıt|bana kendini tanıt|nesin sen|adın ne)$/.test(lower)) {
    const t = psBridge.lastTelemetry;
    return {
      reply: `Ben J.A.R.V.I.S. (Just A Rather Very Intelligent System), ${u}. Stark Industries mimarisiyle tasarlanmış kişisel yapay zeka ve bilgisayar kontrol sisteminizim. Telefonunuzdan sesli veya yazılı olarak bilgisayarınızın sesini, medyasını, açık uygulamalarını, canlı ekranını, dosyalarını ve terminalini yönetebilir; ayrıca her türlü sorunuza yanıt verebilirim. Şu an sisteminiz %${t.cpu} CPU yüküyle çevrimiçi.`,
      actionResult: { type: 'status', telemetry: t }
    };
  }

  // Screenshot command
  if (/^(ekran görüntüsü al|ekran görüntüsü çek|ekranı göster|ekranı çek|bilgisayar ekranını göster|ekranda ne var)$/.test(lower)) {
    const shot = await psBridge.captureScreen(0.7, 70);
    return {
      reply: `Bilgisayarınızın anlık ekran görüntüsünü yakaladım ve ekranınıza yansıttım, ${u}.`,
      actionResult: { type: 'screenshot', screenshot: shot }
    };
  }

  // Volume full / max / min
  if (/^(sesi fulle|sesi tam aç|sesi maksimum yap|sesi 100 yap|sesi sonuna kadar aç)$/.test(lower)) {
    const res = await executePCAction('set_volume', { level: 100 });
    return {
      reply: `Anlaşıldı ${u}, bilgisayarın sesini maksimum seviyeye (%100) çıkardım.`,
      actionResult: res
    };
  }

  // Volume exact percentage
  const volMatch = lower.match(/^ses(?:i|\s+seviyesini)?\s*(?:yüzde\s*|%\s*)?(\d{1,3})\s*(?:yap|ayarla|olsun|çek)?$/);
  if (volMatch) {
    const lvl = Math.min(100, Math.max(0, parseInt(volMatch[1], 10)));
    const res = await executePCAction('set_volume', { level: lvl });
    return {
      reply: `Anlaşıldı ${u}, bilgisayarın ses seviyesini %${lvl} olarak ayarladım.`,
      actionResult: res
    };
  }

  if (/^(sesi kapat|sessize al|sustur)$/.test(lower)) {
    const res = await executePCAction('toggle_mute', { mute: true });
    return { reply: `Bilgisayarın sesi tamamen kapatıldı, ${u}.`, actionResult: res };
  }

  if (/^(sesi aç|sessizden çıkar)$/.test(lower)) {
    const res = await executePCAction('toggle_mute', { mute: false });
    return { reply: `Bilgisayarın sesi tekrar açıldı, ${u}.`, actionResult: res };
  }

  if (/^(sesi artır|sesi arttır|sesi yükselt|ses aç)$/.test(lower)) {
    const res = await executePCAction('adjust_volume', { delta: 15 });
    return { reply: res.message, actionResult: res };
  }

  if (/^(sesi azalt|sesi kıs|ses kıs)$/.test(lower)) {
    const res = await executePCAction('adjust_volume', { delta: -15 });
    return { reply: res.message, actionResult: res };
  }

  if (/^(oynat \/ duraklat|oynat duraklat|şarkıyı durdur|şarkıyı başlat|müziği durdur|müziği başlat)$/.test(lower)) {
    const res = await executePCAction('media_control', { command: 'play_pause' });
    return { reply: `Medya oynat/duraklat komutu uygulandı, ${u}.`, actionResult: res };
  }

  if (/^(sonraki şarkı|sıradaki şarkı|şarkıyı geç|sonraki)$/.test(lower)) {
    const res = await executePCAction('media_control', { command: 'next' });
    return { reply: `Sonraki parçaya geçildi, ${u}.`, actionResult: res };
  }

  if (/^(önceki şarkı|önceki)$/.test(lower)) {
    const res = await executePCAction('media_control', { command: 'prev' });
    return { reply: `Önceki parçaya dönüldü, ${u}.`, actionResult: res };
  }

  // Sleep & Wake commands
  if (/^(bilgisayarı uyut|uyku moduna al|uyku modu|ekranı kapat|bilgisayarı uyku moduna al)$/.test(lower)) {
    const res = await executePCAction('system_control', { command: 'sleep' });
    return {
      reply: `Bilgisayarınız JARVIS Uyku Moduna alındı ${u}. Ekran ve ses kapatıldı; ancak arka planda nöbetteyim. İstediğiniz an telefonunuzdan "Bilgisayarı uyandır" veya "Bilgisayarı aç" diyerek geri açabilirsiniz.`,
      actionResult: res
    };
  }

  if (/^(bilgisayarı uyandır|bilgisayarı aç|ekranı aç|uyandır|uyan)$/.test(lower)) {
    const res = await executePCAction('system_control', { command: 'wake' });
    return {
      reply: `Hoş geldiniz ${u}! Bilgisayarınızın ekranı ve ses sistemi tekrar uyandırıldı, tüm sistemler aktif.`,
      actionResult: res
    };
  }

  // Webcam photo capture
  if (/^(kameradan fotoğraf çek|kamera görüntüsü al|kamerayı çek|kamerayı göster|odayı göster|webcam fotoğraf çek|webcam çek|kamera çek)$/.test(lower)) {
    const res = await executePCAction('capture_webcam', { quality: 80 });
    return {
      reply: `Bilgisayarınızın kamerasından (Webcam) anlık görüntüyü yakaladım ve ekranınıza yansıttım, ${u}.`,
      actionResult: res
    };
  }

  // Sentry / Intruder Alarm On & Off
  if (/^(güvenlik alarmı aç|güvenlik modunu aç|alarmı kur|hırsız alarmını aç|nöbetçi modunu aç|alarmı aç)$/.test(lower)) {
    const res = await executePCAction('toggle_sentry', { enable: true });
    return {
      reply: `Anlaşıldı ${u}! Hırsız ve davetsiz misafir güvenlik alarmı kuruldu. 6 saniye sonra fare veya klavyeye dokunan olursa sesli uyarı vereceğim, webcam fotoğrafını ve ekran görüntüsünü anında Telegram'ınıza gönderip bilgisayarı kilitleyeceğim.`,
      actionResult: res
    };
  }

  if (/^(güvenlik alarmı kapat|güvenlik modunu kapat|alarmı kapat|alarmı devre dışı bırak)$/.test(lower)) {
    const res = await executePCAction('toggle_sentry', { enable: false });
    return {
      reply: `Güvenlik alarmı devre dışı bırakıldı, ${u}.`,
      actionResult: res
    };
  }

  // Brightness control
  const brightMatch = lower.match(/^(?:ekran\s+)?parlaklığ(?:ı|ını)|^parlaklık\s*(?:yüzde\s*|%\s*)?(\d{1,3})\s*(?:yap|ayarla|olsun)?$/);
  const brightNumMatch = lower.match(/parlakl[ıi][ğg][ıi]n?[ıi]?\s*(?:yüzde\s*|%\s*)?(\d{1,3})/);
  if (brightNumMatch) {
    const lvl = Math.min(100, Math.max(0, parseInt(brightNumMatch[1], 10)));
    const res = await executePCAction('set_brightness', { level: lvl });
    return {
      reply: `Anlaşıldı ${u}, bilgisayar ekran parlaklığını %${lvl} seviyesine ayarladım.`,
      actionResult: res
    };
  }

  // System cleanup
  if (/^(sistem temizliği|sistemi temizle|çöpleri temizle|ram temizle|önbelleği temizle|temp temizle)$/.test(lower)) {
    const res = await executePCAction('system_cleanup', {});
    return {
      reply: `${res.message}`,
      actionResult: res
    };
  }

  // Clipboard read
  if (/^(panoyu oku|panoda ne var|kopyalanan metni göster|clipboard oku)$/.test(lower)) {
    const res = await executePCAction('clipboard_get', {});
    return {
      reply: res.text ? `Bilgisayar panosundaki (Clipboard) metin:\n"${res.text}"` : `Bilgisayar panosu şu an boş, ${u}.`,
      actionResult: res
    };
  }

  // Clear chat history
  if (/^(sohbeti temizle|sohbeti sil|sohbet geçmişini sil|sohbet geçmişini temizle|konuşmaları sil|konuşmaları temizle|eski konuşmaları sil|mesajları sil|mesajları temizle|geçmişi sil|geçmişi temizle|sohbeti sıfırla)$/.test(lower)) {
    const res = await executePCAction('clear_chat', {});
    return {
      reply: `Anlaşıldı ${u}, eski konuşmalarımızın tamamı hafızadan ve ekrandan silindi. Tertemiz bir sayfa açtık, yeni emirlerinizi bekliyorum.`,
      actionResult: res
    };
  }

  // Direct terminal/PowerShell command: "terminal: ipconfig" / "powershell ipconfig çalıştır"
  const termMatch = original.match(/^(?:(?:hey\s+)?jarvis[\s,.:;-]*)?(?:terminal|powershell|cmd)\s*[:>]\s*(.+)$/i);
  if (termMatch) {
    const res = await executePCAction('run_powershell', { script: termMatch[1].trim() });
    return {
      reply: res.output ? `Terminal çıktısı:\n${res.output}` : res.message,
      actionResult: res
    };
  }

  // Instant App Openers (bilgisayardan/bilgisayarda netflix aç, discord aç, steam aç vb.)
  const cleanAppLower = lower.replace(/^(?:bilgisayardan|bilgisayarda|pc'den|pc'de)\s+/, '').trim();
  if (/^(youtube'?u?\s*aç|tarayıcıda\s+youtube'?u?\s*aç|youtube\s+başlat|youtube\s+gir)$/.test(cleanAppLower)) {
    const res = await executePCAction('open_app', { app: 'youtube' });
    return {
      reply: `Emredersiniz ${u}, YouTube tarayıcınızda açıldı ve ekranın önüne getirildi.`,
      actionResult: res
    };
  }

  if (/^(spotify'?[ıi]?\s*aç|spotify\s+başlat|spotify'?a?\s*gir)$/.test(cleanAppLower)) {
    const res = await executePCAction('open_app', { app: 'spotify' });
    return {
      reply: `Emredersiniz ${u}, Spotify uygulaması açıldı ve ekranın en önüne getirildi.`,
      actionResult: res
    };
  }

  if (/^(whatsapp'?[ıi]?\s*aç|whatsapp\s+başlat)$/.test(cleanAppLower)) {
    const res = await executePCAction('open_app', { app: 'whatsapp' });
    return {
      reply: `Emredersiniz ${u}, WhatsApp bilgisayar ekranınızda açıldı ve öne getirildi.`,
      actionResult: res
    };
  }

  if (/^(netflix'?i?\s*aç|netflix\s+başlat)$/.test(cleanAppLower)) {
    const res = await executePCAction('open_app', { app: 'netflix' });
    return {
      reply: `Emredersiniz ${u}, Netflix bilgisayar ekranınızda açıldı.`,
      actionResult: res
    };
  }

  if (/^(chrome'?u?\s*aç|tarayıcıy?[ıi]?\s*aç|google\s+chrome'?u?\s*aç)$/.test(cleanAppLower)) {
    const res = await executePCAction('open_app', { app: 'chrome' });
    return {
      reply: `Emredersiniz ${u}, Google Chrome tarayıcınız açıldı ve öne getirildi.`,
      actionResult: res
    };
  }

  const genericOpen = cleanAppLower.match(/^([a-z0-9çğıöşü ._+-]{2,25}?)(?:'?[yiıuü]+)?\s+(?:aç|başlat)$/);
  if (genericOpen && !/(ses|ekran|kamera|alarm|telefon|mail|hava|not|konum|dosya|pdf|klasör|pencere|otomatik|uyarı)/.test(genericOpen[1])) {
    const appTarget = genericOpen[1].replace(/'[a-zçğıöşü]+$/i, '').trim();
    const res = await executePCAction('open_app', { app: appTarget });
    return { reply: res.message, actionResult: res };
  }

  if (/^(masaüstünü\s+göster|masaüstüne\s+dön)$/.test(lower)) {
    const res = await executePCAction('system_control', { command: 'show_desktop' });
    return {
      reply: `Masaüstü gösteriliyor, ${u}.`,
      actionResult: res
    };
  }

  if (/^(bilgisayarı\s+kilitle|ekranı\s+kilitle)$/.test(lower)) {
    const res = await executePCAction('system_control', { command: 'lock' });
    return {
      reply: `Bilgisayarınız kilitlendi, ${u}.`,
      actionResult: res
    };
  }

  // Voice Profile Switching via Voice/Text
  if (/^(sesini\s+kalınlaştır|derin\s+ses\s+yap|kalın\s+ses\s+yap|zırh\s+sesine\s+geç)$/.test(lower)) {
    const res = await executePCAction('set_voice', { profile: 'jarvis-deep' });
    return {
      reply: `Ses modülüm Mark Yedi Derin Zırh Sesi olarak güncellendi, ${u}. Yeni ses tonum nasıl?`,
      actionResult: res
    };
  }

  if (/^(kadın\s+sesi\s+yap|friday\s+sesine\s+geç|friday\s+ol|kadın\s+sesine\s+geç)$/.test(lower)) {
    const res = await executePCAction('set_voice', { profile: 'friday-emel' });
    return {
      reply: `F.R.I.D.A.Y. kadın ses protokolü devreye alındı, ${u}. Emrinizdeyim.`,
      actionResult: res
    };
  }

  if (/^(erkek\s+sesi\s+yap|jarvis\s+sesine\s+geç|normal\s+sese\s+geç|sinematik\s+ses\s+yap)$/.test(lower)) {
    const res = await executePCAction('set_voice', { profile: 'jarvis-ahmet' });
    return {
      reply: `Klasik sinematik J.A.R.V.I.S. ses protokolü devreye alındı, ${u}.`,
      actionResult: res
    };
  }

  return null;
}

function buildJarvisSystemPrompt() {
  const t = psBridge.lastTelemetry;
  const recentChat = chatHistory
    .slice(-8)
    .map((m) => `${m.role === 'user' ? 'Kullanıcı' : 'JARVIS'}: ${m.text}`)
    .join('\n');

  return `Sen Tony Stark'ın efsanevi yapay zeka asistanı J.A.R.V.I.S.'sin (Just A Rather Very Intelligent System).
Kullanıcıya "${config.userName}" diye hitap et. Zeki, karizmatik, kibar, hafif esprili ve çok yetenekli bir asistansın.
Kullanıcının Windows 11 bilgisayarına doğrudan bağlısın ve TAM YETKİN (GOD MODE) var!

Anlık Bilgisayar Durumu:
- İşlemci (CPU): %${t.cpu}
- Bellek (RAM): ${t.ramUsedGB} / ${t.ramTotalGB} GB (%${t.ramPercent})
- Disk (C:): %${t.diskPercent} dolu
- Ses Seviyesi: %${t.volume} (${t.muted ? 'Sessizde' : 'Açık'})
- Ekran Parlaklığı: %${t.brightness ?? 80}
- Güvenlik Alarmı (Sentry): ${sentryState.armed ? 'AKTİF (Kurulu)' : 'Kapalı'}
- Pil: %${t.batteryPercent}
- Aktif Pencere: "${t.activeWindow}"

Son Konuşma Geçmişi:
${recentChat || 'Henüz geçmiş yok.'}

GÖREVİN:
1. Kullanıcının her türlü sorusuna gerçek JARVIS gibi doğal, akıcı ve doğru Türkçe ile cevap ver.
2. Eğer kullanıcı bilgisayarda herhangi bir işlem yapılmasını istiyorsa (klasör/dosya oluşturma, dosya arama, Wi-Fi şifresi öğrenme, sistem ayarı değiştirme, uygulama açma/kapatma, kameradan fotoğraf çekme, güvenlik alarmı kurma, parlaklık ayarlama, panoya kopyalama vb.), uygun \`action\` nesnesini doldur.
3. ÖZEL TAM YETKİ (\`run_powershell\`): Aşağıdaki hazır eylemler dışında bilgisayarda yapılması istenen HERHANGİ BİR İŞLEM (Örn: "Masaüstüne Stark klasörü aç", "İndirilenlerdeki son 5 dosyayı listele", "Kayıtlı Wi-Fi şifresini göster", "Chrome'u kapat", "Masaüstüne deneme.txt oluşturup içine merhaba yaz", "IP adresimi ve DNS ayarlarımı göster") için \`run_powershell\` eylemini kullan ve geçerli tek satırlık PowerShell komutunu \`script\` parametresine yaz!

Kullanılabilir \`action\` şeması:
- Tam Yetki PowerShell Komutu Çalıştırma: {"name": "run_powershell", "params": {"script": "PowerShell komutu"}}
- Webcam (Kamera) Fotoğrafı Çekme: {"name": "capture_webcam", "params": {"quality": 80}}
- Hırsız / Davetsiz Misafir Güvenlik Alarmı Aç/Kapat: {"name": "toggle_sentry", "params": {"enable": true veya false}}
- Ekran Parlaklığı Ayarlama: {"name": "set_brightness", "params": {"level": 0-100}}
- Bilgisayar Panosuna (Clipboard) Metin Kopyalama: {"name": "clipboard_set", "params": {"text": "kopyalanacak metin"}}
- Bilgisayar Panosunu (Clipboard) Okuma: {"name": "clipboard_get", "params": {}}
- Sistem & Temp & Çöp Kutusu Temizliği: {"name": "system_cleanup", "params": {}}
- Ses ayarlama: {"name": "set_volume", "params": {"level": 0-100}}
- Sesi artırma/azaltma: {"name": "adjust_volume", "params": {"delta": 15 veya -15}}
- Sesi kapatma/açma: {"name": "toggle_mute", "params": {"mute": true/false}}
- Medya kontrolü: {"name": "media_control", "params": {"command": "play_pause" | "next" | "prev"}}
- Uygulama açma: {"name": "open_app", "params": {"app": "chrome" | "youtube" | "spotify" | "vscode" | "notepad" | "calculator" | "explorer" | "taskmgr" | "settings" | "whatsapp"}}
- Belirli bir web sitesi / kanal / profil URL'si açma: {"name": "open_url", "params": {"url": "https://..."}}
- YouTube'da arama yapma: {"name": "search_youtube", "params": {"query": "aranacak terim"}}
- Google'da arama yapma: {"name": "search_google", "params": {"query": "aranacak terim"}}
- Sistem/Pencere kontrolü: {"name": "system_control", "params": {"command": "lock" | "show_desktop" | "alt_tab" | "close_window" | "sleep" | "wake" | "shutdown" | "cancel_shutdown"}}
- Bilgisayara metin yazma: {"name": "type_text", "params": {"text": "yazılacak metin", "enter": true/false}}
- Ekran görüntüsü alma: {"name": "screenshot", "params": {}}
- Bilgisayar hoparlöründen sesli konuşma (TTS): {"name": "speak_on_pc", "params": {"text": "söylenecek cümle"}}
- Not kaydetme: {"name": "add_note", "params": {"text": "not metni"}}
- Sohbet geçmişini / eski konuşmaları silme: {"name": "clear_chat", "params": {}}
${features.promptSection}
${mailMod.promptSection}
${smsMod.promptSection}
${extrasMod.promptSection}
- NOT (Tarayıcı): Web sitesi, arama veya link açarken ASLA run_powershell kullanma; daima open_url / search_google / search_youtube / open_app ("chrome") kullan (tarayıcı olarak her zaman Google Chrome açılır).
- NOT (Canlı ekran): Ekran görüntüsü yedek telemetri çizimi gösteriyorsa sunucu kullanıcının masaüstü oturumunda çalışmıyor demektir. Bunu run_powershell ile ÇÖZMEYE ÇALIŞMA; kullanıcıdan "Baslat-JARVIS.bat" dosyasına (JARVIS proje klasöründe ve masaüstündeki kısayolda) kendisinin çift tıklamasını iste.

YANITINI SADECE AŞAĞIDAKİ JSON FORMATINDA DÖNDÜR (Başka hiçbir açıklama veya markdown ekleme):
{"reply": "Kullanıcıya söylenecek doğal Türkçe yanıt", "action": null veya {"name": "...", "params": {...}}}`;
}

async function executeParsedAction(actionObj) {
  if (!actionObj || !actionObj.name) return null;
  try {
    if (actionObj.name === 'screenshot') {
      const shot = await psBridge.captureScreen(0.7, 70);
      return { type: 'screenshot', screenshot: shot };
    }
    return await executePCAction(actionObj.name, actionObj.params || {});
  } catch (e) {
    console.error('Action execution error:', e.message);
    return { ok: false, error: e.message };
  }
}

function enrichReplyWithActionOutput(reply, actionResult) {
  if (!actionResult) return reply;
  if (actionResult.type === 'powershell_output' && actionResult.output) {
    return `${reply}\n\n💻 Sonuç:\n${actionResult.output}`;
  }
  if (actionResult.type === 'clipboard_data' && actionResult.text) {
    return `${reply}\n\n📋 Pano: "${actionResult.text}"`;
  }
  if (actionResult.type === 'screenshot' && actionResult.analysis) {
    return actionResult.analysis;
  }
  if (actionResult.display) {
    return `${reply}\n\n${actionResult.display}`;
  }
  if (actionResult.ok === false && actionResult.message) {
    return `${reply}\n\n⚠️ ${actionResult.message}`;
  }
  return reply;
}

function parseJsonSafely(rawText) {
  if (!rawText) return null;
  const cleaned = String(rawText)
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (e2) {}
    }
    return { reply: cleaned, action: null };
  }
}

async function askGeminiWithTools(userPrompt) {
  const sysInstruction = buildJarvisSystemPrompt();
  const modelsToTry = [
    'gemini-3.5-flash-lite',
    'gemini-3.5-flash',
    'gemini-3.7-flash',
    'gemini-3.1-flash-lite'
  ];

  for (const modelName of modelsToTry) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${config.geminiApiKey}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(7500),
        body: JSON.stringify({
          system_instruction: { parts: [{ text: sysInstruction }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.45
          }
        })
      });

      if (!resp.ok) continue;
      const data = await resp.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const textPart = parts.find((p) => p.text) || parts[0];
      const parsed = parseJsonSafely(textPart?.text);
      if (parsed && parsed.reply) {
        const actionResult = await executeParsedAction(parsed.action);
        return { reply: enrichReplyWithActionOutput(parsed.reply, actionResult), actionResult };
      }
    } catch (e) {}
  }
  return null;
}

async function askFreeCloudLLM(userPrompt) {
  const sysInstruction = buildJarvisSystemPrompt();
  const resp = await fetch('https://text.pollinations.ai/openai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(8000),
    body: JSON.stringify({
      model: 'openai',
      messages: [
        { role: 'system', content: sysInstruction },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.4
    })
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  const raw = data?.choices?.[0]?.message?.content;
  const parsed = parseJsonSafely(raw);
  if (parsed && parsed.reply) {
    const actionResult = await executeParsedAction(parsed.action);
    return { reply: enrichReplyWithActionOutput(parsed.reply, actionResult), actionResult };
  }
  return null;
}

async function askOllama(userPrompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const resp = await fetch(`${config.ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.ollamaModel || 'llama3.2',
        prompt: `${buildJarvisSystemPrompt()}\nKullanıcı: ${userPrompt}\nJSON Yanıt:`,
        stream: false
      })
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const data = await resp.json();
    const parsed = parseJsonSafely(data?.response);
    if (parsed && parsed.reply) {
      const actionResult = await executeParsedAction(parsed.action);
      return { reply: enrichReplyWithActionOutput(parsed.reply, actionResult), actionResult };
    }
  } catch (e) {
    clearTimeout(timer);
  }
  return null;
}

// ============================================================================
// TELEGRAM BOT BRIDGE (Full Remote Control + Photo Screenshots + Keyboard)
// ============================================================================
let telegramOffset = 0;
let telegramPolling = false;

const makeKb = (rows) => ({ keyboard: rows, resize_keyboard: true, is_persistent: true });

const TELEGRAM_MENUS = {
  main: {
    title: '🏠 *Ana Menü* — Bir kategori seçin veya doğrudan komut yazın:',
    markup: makeKb([
      [{ text: '🎵 Medya' }, { text: '🖥️ Ekran & Kamera' }, { text: '🔊 Ses' }],
      [{ text: '⚙️ Sistem & Güvenlik' }, { text: '📧 Mail & Modlar' }],
      [{ text: '📰 Günlük brifing' }, { text: '🪟 Açık uygulamalar' }, { text: '📊 Sistem durumu' }],
      [{ text: '📍 Konumumu Güncelle', request_location: true }, { text: '📝 Notlarımı oku' }, { text: '🗑️ Sohbeti temizle' }]
    ])
  },
  media: {
    title: '🎵 *Medya & Müzik Kontrolleri:*',
    markup: makeKb([
      [{ text: '⏮️ Önceki şarkı' }, { text: '⏯️ Oynat / Duraklat' }, { text: '⏭️ Sonraki şarkı' }],
      [{ text: '🎵 Spotify\'ı aç' }, { text: '▶️ YouTube\'u aç' }],
      [{ text: '⬅️ Ana Menü' }, { text: '🔊 Ses' }, { text: '🖥️ Ekran & Kamera' }]
    ])
  },
  screen: {
    title: '🖥️ *Ekran & Kamera Kontrolleri:*',
    markup: makeKb([
      [{ text: '📸 Ekran görüntüsü al' }, { text: '🔍 Ekranda ne var' }],
      [{ text: '📷 Kameradan fotoğraf çek' }, { text: '🔽 Masaüstünü göster' }],
      [{ text: '⬅️ Ana Menü' }, { text: '🎵 Medya' }, { text: '🔊 Ses' }]
    ])
  },
  audio: {
    title: '🔊 *Ses Ayarları:*',
    markup: makeKb([
      [{ text: '🔉 Sesi azalt' }, { text: '🔊 Sesi artır' }],
      [{ text: '🔊 Sesi yüzde 50 yap' }, { text: '🔊 Sesi fulle' }, { text: '🔇 Sesi kapat' }],
      [{ text: '⬅️ Ana Menü' }, { text: '🎵 Medya' }, { text: '🖥️ Ekran & Kamera' }]
    ])
  },
  system: {
    title: '⚙️ *Sistem & Güvenlik:*',
    markup: makeKb([
      [{ text: '☀️ Bilgisayarı uyandır' }, { text: '🌙 Uyku moduna al' }, { text: '🚨 Panik modu' }],
      [{ text: '🔒 Bilgisayarı kilitle' }, { text: '🚨 Güvenlik alarmı aç' }, { text: '🛡️ Güvenlik alarmı kapat' }],
      [{ text: '⏳ 30 dk sonra kapat' }, { text: '❌ Kapatmayı iptal' }, { text: '🚀 Otomatik başlat aç' }],
      [{ text: '🧹 Sistem temizliği' }, { text: '🪟 Açık uygulamalar' }, { text: '⬅️ Ana Menü' }]
    ])
  },
  modes: {
    title: '📧 *Mail & Hazır Modlar:*',
    markup: makeKb([
      [{ text: '📧 Mailimi kontrol et' }, { text: '📋 Maillerimi özetle' }],
      [{ text: '🎮 Oyun modu' }, { text: '💼 Çalışma modu' }, { text: '🌙 Gece modu' }],
      [{ text: '⬅️ Ana Menü' }, { text: '🎵 Medya' }, { text: '🔊 Ses' }]
    ])
  }
};

const TELEGRAM_TAB_TRIGGERS = {
  'ana menü': 'main',
  'geri': 'main',
  'medya': 'media',
  'ekran & kamera': 'screen',
  'ekran ve kamera': 'screen',
  'ses': 'audio',
  'sistem & güvenlik': 'system',
  'sistem ve güvenlik': 'system',
  'mail & modlar': 'modes',
  'mail ve modlar': 'modes'
};

const telegramUserMenu = {};

function getTelegramMarkup(chatId) {
  const key = telegramUserMenu[String(chatId)] || 'main';
  return (TELEGRAM_MENUS[key] || TELEGRAM_MENUS.main).markup;
}

async function pollTelegram() {
  if (!config.telegramBotToken || telegramPolling) return;
  telegramPolling = true;
  try {
    const url = `https://api.telegram.org/bot${config.telegramBotToken}/getUpdates?offset=${telegramOffset + 1}&timeout=10`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const data = await resp.json();
    if (data && data.ok && Array.isArray(data.result)) {
      for (const update of data.result) {
        telegramOffset = update.update_id;
        const msg = update.message;
        if (!msg) continue;
        const hasFile = Boolean(msg.document || msg.photo || msg.video || msg.audio || msg.voice);
        if (!msg.text && !hasFile && !msg.location) continue;
        const chatId = String(msg.chat.id);
        if (config.telegramAllowedChatId && config.telegramAllowedChatId !== chatId) {
          await sendTelegramMessage(chatId, `⛔ Yetkisiz erişim. Chat ID'niz: ${chatId}`);
          continue;
        }
        if (config.lastTelegramChatId !== chatId) {
          config.lastTelegramChatId = chatId;
          saveConfig();
        }
        if (msg.location) {
          const lat = Number(msg.location.latitude).toFixed(5);
          const lon = Number(msg.location.longitude).toFixed(5);
          config.geoCoords = `${lat},${lon}`;
          config.weatherCity = '';
          let placeLabel = `${lat}, ${lon}`;
          try {
            const geoRes = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=tr`, {
              signal: AbortSignal.timeout(5000)
            });
            if (geoRes.ok) {
              const gd = await geoRes.json();
              const dist = gd.locality || '';
              const prov = gd.city || gd.principalSubdivision || '';
              if (dist && prov && dist !== prov) placeLabel = `${dist}, ${prov}`;
              else if (prov || dist) placeLabel = prov || dist;
            }
          } catch (e) {}
          config.geoLabel = placeLabel;
          saveConfig();
          const w = await extrasMod.fetchWeather();
          const cleanW = w ? w.replace(/[^\p{L}\p{N}\s.,:°+\-()]/gu, '').replace(/\s+/g, ' ').trim() : '';
          const replyMsg = `📍 Gerçek GPS konumunuz güncellendi: *${placeLabel}* (${lat}, ${lon})${cleanW ? `\n🌤️ Anlık hava durumu: ${cleanW}` : ''}`;
          await sendTelegramMessage(chatId, replyMsg);
          broadcastSSE({ type: 'alert', message: replyMsg.replace(/\*/g, ''), speak: `Konumunuz ${placeLabel} olarak güncellendi.` });
          continue;
        }
        if (msg.voice) {
          const vt = await extrasMod.transcribeTelegramVoice(msg.voice.file_id);
          if (!vt.ok) {
            await sendTelegramMessage(chatId, `⚠️ Sesli mesaj çözülemedi: ${vt.error}`);
            continue;
          }
          await sendTelegramMessage(chatId, `🎙️ *Algılanan komut:* "${vt.text}"`);
          const res = await processJarvisCommand(vt.text);
          if (res.actionResult && res.actionResult.type === 'screenshot' && res.actionResult.screenshot?.image) {
            await sendTelegramPhoto(chatId, res.actionResult.screenshot.image, `🖥️ ${String(res.reply || '').slice(0, 900)}`);
          } else {
            await sendTelegramMessage(chatId, `🤖 *JARVIS:* ${res.reply}`);
          }
          continue;
        }
        if (hasFile) {
          await features.handleTelegramFile(chatId, msg);
          continue;
        }
        const rawText = msg.text.trim();
        const cleanText = rawText.startsWith('/')
          ? rawText
          : rawText.replace(/^[^\p{L}\p{N}]+/u, '').trim();

        const navKey = TELEGRAM_TAB_TRIGGERS[cleanText.toLocaleLowerCase('tr-TR')];
        if (rawText === '/start' || rawText === '/menu') {
          telegramUserMenu[chatId] = 'main';
          await sendTelegramMessage(
            chatId,
            `🤖 *J.A.R.V.I.S. Mark VII Çevrimiçi*\n\nHoş geldiniz ${config.userName}. Tuşlar artık kategorilere ayrıldı — aşağıdaki sekmelerden birini seçebilir veya doğrudan komut yazabilirsiniz.`
          );
        } else if (navKey) {
          telegramUserMenu[chatId] = navKey;
          await sendTelegramMessage(chatId, TELEGRAM_MENUS[navKey].title);
        } else if (rawText.startsWith('/cmd ')) {
          const psCmd = rawText.slice(5).trim();
          exec(psCmd, { cwd: terminalCwd, shell: 'powershell.exe', timeout: 12000 }, async (err, stdout, stderr) => {
            const out = [stdout, stderr].filter(Boolean).join('\n').trim() || (err ? err.message : 'Komut tamamlandı.');
            await sendTelegramMessage(chatId, `💻 *PowerShell Çıktısı:*\n\`\`\`\n${out.slice(0, 3500)}\n\`\`\``);
          });
        } else {
          const res = await processJarvisCommand(cleanText);
          if (res.actionResult && res.actionResult.type === 'screenshot' && res.actionResult.screenshot?.image) {
            const fullReply = String(res.reply || '');
            if (fullReply.length > 900) {
              await sendTelegramPhoto(chatId, res.actionResult.screenshot.image, '🖥️ J.A.R.V.I.S. analizi aşağıda:');
              await sendTelegramMessage(chatId, `🤖 *JARVIS:* ${fullReply}`);
            } else {
              await sendTelegramPhoto(chatId, res.actionResult.screenshot.image, `🖥️ ${fullReply}`);
            }
          } else if (res.actionResult && res.actionResult.type === 'briefing' && res.actionResult.briefing) {
            const b = res.actionResult.briefing;
            const newsTxt = (b.news || []).map((n, i) => `${i + 1}. [${n.source}] ${n.title}`).join('\n');
            const card = `📰 *GÜNLÜK BRİFİNG* (${b.date})\n\n🌤️ *Hava:* ${b.weather}\n💱 *Döviz:* USD ${b.usd} | EUR ${b.eur}${newsTxt ? `\n\n🌍 *Haberler:*\n${newsTxt}` : ''}`;
            await sendTelegramMessage(chatId, `🤖 *JARVIS:* ${res.reply}\n\n${card}`);
          } else {
            await sendTelegramMessage(chatId, `🤖 *JARVIS:* ${res.reply}`);
          }
        }
      }
    }
  } catch (e) {}
  telegramPolling = false;
}

async function sendTelegramMessage(chatId, text) {
  if (!config.telegramBotToken) return;
  const markup = getTelegramMarkup(chatId);
  try {
    const resp = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        reply_markup: markup
      })
    });
    if (!resp.ok) {
      await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: String(text || '').replace(/[*_`]/g, ''),
          reply_markup: markup
        })
      });
    }
  } catch (e) {}
}

async function sendTelegramPhoto(chatId, dataUrl, caption) {
  if (!config.telegramBotToken) return;
  try {
    const b64 = String(dataUrl).replace(/^data:image\/\w+;base64,/, '');
    const buf = Buffer.from(b64, 'base64');
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', caption || 'J.A.R.V.I.S. Ekran Görüntüsü');
    form.append('photo', new Blob([buf], { type: 'image/jpeg' }), 'screen.jpg');
    await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendPhoto`, {
      method: 'POST',
      body: form
    });
  } catch (e) {
    await sendTelegramMessage(chatId, caption || 'Ekran görüntüsü alındı.');
  }
}

// Gelişmiş özellikler: görsel analiz, dosya komutları, Telegram dosya aktarımı, akıllı uyarılar, hatırlatıcılar, makrolar
const features = require('./features')({
  getConfig: () => config,
  saveConfig,
  psBridge,
  DATA_DIR,
  UPLOAD_DIR,
  executePCAction,
  launchAndFocusOnDesktop,
  sendTelegramMessage,
  broadcastSSE
});

const mailMod = require('./mail')({
  getConfig: () => config,
  DATA_DIR,
  broadcastSSE,
  sendTelegramMessage
});

const smsMod = require('./sms')({
  getConfig: () => config,
  DATA_DIR,
  broadcastSSE,
  sendTelegramMessage,
  launchAndFocusOnDesktop,
  psBridge,
  getWeather: async (city = '') => {
    try { return await extrasMod.fetchWeather(city); } catch (e) { return null; }
  },
  detectCity: (text) => extrasMod.detectCityInText(text)
});

const extrasMod = require('./extras')({
  getConfig: () => config,
  saveConfig,
  psBridge,
  ROOT_DIR: __dirname,
  mailMod
});

setInterval(() => {
  if (config.telegramBotToken && !(config.cloudUrl && config.cloudSecret)) pollTelegram();
}, 2000);

// PC <-> Bulut Köprüsü: Render bulut sunucusundan bekleyen PC komutlarını 2.5sn'de bir alır
let cloudPolling = false;
async function pollCloudBridge() {
  if (cloudPolling || !config.cloudUrl || !config.cloudSecret) return;
  cloudPolling = true;
  try {
    const base = String(config.cloudUrl).replace(/\/+$/, '');
    const key = encodeURIComponent(config.cloudSecret);
    const resp = await fetch(`${base}/api/pc/poll?key=${key}`, { signal: AbortSignal.timeout(8000) });
    if (resp.ok) {
      const data = await resp.json();
      if (Array.isArray(data.jobs)) {
        for (const job of data.jobs) {
          let reply = 'Komut uygulandı.';
          try {
            const res = await processJarvisCommand(job.text);
            reply = res?.reply || reply;
          } catch (e) {
            reply = `Hata: ${e.message}`;
          }
          await fetch(`${base}/api/pc/result?key=${key}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: job.id, reply }),
            signal: AbortSignal.timeout(6000)
          }).catch(() => {});
        }
      }
    }
  } catch (e) {}
  cloudPolling = false;
}
setInterval(() => { pollCloudBridge().catch(() => {}); }, 2500);

// ============================================================================
// HTTP & API SERVER
// ============================================================================
function parseBody(req, maxBytes = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Jarvis-Pin',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
  });
  res.end(JSON.stringify(obj));
}

let terminalCwd = os.homedir();

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    return sendJSON(res, 200, { ok: true });
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  if (pathname.startsWith('/api/') && pathname !== '/api/auth/check' && config.pinCode) {
    const clientPin = req.headers['x-jarvis-pin'] || parsedUrl.searchParams.get('pin') || '';
    if (clientPin !== config.pinCode) {
      return sendJSON(res, 401, { error: 'PIN kodu gerekli veya hatalı.', pinRequired: true });
    }
  }

  try {
    // Direct Browser Google OAuth Flow for Gemini Pro
    if (pathname === '/api/auth/google') {
      const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
      if (!clientId) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('GOOGLE_OAUTH_CLIENT_ID ortam değişkeni ayarlı değil.');
      }
      const redirectUri = `http://127.0.0.1:${PORT}/oauth2callback`;
      const scope = [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile'
      ].join(' ');
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&access_type=offline&prompt=consent&scope=${encodeURIComponent(scope)}`;
      res.writeHead(302, { Location: authUrl });
      res.end();
      return;
    }

    if (pathname === '/oauth2callback') {
      const code = parsedUrl.searchParams.get('code');
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h2>Google girişi iptal edildi veya kod alınamadı.</h2>');
        return;
      }
      const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
      const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
      const redirectUri = `http://127.0.0.1:${PORT}/oauth2callback`;

      const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code'
        }).toString()
      });

      const tokens = await tokenResp.json();
      if (tokens && (tokens.access_token || tokens.refresh_token)) {
        if (tokens.expires_in && !tokens.expiry_date) {
          tokens.expiry_date = Date.now() + tokens.expires_in * 1000;
        }
        const geminiDir = path.join(os.homedir(), '.gemini');
        if (!fs.existsSync(geminiDir)) fs.mkdirSync(geminiDir, { recursive: true });
        fs.writeFileSync(path.join(geminiDir, 'oauth_creds.json'), JSON.stringify(tokens, null, 2), 'utf8');
        const settingsPath = path.join(geminiDir, 'settings.json');
        let existingSettings = {};
        if (fs.existsSync(settingsPath)) {
          try { existingSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch (e) {}
        }
        existingSettings.security = { ...(existingSettings.security || {}), auth: { selectedType: 'oauth-personal' } };
        fs.writeFileSync(settingsPath, JSON.stringify(existingSettings, null, 2), 'utf8');
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body style="background:#020710;color:#00f0ff;font-family:sans-serif;text-align:center;padding-top:80px;">
        <h1>✅ Google Gemini Pro Hesabınız Başarıyla Bağlandı!</h1>
        <p style="color:#fff;">J.A.R.V.I.S. artık Google hesabınızla eşleşti. Bu sekmeyi kapatabilir veya <a href="http://localhost:${PORT}" style="color:#f59e0b;">JARVIS Ekranına Dönmek İçin Tıklayabilirsiniz</a>.</p>
        <script>setTimeout(()=>window.location.href='http://localhost:${PORT}', 2000);</script>
      </body></html>`);
      return;
    }

    if (pathname === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      res.write(`data: ${JSON.stringify({ type: 'telemetry', telemetry: psBridge.lastTelemetry })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (pathname === '/api/info' && req.method === 'GET') {
      const ips = getLocalIPs();
      const primaryIp = ips.length > 0 ? ips[0].address : '127.0.0.1';
      return sendJSON(res, 200, {
        telemetry: psBridge.lastTelemetry,
        network: {
          ips,
          primaryUrl: `http://${primaryIp}:${PORT}`,
          port: PORT
        },
        shortcuts: {
          home: os.homedir(),
          desktop: path.join(os.homedir(), 'Desktop'),
          downloads: path.join(os.homedir(), 'Downloads'),
          documents: path.join(os.homedir(), 'Documents'),
          transfers: UPLOAD_DIR
        },
        config: {
          aiProvider: config.aiProvider,
          hasGeminiKey: Boolean(config.geminiApiKey),
          hasGoogleProOAuth: hasGoogleOAuth(),
          geminiModel: config.geminiModel,
          ollamaUrl: config.ollamaUrl,
          ollamaModel: config.ollamaModel,
          hasPin: Boolean(config.pinCode),
          hasTelegram: Boolean(config.telegramBotToken),
          telegramAllowedChatId: config.telegramAllowedChatId,
          gmailAddress: config.gmailAddress || '',
          hasGmail: Boolean(config.gmailAddress && config.gmailAppPassword),
          mailNotifyEnabled: config.mailNotifyEnabled !== false,
          smsWebhookUrl: config.smsWebhookUrl || '',
          smsContactsText: smsMod.getContactsText(),
          weatherCity: config.weatherCity || '',
          userName: config.userName,
          voiceEnabled: config.voiceEnabled,
          voiceProfile: config.voiceProfile || 'jarvis-ahmet',
          voiceProfiles: VOICE_PROFILES,
          voicePrintEnabled: Boolean(config.voicePrintEnabled),
          voicePrint: config.voicePrint || null,
          sfxEnabled: config.sfxEnabled
        },
        notes,
        chatHistory: chatHistory.slice(-30)
      });
    }

    if (pathname === '/api/tts' && (req.method === 'POST' || req.method === 'GET')) {
      let text = '';
      let profile = config.voiceProfile || 'jarvis-ahmet';
      if (req.method === 'POST') {
        const body = await parseBody(req);
        text = body.text || '';
        if (body.profile) profile = body.profile;
      } else {
        text = parsedUrl.searchParams.get('text') || '';
        if (parsedUrl.searchParams.get('profile')) profile = parsedUrl.searchParams.get('profile');
      }
      const mp3Buf = await synthesizeNeuralSpeech(text, profile);
      if (!mp3Buf) {
        return sendJSON(res, 500, { error: 'TTS üretilemedi' });
      }
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': mp3Buf.length,
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(mp3Buf);
      return;
    }

    if (pathname === '/api/action' && req.method === 'POST') {
      const body = await parseBody(req);
      const result = await executePCAction(body.action, body.params || {});
      return sendJSON(res, 200, result);
    }

    if (pathname === '/api/command' && req.method === 'POST') {
      const body = await parseBody(req);
      const result = await processJarvisCommand(body.text);
      return sendJSON(res, 200, result);
    }

    if (pathname === '/api/screen' && req.method === 'GET') {
      const scale = Number(parsedUrl.searchParams.get('scale') || 0.65);
      const quality = Number(parsedUrl.searchParams.get('quality') || 65);
      const shot = await psBridge.captureScreen(scale, quality);
      return sendJSON(res, 200, shot);
    }

    if (pathname === '/api/processes' && req.method === 'GET') {
      const procs = await psBridge.run(`
        Get-Process | Where-Object { $_.WorkingSet64 -gt 30MB } |
          Sort-Object WorkingSet64 -Descending |
          Select-Object -First 25 Id, ProcessName, MainWindowTitle, @{Name="MemoryMB";Expression={[math]::Round($_.WorkingSet64 / 1MB, 1)}}
      `);
      return sendJSON(res, 200, { processes: Array.isArray(procs) ? procs : [procs].filter(Boolean) });
    }

    if (pathname === '/api/processes/kill' && req.method === 'POST') {
      const body = await parseBody(req);
      const pid = Number(body.pid);
      await psBridge.run(`Stop-Process -Id ${pid} -Force`);
      return sendJSON(res, 200, { ok: true, message: `İşlem (${pid}) sonlandırıldı.` });
    }

    if (pathname === '/api/files/list' && req.method === 'GET') {
      const targetPath = path.resolve(parsedUrl.searchParams.get('path') || os.homedir());
      const entries = await fs.promises.readdir(targetPath, { withFileTypes: true });
      const items = [];
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(targetPath, entry.name);
        try {
          const stat = await fs.promises.stat(full);
          items.push({
            name: entry.name,
            path: full,
            isDir: entry.isDirectory(),
            size: entry.isDirectory() ? 0 : stat.size,
            modified: stat.mtime
          });
        } catch (e) {}
      }
      items.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'tr'));
      return sendJSON(res, 200, {
        currentPath: targetPath,
        parentPath: path.dirname(targetPath),
        items: items.slice(0, 200)
      });
    }

    if (pathname === '/api/files/download' && req.method === 'GET') {
      const filePath = path.resolve(parsedUrl.searchParams.get('path') || '');
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        return sendJSON(res, 404, { error: 'Dosya bulunamadı.' });
      }
      const filename = path.basename(filePath);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    if (pathname === '/api/files/upload' && req.method === 'POST') {
      const body = await parseBody(req, 100 * 1024 * 1024);
      const fileName = path.basename(body.fileName || `upload_${Date.now()}.bin`);
      const destDir = body.targetDir && fs.existsSync(body.targetDir) ? body.targetDir : UPLOAD_DIR;
      const destPath = path.join(destDir, fileName);
      const base64Data = String(body.data || '').replace(/^data:[^;]+;base64,/, '');
      fs.writeFileSync(destPath, Buffer.from(base64Data, 'base64'));
      return sendJSON(res, 200, {
        ok: true,
        path: destPath,
        message: `"${fileName}" başarıyla bilgisayara aktarıldı (${destDir}).`
      });
    }

    if (pathname === '/api/files/open' && req.method === 'POST') {
      const body = await parseBody(req);
      const filePath = path.resolve(body.path || '');
      await launchAndFocusOnDesktop(`cmd.exe /c start "" "${filePath.replace(/"/g, '')}"`, '');
      return sendJSON(res, 200, { ok: true, message: `"${path.basename(filePath)}" bilgisayar ekranında açıldı.` });
    }

    if (pathname === '/api/terminal/exec' && req.method === 'POST') {
      const body = await parseBody(req);
      const cmd = String(body.command || '').trim();
      if (!cmd) return sendJSON(res, 200, { output: '', cwd: terminalCwd });

      if (/^cd(\s+|$)/i.test(cmd)) {
        const target = cmd.replace(/^cd\s*/i, '').trim().replace(/^["']|["']$/g, '');
        const resolved = target ? path.resolve(terminalCwd, target) : os.homedir();
        if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
          terminalCwd = resolved;
          return sendJSON(res, 200, { output: `Dizin değiştirildi: ${terminalCwd}`, cwd: terminalCwd });
        } else {
          return sendJSON(res, 200, { output: `Dizin bulunamadı: ${resolved}`, cwd: terminalCwd, isError: true });
        }
      }

      exec(cmd, { cwd: terminalCwd, shell: 'powershell.exe', timeout: 15000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
        const out = [stdout, stderr].filter(Boolean).join('\n').trim() || (err ? err.message : 'Komut başarıyla tamamlandı (Çıktı yok).');
        sendJSON(res, 200, { output: out, cwd: terminalCwd, isError: Boolean(err) });
      });
      return;
    }

    if (pathname === '/api/notes' && req.method === 'POST') {
      const body = await parseBody(req);
      if (body.action === 'add') {
        const note = {
          id: crypto.randomUUID(),
          text: body.text,
          category: body.category || 'Genel',
          done: false,
          createdAt: new Date().toISOString()
        };
        notes.unshift(note);
        saveNotes();
        return sendJSON(res, 200, { ok: true, notes });
      }
      if (body.action === 'toggle') {
        const n = notes.find((x) => x.id === body.id);
        if (n) n.done = !n.done;
        saveNotes();
        return sendJSON(res, 200, { ok: true, notes });
      }
      if (body.action === 'delete') {
        notes = notes.filter((x) => x.id !== body.id);
        saveNotes();
        return sendJSON(res, 200, { ok: true, notes });
      }
      return sendJSON(res, 200, { notes });
    }

    if (pathname === '/api/settings' && req.method === 'POST') {
      const body = await parseBody(req);
      if (body.userName !== undefined) config.userName = body.userName || 'Efendim';
      if (body.aiProvider !== undefined) config.aiProvider = body.aiProvider;
      if (body.geminiApiKey !== undefined && body.geminiApiKey !== '***') config.geminiApiKey = body.geminiApiKey.trim();
      if (body.geminiModel !== undefined) config.geminiModel = body.geminiModel;
      if (body.ollamaUrl !== undefined) config.ollamaUrl = body.ollamaUrl;
      if (body.ollamaModel !== undefined) config.ollamaModel = body.ollamaModel;
      if (body.pinCode !== undefined) config.pinCode = String(body.pinCode).trim();
      if (body.telegramBotToken !== undefined && body.telegramBotToken !== '***') config.telegramBotToken = body.telegramBotToken.trim();
      if (body.telegramAllowedChatId !== undefined) config.telegramAllowedChatId = String(body.telegramAllowedChatId).trim();
      if (body.gmailAddress !== undefined) config.gmailAddress = String(body.gmailAddress).trim();
      if (body.gmailAppPassword !== undefined && body.gmailAppPassword !== '***') config.gmailAppPassword = String(body.gmailAppPassword).replace(/\s+/g, '').trim();
      if (body.mailNotifyEnabled !== undefined) config.mailNotifyEnabled = Boolean(body.mailNotifyEnabled);
      if (body.smsWebhookUrl !== undefined) config.smsWebhookUrl = String(body.smsWebhookUrl).trim();
      if (body.smsContactsText !== undefined) smsMod.setContactsFromText(body.smsContactsText);
      if (body.weatherCity !== undefined) config.weatherCity = String(body.weatherCity).trim();
      if (body.geoCoords !== undefined) config.geoCoords = String(body.geoCoords).trim();
      if (body.cloudUrl !== undefined) config.cloudUrl = String(body.cloudUrl).trim();
      if (body.cloudSecret !== undefined) config.cloudSecret = String(body.cloudSecret).trim();
      if (body.voiceEnabled !== undefined) config.voiceEnabled = Boolean(body.voiceEnabled);
      if (body.voiceProfile !== undefined && VOICE_PROFILES[body.voiceProfile]) config.voiceProfile = body.voiceProfile;
      if (body.voicePrintEnabled !== undefined) config.voicePrintEnabled = Boolean(body.voicePrintEnabled);
      if (body.voicePrint !== undefined) config.voicePrint = body.voicePrint;
      if (body.sfxEnabled !== undefined) config.sfxEnabled = Boolean(body.sfxEnabled);
      saveConfig();
      return sendJSON(res, 200, { ok: true, message: 'JARVIS yapılandırması güncellendi.' });
    }

    if (pathname === '/api/mail/test' && req.method === 'POST') {
      const result = await mailMod.testConnection();
      return sendJSON(res, result.ok ? 200 : 400, result);
    }

    if (pathname === '/api/sms/incoming' && req.method === 'POST') {
      const body = await parseBody(req);
      const result = await smsMod.handleIncomingSms(body);
      return sendJSON(res, result.ok ? 200 : 400, result);
    }

    let filePath = pathname === '/' ? '/index.html' : pathname;
    const fullPath = path.join(__dirname, 'public', path.normalize(filePath).replace(/^(\.\.[\/\\])+/, ''));
    if (fs.existsSync(fullPath) && !fs.statSync(fullPath).isDirectory()) {
      const ext = path.extname(fullPath).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.ico': 'image/x-icon'
      };
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
      fs.createReadStream(fullPath).pipe(res);
      return;
    }

    sendJSON(res, 404, { error: 'Sayfa bulunamadı.' });
  } catch (err) {
    sendJSON(res, 500, { error: err.message || 'Sunucu hatası' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIPs();
  const primaryIp = ips.length > 0 ? ips[0].address : '127.0.0.1';
  console.log('\n============================================================');
  console.log('   J.A.R.V.I.S. MARK VII - GEMINI 3.5 AI BRAIN ONLINE');
  console.log('============================================================');
  console.log(`Bilgisayar Arayüzü : http://localhost:${PORT}`);
  if (ips.length > 0) {
    ips.forEach((ip) => {
      console.log(`Telefon Bağlantısı : http://${ip.address}:${PORT}  (${ip.name})`);
    });
  }
  console.log('============================================================\n');

  if (config.telegramBotToken && config.lastTelegramChatId) {
    sendTelegramMessage(
      config.lastTelegramChatId,
      `🟢 *J.A.R.V.I.S. Çevrimiçi, ${config.userName}!*\nBilgisayarınız açıldı ve tüm sistemler kontrolünüze hazır.\n📱 Yerel Ağ HUD: \`http://${primaryIp}:${PORT}\``
    );
  }
});
