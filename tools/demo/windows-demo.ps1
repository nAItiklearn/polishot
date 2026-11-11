<#
.SYNOPSIS
  Records the Polishot Windows demo (about 30 to 45 seconds) against the CI-built installer.

.DESCRIPTION
  Installs Polishot silently from Polishot-Setup-x64.exe, launches it, records the primary screen with
  `ffmpeg -f gdigrab`, and drives this flow with synthetic mouse and keyboard input:

    capture a region (hotkey, then a drag over a made-up billing screen)
      -> the preview opens already auto-balanced and styled
      -> Redact tab: sensitive data found by the on-device scan
      -> blur it (Ctrl+Shift+B)
      -> Text tab: copy all recognised text (Ctrl+Shift+C, OCR)
      -> Export tab: save the PNG (Ctrl+S)

  The "screenshot" is tools\demo\assets\sample.html shown in a browser app window, so every run captures the
  same pixels. The script checks what it can (a capture was registered, the clipboard holds the recognised
  text, a PNG was saved) and reports each check.

  The installer cannot be built on the maintainer's laptop (no MSVC); get it from the CI run or the release:
    gh run download <run-id> -n polishot-windows-x64 -D tools\demo\out\installer
    .\windows-demo.ps1 -Download -Repo OWNER/REPO            # latest GitHub Release, checksum verified

  Synthetic input takes over the mouse and keyboard for about 40 seconds. Do not touch them while it runs.
  Close anything you do not want in the video first (the whole primary screen is recorded).

.PARAMETER InstallerPath
  Polishot-Setup-x64.exe, or a folder that contains it. Default: $env:POLISHOT_INSTALLER, then
  tools\demo\out\installer\, then your Downloads folder.

.PARAMETER Download
  Download the installer (and SHA256SUMS.txt) from a GitHub Release instead. Needs -Repo. -Tag defaults to the latest.

.PARAMETER AppExe
  Use this already-installed Polishot.exe and skip the install.

.PARAMETER SkipInstall
  Do not run the installer; use the copy that is already installed.

.PARAMETER InstallDir
  Install here (NSIS /D=). Default: the installer's own per-user location.

.PARAMETER UninstallAfter
  Run the uninstaller when the demo is done. Your settings and history in %APPDATA%\Polishot and
  %LOCALAPPDATA%\Polishot are kept.

.PARAMETER StopExisting
  Quit a Polishot that is already running (it is single-instance, so the demo needs a fresh one).

.PARAMETER Hotkey
  The capture shortcut. Default: the one in %APPDATA%\Polishot\settings.json, else Ctrl+Shift+2.

.PARAMETER Pace
  Multiplies every pause. 1 is the tuned pace (about 33 s of video); 1.3 gives a calmer 40 s.

.PARAMETER OutDir
  Where the video and run.json go. Default: tools\demo\out\windows (gitignored).

.PARAMETER Check
  Preflight only: checks ffmpeg and the browser, shows the sample window and records 3 seconds of it. Sends no
  mouse or keyboard input and installs nothing. Run this first.

.PARAMETER DryRun
  Print what would happen, run the preflight, and stop.

.EXAMPLE
  .\windows-demo.ps1 -Check
.EXAMPLE
  .\windows-demo.ps1 -InstallerPath C:\Users\me\Downloads\Polishot-Setup-x64.exe -UninstallAfter
.EXAMPLE
  .\windows-demo.ps1 -SkipInstall -Pace 1.25
#>
[CmdletBinding()]
param(
    [string]$InstallerPath,
    [switch]$Download,
    [string]$Repo,
    [string]$Tag,
    [string]$AppExe,
    [switch]$SkipInstall,
    [string]$InstallDir,
    [switch]$UninstallAfter,
    [switch]$StopExisting,
    [string]$Hotkey,
    [ValidateRange(0.4, 4.0)][double]$Pace = 1.0,
    [ValidateRange(10, 60)][int]$Fps = 30,
    [ValidateRange(1, 30)][int]$OcrWaitSeconds = 4,
    [string]$OutDir,
    [string]$FfmpegPath,
    [string]$Browser,
    [string]$ProductName = 'Polishot',
    [switch]$KeepWindows,
    [switch]$LeaveRunning,
    [switch]$Check,
    [switch]$DryRun
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$SampleHtml = Join-Path $Here 'assets\sample.html'
if (-not $OutDir) { $OutDir = Join-Path $Here 'out\windows' }
$InstallerName = 'Polishot-Setup-x64.exe'
$DefaultHotkey = 'Ctrl+Shift+2'
$VideoFile = Join-Path $OutDir 'polishot-windows-demo.mp4'
$RawFile = Join-Path $OutDir 'recording.mkv'
$Timeline = New-Object System.Collections.Specialized.OrderedDictionary
$Checks = New-Object System.Collections.ArrayList
$Clock = [System.Diagnostics.Stopwatch]::new()

function Write-Step([string]$Text) { Write-Host ("[windows-demo] {0}" -f $Text) }
function Write-Warn([string]$Text) { Write-Host ("[windows-demo] warning: {0}" -f $Text) -ForegroundColor Yellow }
function Stop-Demo([string]$Text) { throw $Text }

function Add-Check([string]$Name, [bool]$Ok, [string]$Detail) {
    [void]$Checks.Add([ordered]@{ name = $Name; ok = $Ok; detail = $Detail })
    $tag = if ($Ok) { 'ok  ' } else { 'FAIL' }
    $color = if ($Ok) { 'Green' } else { 'Red' }
    Write-Host ("[windows-demo] {0} {1}{2}" -f $tag, $Name, $(if ($Detail) { ": $Detail" } else { '' })) -ForegroundColor $color
}

function Mark([string]$Name) {
    if ($Clock.IsRunning) { $Timeline[$Name] = [math]::Round($Clock.Elapsed.TotalSeconds, 2) }
}

# Every pause in the flow goes through here so -Pace scales the whole demo.
function Pause-Demo([double]$Seconds) {
    Start-Sleep -Milliseconds ([int][math]::Round($Seconds * 1000 * $Pace))
}

# --------------------------------------------------------------------------------------------- Win32

if (-not ('PolishotDemoWin32' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public sealed class WinInfo
{
    public IntPtr Handle;
    public uint Pid;
    public string Title;
}

public static class PolishotDemoWin32
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public delegate bool EnumProc(IntPtr h, IntPtr p);

    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hgt, bool repaint);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr p);

    // Visible top-level windows that have a title.
    public static List<WinInfo> Windows()
    {
        List<WinInfo> list = new List<WinInfo>();
        EnumWindows(delegate (IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            StringBuilder sb = new StringBuilder(256);
            GetWindowText(h, sb, sb.Capacity);
            if (sb.Length == 0) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            WinInfo w = new WinInfo();
            w.Handle = h; w.Pid = pid; w.Title = sb.ToString();
            list.Add(w);
            return true;
        }, IntPtr.Zero);
        return list;
    }

    // The window's visible bounds (without the invisible resize borders Windows 10/11 add around it).
    public static RECT VisibleRect(IntPtr h)
    {
        RECT r;
        if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r);
        return r;
    }

    // Absolute pointer move; (x, y) are pixels on the primary screen (the process must be DPI aware).
    public static void MoveTo(int x, int y, int screenW, int screenH)
    {
        int nx = (int)Math.Round(x * 65535.0 / Math.Max(1, screenW - 1));
        int ny = (int)Math.Round(y * 65535.0 / Math.Max(1, screenH - 1));
        mouse_event(0x8001, nx, ny, 0, UIntPtr.Zero);   // MOVE | ABSOLUTE
    }
    public static void LeftDown() { mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); }
    public static void LeftUp() { mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero); }

    public static void Key(byte vk, bool up)
    {
        byte scan = (byte)MapVirtualKey(vk, 0);
        keybd_event(vk, scan, up ? 0x0002u : 0u, UIntPtr.Zero);
    }
}
'@
}
[void][PolishotDemoWin32]::SetProcessDPIAware()   # physical pixels from here on, so SetCursorPos-style maths matches the screen

$ScreenW = [PolishotDemoWin32]::GetSystemMetrics(0)
$ScreenH = [PolishotDemoWin32]::GetSystemMetrics(1)

# --------------------------------------------------------------------------------------------- input

$VkModifiers = @{ 'CTRL' = 0x11; 'CONTROL' = 0x11; 'SHIFT' = 0x10; 'ALT' = 0x12; 'WIN' = 0x5B; 'SUPER' = 0x5B }

function Get-VirtualKey([string]$Name) {
    $n = $Name.Trim().ToUpperInvariant()
    if ($n.Length -eq 1) {
        $c = [int][char]$n
        if (($c -ge 0x41 -and $c -le 0x5A) -or ($c -ge 0x30 -and $c -le 0x39)) { return $c }
        switch ($n) { ',' { return 0xBC } '.' { return 0xBE } '-' { return 0xBD } '=' { return 0xBB } '/' { return 0xBF } }
    }
    switch ($n) {
        'ESC' { return 0x1B } 'ESCAPE' { return 0x1B } 'ENTER' { return 0x0D } 'RETURN' { return 0x0D }
        'SPACE' { return 0x20 } 'TAB' { return 0x09 } 'DELETE' { return 0x2E } 'DEL' { return 0x2E }
    }
    if ($n -match '^F(\d{1,2})$' -and [int]$Matches[1] -ge 1 -and [int]$Matches[1] -le 24) { return 0x6F + [int]$Matches[1] }
    Stop-Demo "The key '$Name' in the shortcut is not supported by this script. Use a letter, digit, F-key, Esc, Enter, Space, Tab or Delete."
}

# Sends "Ctrl+Shift+B" style chords as real keystrokes.
function Send-Chord([string]$Chord) {
    $parts = $Chord.Split('+') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }
    if (-not $parts) { Stop-Demo "Empty shortcut." }
    $mods = New-Object System.Collections.ArrayList
    $keyName = $parts[-1]
    $modNames = @()
    if ($parts.Count -gt 1) { $modNames = @($parts[0..($parts.Count - 2)]) }
    foreach ($m in $modNames) {
        $k = $m.ToUpperInvariant()
        if (-not $VkModifiers.ContainsKey($k)) { Stop-Demo "'$m' in the shortcut '$Chord' is not a modifier (Ctrl, Shift, Alt, Win)." }
        [void]$mods.Add([int]$VkModifiers[$k])
    }
    $vk = Get-VirtualKey $keyName
    foreach ($m in $mods) { [PolishotDemoWin32]::Key([byte]$m, $false); Start-Sleep -Milliseconds 25 }
    [PolishotDemoWin32]::Key([byte]$vk, $false)
    Start-Sleep -Milliseconds 45
    [PolishotDemoWin32]::Key([byte]$vk, $true)
    for ($i = $mods.Count - 1; $i -ge 0; $i--) { Start-Sleep -Milliseconds 25; [PolishotDemoWin32]::Key([byte]$mods[$i], $true) }
}

function Move-Pointer([int]$X, [int]$Y) { [PolishotDemoWin32]::MoveTo($X, $Y, $ScreenW, $ScreenH) }

# Glides the pointer in small steps so the recording shows a human-looking motion. Uses the current position's
# last known coordinates (the script always starts a glide from where the previous one ended).
$script:PointerX = [int]($ScreenW / 2)
$script:PointerY = [int]($ScreenH / 2)
function Glide-Pointer([int]$X, [int]$Y, [double]$Seconds) {
    $ms = [math]::Max(80, [int]($Seconds * 1000 * $Pace))
    $steps = [math]::Max(8, [int]($ms / 16))
    $x0 = $script:PointerX; $y0 = $script:PointerY
    for ($i = 1; $i -le $steps; $i++) {
        $t = $i / $steps
        $e = $t * $t * (3 - 2 * $t)   # smoothstep
        Move-Pointer ([int]($x0 + ($X - $x0) * $e)) ([int]($y0 + ($Y - $y0) * $e))
        Start-Sleep -Milliseconds ([int]($ms / $steps))
    }
    $script:PointerX = $X; $script:PointerY = $Y
}

function Focus-Window($Window) {
    # A synthetic Alt tap lets SetForegroundWindow succeed when another process holds the foreground.
    [PolishotDemoWin32]::Key(0x12, $false); [PolishotDemoWin32]::Key(0x12, $true)
    if ([PolishotDemoWin32]::IsIconic($Window.Handle)) { [void][PolishotDemoWin32]::ShowWindow($Window.Handle, 9) }
    [void][PolishotDemoWin32]::SetForegroundWindow($Window.Handle)
}

function Find-Window([scriptblock]$Where, [int]$TimeoutMs) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    do {
        foreach ($w in [PolishotDemoWin32]::Windows()) { if (& $Where $w) { return $w } }
        Start-Sleep -Milliseconds 150
    } while ($sw.ElapsedMilliseconds -lt $TimeoutMs)
    return $null
}

# --------------------------------------------------------------------------------------------- preflight

function Resolve-Ffmpeg {
    $candidate = $null
    if ($FfmpegPath) {
        if (-not (Test-Path -LiteralPath $FfmpegPath)) { Stop-Demo "-FfmpegPath '$FfmpegPath' does not exist." }
        $candidate = (Resolve-Path -LiteralPath $FfmpegPath).Path
    } else {
        $cmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
        if ($cmd) { $candidate = $cmd.Source }
    }
    if (-not $candidate) {
        Stop-Demo ("ffmpeg was not found on PATH.`n" +
            "  Install it:   winget install Gyan.FFmpeg      (then open a new terminal)`n" +
            "  or point to it: .\windows-demo.ps1 -FfmpegPath C:\tools\ffmpeg\bin\ffmpeg.exe")
    }
    $devices = & $candidate -hide_banner -devices 2>&1 | Out-String
    if ($devices -notmatch 'gdigrab') {
        Stop-Demo "This ffmpeg ($candidate) was built without gdigrab, which the screen recording needs. Use a full build, for example: winget install Gyan.FFmpeg"
    }
    return $candidate
}

function Resolve-Browser {
    $paths = @()
    if ($Browser) { $paths += $Browser }
    $paths += @(
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe')
    )
    foreach ($p in $paths) { if ($p -and (Test-Path -LiteralPath $p)) { return (Resolve-Path -LiteralPath $p).Path } }
    Stop-Demo ("No Edge or Chrome was found to show the sample screen.`n" +
        "  Pass one explicitly: .\windows-demo.ps1 -Browser 'C:\path\to\msedge.exe'")
}

function Resolve-Installer {
    $searched = New-Object System.Collections.ArrayList
    $starts = @()
    if ($InstallerPath) { $starts += $InstallerPath }
    if ($env:POLISHOT_INSTALLER) { $starts += $env:POLISHOT_INSTALLER }
    $starts += (Join-Path $Here 'out\installer')
    $starts += (Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads')
    foreach ($s in $starts) {
        [void]$searched.Add($s)
        if (-not (Test-Path -LiteralPath $s)) { continue }
        $item = Get-Item -LiteralPath $s
        if ($item.PSIsContainer) {
            $f = Join-Path $item.FullName $InstallerName
            if (Test-Path -LiteralPath $f) { return $f }
        } else {
            return $item.FullName
        }
        if ($InstallerPath -and $s -eq $InstallerPath) { Stop-Demo "-InstallerPath '$InstallerPath' is a folder with no $InstallerName in it." }
    }
    Stop-Demo ("$InstallerName was not found. Looked in:`n    " + ($searched -join "`n    ") + "`n" +
        "  The installer is built by CI (it cannot be built on a machine without MSVC). Get it with one of:`n" +
        "    gh run download <run-id> -n polishot-windows-x64 -D tools\demo\out\installer     (the 'desktop' workflow artifact)`n" +
        "    .\windows-demo.ps1 -Download -Repo OWNER/REPO                                      (latest GitHub Release)`n" +
        "  or download it in a browser and pass -InstallerPath <file>. To use an already installed app: -SkipInstall.")
}

function Get-GitHubInstaller {
    if (-not $Repo -or $Repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { Stop-Demo "-Download needs -Repo in the form OWNER/REPO." }
    if ($Tag -and $Tag -notmatch '^[A-Za-z0-9_.+-]+$') { Stop-Demo "-Tag '$Tag' is not a valid tag name." }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $base = if ($Tag) { "https://github.com/$Repo/releases/download/$Tag" } else { "https://github.com/$Repo/releases/latest/download" }
    $dir = Join-Path $Here 'out\installer'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $dest = Join-Path $dir $InstallerName
    Write-Step "downloading $base/$InstallerName"
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$InstallerName" -OutFile $dest
    } catch {
        Stop-Demo ("Could not download the installer from $base/$InstallerName`n  $($_.Exception.Message)`n" +
            "  A private repository needs an authenticated download: gh release download -R $Repo -p $InstallerName -D `"$dir`"")
    }
    try {
        $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS.txt").Content
        $line = ($sums -split "`n" | Where-Object { $_ -match [regex]::Escape($InstallerName) } | Select-Object -First 1)
        if ($line) {
            $want = ($line.Trim() -split '\s+')[0].ToLowerInvariant()
            $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $dest).Hash.ToLowerInvariant()
            if ($want -ne $got) { Remove-Item -LiteralPath $dest -Force; Stop-Demo "SHA-256 mismatch for the downloaded installer (expected $want, got $got). The file was deleted." }
            Write-Step "checksum verified ($got)"
        } else { Write-Warn 'SHA256SUMS.txt has no entry for the installer; not verified.' }
    } catch { Write-Warn 'Could not fetch SHA256SUMS.txt; the installer was not checksum-verified.' }
    return $dest
}

function Find-InstalledApp {
    $dirs = New-Object System.Collections.ArrayList
    if ($InstallDir) { [void]$dirs.Add($InstallDir) }
    foreach ($root in 'HKCU:', 'HKLM:') {
        foreach ($sub in 'Software\Microsoft\Windows\CurrentVersion\Uninstall', 'Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall') {
            $key = "$root\$sub"
            if (-not (Test-Path -LiteralPath $key)) { continue }
            foreach ($k in Get-ChildItem -LiteralPath $key -ErrorAction SilentlyContinue) {
                $p = Get-ItemProperty -LiteralPath $k.PSPath -ErrorAction SilentlyContinue
                if ($p -and ($p.PSObject.Properties.Name -contains 'DisplayName') -and $p.DisplayName -eq $ProductName) {
                    if ($p.PSObject.Properties.Name -contains 'InstallLocation' -and $p.InstallLocation) { [void]$dirs.Add($p.InstallLocation.Trim('"')) }
                    if ($p.PSObject.Properties.Name -contains 'DisplayIcon' -and $p.DisplayIcon) { [void]$dirs.Add((Split-Path -Parent ($p.DisplayIcon.Trim('"') -replace ',\d+$', ''))) }
                }
            }
        }
    }
    foreach ($d in @("$env:LOCALAPPDATA\$ProductName", "$env:LOCALAPPDATA\Programs\$ProductName", "$env:ProgramFiles\$ProductName")) { [void]$dirs.Add($d) }
    foreach ($d in $dirs) {
        $exe = Join-Path $d "$ProductName.exe"
        if (Test-Path -LiteralPath $exe) { return (Resolve-Path -LiteralPath $exe).Path }
    }
    return $null
}

function Get-AppSettings {
    $file = Join-Path $env:APPDATA "$ProductName\settings.json"
    if (Test-Path -LiteralPath $file) {
        try { return Get-Content -Raw -LiteralPath $file | ConvertFrom-Json } catch { }
    }
    return $null
}

# --------------------------------------------------------------------------------------------- the subject window

function Open-Subject([string]$BrowserExe) {
    if (-not (Test-Path -LiteralPath $SampleHtml)) { Stop-Demo "Missing $SampleHtml." }
    $profileDir = Join-Path ([IO.Path]::GetTempPath()) ("polishot-demo-subject-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    $url = ([Uri]$SampleHtml).AbsoluteUri
    $argList = @("--app=$url", "--user-data-dir=`"$profileDir`"", '--no-first-run', '--no-default-browser-check',
        '--disable-extensions', '--disable-sync', '--disable-features=Translate,msEdgeSidebarV2')
    $proc = Start-Process -FilePath $BrowserExe -ArgumentList $argList -PassThru
    $win = Find-Window { param($w) $w.Title -like 'Northwind*' } 15000
    if (-not $win) {
        Stop-Demo "The sample window did not appear within 15 s. Is another dialog open? Try -Browser with a different browser."
    }
    # Fit the window to the screen, centred a little above the middle so the Polishot preview has room later.
    $w = [math]::Min(1320, $ScreenW - 120)
    $h = [math]::Min(860, $ScreenH - 140)
    $x = [int](($ScreenW - $w) / 2)
    $y = [math]::Max(10, [int](($ScreenH - $h) / 2) - 20)
    [void][PolishotDemoWin32]::MoveWindow($win.Handle, $x, $y, $w, $h, $true)
    Focus-Window $win
    Start-Sleep -Milliseconds 900
    $r = [PolishotDemoWin32]::VisibleRect($win.Handle)
    return [pscustomobject]@{ Process = $proc; Window = $win; ProfileDir = $profileDir; Left = $r.Left; Top = $r.Top; Right = $r.Right; Bottom = $r.Bottom }
}

function Close-Subject($Subject) {
    if (-not $Subject) { return }
    try { if ($Subject.Process -and -not $Subject.Process.HasExited) { [void]$Subject.Process.CloseMainWindow(); Start-Sleep -Milliseconds 600 } } catch { }
    # The app-mode window belongs to the browser process we started (it has its own profile folder), so this is safe.
    try { Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine.Contains($Subject.ProfileDir) } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } } catch { }
    Start-Sleep -Milliseconds 400
    try { Remove-Item -LiteralPath $Subject.ProfileDir -Recurse -Force -ErrorAction SilentlyContinue } catch { }
}

# --------------------------------------------------------------------------------------------- recording

$script:Recorder = $null

function Start-Recording([string]$Ffmpeg) {
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    Remove-Item -LiteralPath $RawFile -Force -ErrorAction SilentlyContinue
    $w = $ScreenW; $h = $ScreenH
    $ffArgs = @('-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'gdigrab', '-framerate', "$Fps", '-rtbufsize', '256M', '-draw_mouse', '1',
        '-offset_x', '0', '-offset_y', '0', '-video_size', "${w}x${h}", '-i', 'desktop',
        '-vf', "scale=w='min(1920,iw)':h=-2:flags=lanczos",
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-g', "$($Fps * 2)", $RawFile)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Ffmpeg
    $psi.Arguments = ($ffArgs | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardError = $true
    # ffmpeg is not DPI aware; without this gdigrab captures only part of a scaled (125%, 150%) screen.
    $psi.EnvironmentVariables['__COMPAT_LAYER'] = 'HIGHDPIAWARE'
    $p = [System.Diagnostics.Process]::Start($psi)
    $script:Recorder = [pscustomobject]@{ Process = $p; Errors = $p.StandardError.ReadToEndAsync() }
    # ffmpeg opens the output file once the first frame has been grabbed, so the file appearing means the video has
    # started. (It is not worth waiting for more bytes: x264 holds frames back for a while.)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt 8000) {
        if ($p.HasExited) { Stop-Demo ("ffmpeg stopped right away (exit $($p.ExitCode)):`n" + $script:Recorder.Errors.Result) }
        if (Test-Path -LiteralPath $RawFile) { break }
        Start-Sleep -Milliseconds 50
    }
    if (-not (Test-Path -LiteralPath $RawFile)) { Stop-Demo "ffmpeg did not start writing $RawFile within 8 s." }
    $Clock.Restart()
}

function Stop-Recording {
    if (-not $script:Recorder) { return $false }
    $p = $script:Recorder.Process
    $Clock.Stop()
    try {
        if (-not $p.HasExited) {
            $p.StandardInput.WriteLine('q'); $p.StandardInput.Flush()
            if (-not $p.WaitForExit(20000)) { $p.Kill(); [void]$p.WaitForExit(5000) }
        }
    } catch { try { $p.Kill() } catch { } }
    $err = ''
    try { $err = $script:Recorder.Errors.Result } catch { }
    $script:Recorder = $null
    if ($err.Trim()) { Write-Warn ("ffmpeg said: " + $err.Trim()) }
    return (Test-Path -LiteralPath $RawFile) -and ((Get-Item -LiteralPath $RawFile).Length -gt 4096)
}

function Finish-Video([string]$Ffmpeg) {
    # mkv survives a crash; mp4 with the index up front is what browsers and editors want.
    & $Ffmpeg -hide_banner -loglevel error -y -i $RawFile -c copy -movflags +faststart $VideoFile
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $VideoFile)) { Stop-Demo "Could not write $VideoFile from $RawFile (ffmpeg exit $LASTEXITCODE). The raw recording is still at $RawFile." }
    Remove-Item -LiteralPath $RawFile -Force -ErrorAction SilentlyContinue
}

function Get-VideoInfo([string]$File) {
    $probe = Join-Path (Split-Path -Parent $script:FfmpegExe) 'ffprobe.exe'
    if (-not (Test-Path -LiteralPath $probe)) { $c = Get-Command ffprobe -ErrorAction SilentlyContinue; $probe = if ($c) { $c.Source } else { $null } }
    if (-not $probe) { return $null }
    $out = & $probe -v error -select_streams v:0 -show_entries stream=width,height:format=duration -of default=nw=1 $File 2>$null
    $info = @{}
    foreach ($l in $out) { if ($l -match '^(\w+)=(.+)$') { $info[$Matches[1]] = $Matches[2] } }
    if ($info.Count -eq 0) { return $null }
    return $info
}

# --------------------------------------------------------------------------------------------- app log (optional signal)

$LogFile = Join-Path $env:LOCALAPPDATA "$ProductName\logs\timings.log"
function Get-UnixMs { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

# The app writes "<unix ms> <event>" lines to timings.log. It is a debug aid, not an API, so callers fall back to a fixed
# pause when a line never shows up.
function Wait-LogLine([string]$Pattern, [long]$SinceMs, [int]$TimeoutMs) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
        if (Test-Path -LiteralPath $LogFile) {
            $lines = Get-Content -LiteralPath $LogFile -Tail 120 -ErrorAction SilentlyContinue
            foreach ($l in $lines) {
                if ($l -match '^(\d{10,})\s+(.*)$' -and [long]$Matches[1] -ge $SinceMs -and $Matches[2] -match $Pattern) { return $true }
            }
        }
        Start-Sleep -Milliseconds 120
    }
    return $false
}

# --------------------------------------------------------------------------------------------- the demo

function Invoke-Preflight {
    if ($env:OS -ne 'Windows_NT') { Stop-Demo 'This script records a Windows desktop and only runs on Windows.' }
    if (-not [Environment]::UserInteractive) { Stop-Demo 'This needs an interactive desktop session (it moves the mouse and records the screen).' }
    $script:FfmpegExe = Resolve-Ffmpeg
    $script:BrowserExe = Resolve-Browser
    Write-Step "ffmpeg:  $script:FfmpegExe"
    Write-Step "browser: $script:BrowserExe"
    Write-Step ("screen:  {0} x {1} (primary monitor, physical pixels)" -f $ScreenW, $ScreenH)
    if ($ScreenW -lt 1280 -or $ScreenH -lt 720) { Write-Warn 'The screen is smaller than 1280x720; the sample window will be clipped.' }
}

function Invoke-Check {
    Write-Step 'check: showing the sample window and recording 3 seconds (no input is sent, nothing is installed)'
    $subject = $null
    try {
        $subject = Open-Subject $script:BrowserExe
        Start-Recording $script:FfmpegExe
        Start-Sleep -Seconds 3
        $ok = Stop-Recording
        if (-not $ok) { Stop-Demo 'The test recording is empty.' }
        Finish-Video $script:FfmpegExe
    } finally {
        if ($script:Recorder) { [void](Stop-Recording) }
        Close-Subject $subject
    }
    $info = Get-VideoInfo $VideoFile
    if ($info) {
        Write-Step ("test video: {0}x{1}, {2:N1} s -> {3}" -f $info['width'], $info['height'], [double]$info['duration'], $VideoFile)
        $expectW = [math]::Min(1920, $ScreenW)
        if ([int]$info['width'] -ne $expectW) {
            Write-Warn ("The video is {0} px wide but the screen is {1}. On a scaled display this means the capture is cropped; set the display scale to 100% for the recording, or run the demo from a terminal started as 'compatibility: high DPI aware'." -f $info['width'], $ScreenW)
        }
    } else { Write-Step "test video written to $VideoFile (install ffprobe to see its size)" }
    Write-Step 'Open the file and look at it. If it shows the full screen with the sample window in it, the real run will work.'
}

function Invoke-Demo {
    # 1. Installer ---------------------------------------------------------------------------------------------
    $installer = $null
    if (-not $SkipInstall -and -not $AppExe) {
        $installer = if ($Download) { Get-GitHubInstaller } else { Resolve-Installer }
        Write-Step "installer: $installer"
    }
    $running = @(Get-Process -Name $ProductName -ErrorAction SilentlyContinue)
    if ($running.Count -gt 0) {
        if (-not $StopExisting) { Stop-Demo "$ProductName is already running (it is single-instance). Quit it from the tray, or pass -StopExisting." }
        Write-Step "stopping the running $ProductName"
        $running | Stop-Process -Force
        Start-Sleep -Seconds 1
    }

    if ($installer) {
        Unblock-File -LiteralPath $installer -ErrorAction SilentlyContinue   # skips the "downloaded from the internet" prompt
        $installArgs = @('/S')
        if ($InstallDir) { $installArgs += ('/D=' + $InstallDir) }   # NSIS: /D must be last and must not be quoted
        Write-Step ("installing silently: {0} {1}" -f (Split-Path -Leaf $installer), ($installArgs -join ' '))
        $p = Start-Process -FilePath $installer -ArgumentList $installArgs -Wait -PassThru
        if ($p.ExitCode -ne 0) { Stop-Demo "The installer exited with code $($p.ExitCode). Run it by hand once to see its message." }
    }
    $exe = if ($AppExe) { $AppExe } else { Find-InstalledApp }
    if (-not $exe -or -not (Test-Path -LiteralPath $exe)) {
        Stop-Demo ("Could not find $ProductName.exe after the install. Pass its path with -AppExe, for example`n" +
            "  .\windows-demo.ps1 -AppExe `"$env:LOCALAPPDATA\$ProductName\$ProductName.exe`"")
    }
    $exe = (Resolve-Path -LiteralPath $exe).Path
    Write-Step "app: $exe"

    # 2. Launch (lives in the tray; the windows are created hidden) --------------------------------------------
    $settings = Get-AppSettings
    $hotkeyToUse = if ($Hotkey) { $Hotkey } elseif ($settings -and $settings.PSObject.Properties.Name -contains 'shortcut' -and $settings.shortcut) { [string]$settings.shortcut } else { $DefaultHotkey }
    $saveFolder = if ($settings -and $settings.PSObject.Properties.Name -contains 'saveFolder' -and $settings.saveFolder) { [string]$settings.saveFolder } else { Join-Path ([Environment]::GetFolderPath('MyPictures')) $ProductName }
    $capturesDir = Join-Path $env:LOCALAPPDATA "$ProductName\captures"
    Write-Step "capture shortcut: $hotkeyToUse"
    $launchedAt = Get-UnixMs
    $app = Start-Process -FilePath $exe -PassThru
    if (-not (Wait-LogLine 'startup:' ($launchedAt - 500) 25000)) {
        Write-Warn 'The app did not log its start-up line; continuing after a fixed wait.'
    }
    Start-Sleep -Seconds 5   # the hidden preview and overlay windows finish loading
    $procName = [IO.Path]::GetFileNameWithoutExtension($exe)
    $appProc = Get-Process -Name $procName -ErrorAction SilentlyContinue | Select-Object -First 1
    # (A second launch of the single-instance app exits at once and hands over to the running one; that is fine.)
    if (-not $appProc) { Stop-Demo "$procName is not running after it was launched. Run `"$exe`" by hand to see why." }

    $subject = $null
    $demoOk = $false
    $shell = $null
    $startTime = Get-Date
    try {
        # 3. Clean stage ---------------------------------------------------------------------------------------
        if (-not $KeepWindows) { $shell = New-Object -ComObject Shell.Application; $shell.MinimizeAll(); Start-Sleep -Milliseconds 700 }
        $subject = Open-Subject $script:BrowserExe
        Write-Step ("subject window: {0},{1} to {2},{3}" -f $subject.Left, $subject.Top, $subject.Right, $subject.Bottom)
        Move-Pointer ([int]($ScreenW * 0.8)) ([int]($ScreenH * 0.85)); $script:PointerX = [int]($ScreenW * 0.8); $script:PointerY = [int]($ScreenH * 0.85)

        # 4. Record --------------------------------------------------------------------------------------------
        Start-Recording $script:FfmpegExe
        Write-Step 'recording'
        Mark 'start'
        Pause-Demo 3.2                                   # the viewer reads the screen that is about to be captured

        # 5. Capture ---------------------------------------------------------------------------------------------
        $before = Get-UnixMs
        Mark 'hotkey'
        Send-Chord $hotkeyToUse
        if (-not (Wait-LogLine 'overlay_ready|window\.show returned' $before 4000)) { Start-Sleep -Milliseconds 1200 } else { Start-Sleep -Milliseconds 500 }
        Mark 'overlay'
        $inset = 3
        $x0 = $subject.Left + $inset; $y0 = $subject.Top + $inset; $x1 = $subject.Right - $inset; $y1 = $subject.Bottom - $inset
        Glide-Pointer $x0 $y0 0.5
        [PolishotDemoWin32]::LeftDown()
        Start-Sleep -Milliseconds 120
        Glide-Pointer $x1 $y1 1.0
        Pause-Demo 0.35
        $beforeCommit = Get-UnixMs
        [PolishotDemoWin32]::LeftUp()
        $commitMs = Get-UnixMs
        Mark 'commit'

        $previewSeen = Wait-LogLine 'commit preview shown' $beforeCommit 6000
        $preview = Find-Window { param($w) $w.Title -eq $ProductName -and $w.Pid -eq $appProc.Id } 6000
        if (-not $preview) { Stop-Demo "The $ProductName preview window did not open after the capture. Is $hotkeyToUse taken by another program, or is the app's capture shortcut different? (-Hotkey)" }
        Focus-Window $preview
        $newCapture = $null
        if (Test-Path -LiteralPath $capturesDir) {
            $newCapture = Get-ChildItem -LiteralPath $capturesDir -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -ge $startTime } | Select-Object -First 1
        }
        Add-Check 'a capture was registered' ([bool]($previewSeen -or $newCapture)) $(if ($newCapture) { $newCapture.Name } else { 'preview window opened' })
        Mark 'preview'
        Pause-Demo 3.4                                   # the styled result: auto-balance, background, corners, shadow

        # 6. Redact ----------------------------------------------------------------------------------------------
        Focus-Window $preview
        Send-Chord 'Ctrl+2'                              # Redact tab: the "N found" list
        Mark 'redact-tab'
        # On-device OCR runs in the background from the moment of capture; make sure it has had time before blurring.
        $ocrLeft = ($OcrWaitSeconds * 1000) - ((Get-UnixMs) - $commitMs)
        if ($ocrLeft -gt 0) { Start-Sleep -Milliseconds ([int]$ocrLeft) }
        Pause-Demo 2.6
        Send-Chord 'Ctrl+Shift+B'                        # blur everything that was found
        Mark 'blur'
        Pause-Demo 3.0

        # 7. Text (OCR) ------------------------------------------------------------------------------------------
        Send-Chord 'Ctrl+3'
        Mark 'text-tab'
        Pause-Demo 1.8
        Send-Chord 'Ctrl+Shift+C'                        # copy all recognised text
        Mark 'copy-text'
        Start-Sleep -Milliseconds 700
        $clip = ''
        try { $clip = (Get-Clipboard -Raw -ErrorAction Stop) } catch { }
        if ($null -eq $clip) { $clip = '' }
        Add-Check 'the recognised text is on the clipboard' ($clip -match 'alex\.morgan@example\.com') ("{0} characters" -f $clip.Length)
        Pause-Demo 2.2

        # 8. Export ----------------------------------------------------------------------------------------------
        Send-Chord 'Ctrl+4'
        Mark 'export-tab'
        Pause-Demo 1.8
        Send-Chord 'Ctrl+S'                              # save to the save folder
        Mark 'save'
        $saved = $null
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        while ($sw.ElapsedMilliseconds -lt 10000 -and -not $saved) {
            if (Test-Path -LiteralPath $saveFolder) {
                $saved = Get-ChildItem -LiteralPath $saveFolder -File -ErrorAction SilentlyContinue |
                    Where-Object { $_.LastWriteTime -ge $startTime -and $_.Extension -match '^\.(png|jpe?g|webp)$' } | Select-Object -First 1
            }
            if (-not $saved) { Start-Sleep -Milliseconds 200 }
        }
        Add-Check 'the image was exported' ([bool]$saved) $(if ($saved) { $saved.FullName } else { "nothing new in $saveFolder" })
        Pause-Demo 3.6                                   # the "Saved to ..." toast
        Mark 'end'
        $demoOk = $true
    } finally {
        $recorded = $false
        try { $recorded = Stop-Recording } catch { Write-Warn $_.Exception.Message }
        Close-Subject $subject
        if ($shell) { try { $shell.UndoMinimizeALL() } catch { } }
        if (-not $LeaveRunning) { Get-Process -Name $procName -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue }
        if ($UninstallAfter) {
            $un = Join-Path (Split-Path -Parent $exe) 'uninstall.exe'
            if (Test-Path -LiteralPath $un) { Write-Step 'uninstalling'; Start-Process -FilePath $un -ArgumentList '/S' -Wait } else { Write-Warn "No uninstall.exe next to $exe." }
        }
        if ($recorded) { try { Finish-Video $script:FfmpegExe } catch { Write-Warn $_.Exception.Message } }
    }

    # 9. Report ------------------------------------------------------------------------------------------------
    $info = if (Test-Path -LiteralPath $VideoFile) { Get-VideoInfo $VideoFile } else { $null }
    $seconds = if ($info -and $info.ContainsKey('duration')) { [math]::Round([double]$info['duration'], 1) } else { $null }
    $summary = [ordered]@{
        ok = $demoOk; video = $VideoFile; seconds = $seconds; hotkey = $hotkeyToUse; app = $exe
        screen = "${ScreenW}x${ScreenH}"; pace = $Pace; timelineSeconds = $Timeline; checks = $Checks
        recordedAt = (Get-Date).ToString('o')
    }
    ($summary | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath (Join-Path $OutDir 'run.json') -Encoding UTF8
    if ($seconds) {
        Write-Step ("video: {0} ({1} s)" -f $VideoFile, $seconds)
        if ($seconds -lt 30) { Write-Warn "The video is under 30 s; run again with -Pace 1.2 for a calmer cut." }
        elseif ($seconds -gt 45) { Write-Warn "The video is over 45 s; run again with a smaller -Pace (for example 0.8) or trim it." }
    } elseif (Test-Path -LiteralPath $VideoFile) { Write-Step "video: $VideoFile" }
    $failed = @($Checks | Where-Object { -not $_['ok'] })
    if ($failed.Count -gt 0) {
        Write-Host ("[windows-demo] {0} check(s) failed. Watch the video before you use it." -f $failed.Count) -ForegroundColor Red
        return 2
    }
    return 0
}

# --------------------------------------------------------------------------------------------- entry

# Dot-sourcing (". .\windows-demo.ps1") loads the functions without running anything; handy for testing them.
if ($MyInvocation.InvocationName -eq '.') { return }

try {
    Invoke-Preflight
    if ($DryRun) {
        $installerNote = if ($SkipInstall -or $AppExe) { 'skipped (existing install)' } elseif ($Download) { "download from github.com/$Repo" } else { 'silent install of the CI-built installer' }
        Write-Host @"

Plan (nothing is executed in a dry run):
  1. installer   $installerNote
  2. launch      $ProductName lives in the tray; capture shortcut = $(if ($Hotkey) { $Hotkey } else { 'from settings.json, else ' + $DefaultHotkey })
  3. stage       minimise other windows, show assets\sample.html in a browser app window
  4. record      ffmpeg -f gdigrab, ${ScreenW}x${ScreenH}, $Fps fps -> $VideoFile
  5. capture     shortcut, then drag over the sample window
  6. polish      preview opens styled -> Ctrl+2 (Redact) -> Ctrl+Shift+B (blur) -> Ctrl+3 (Text) -> Ctrl+Shift+C (copy text) -> Ctrl+4 -> Ctrl+S (export)
  7. report      run.json with a timeline and the checks (capture registered, clipboard text, file saved)
"@
        exit 0
    }
    if ($Check) { Invoke-Check; exit 0 }
    $code = @(Invoke-Demo)[-1]   # the last value is the exit code, whatever else a command leaked onto the pipeline
    exit $code
} catch {
    Write-Host ""
    Write-Host ("ERROR: " + $_.Exception.Message) -ForegroundColor Red
    Write-Host ""
    exit 1
}
