//! Win32 plumbing: monitors (with DPI), top-level window enumeration, cursor, foreground.

use std::ffi::c_void;

use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
};
use windows::Win32::Graphics::Gdi::{
    ClientToScreen, EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO,
};
use windows::Win32::System::Threading::{
    AttachThreadInput, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, SetFocus, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_WHEEL,
    MOUSEINPUT, VK_ESCAPE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, EnumWindows, GetClassNameW, GetClientRect, GetCursorPos, GetForegroundWindow,
    GetWindowLongPtrW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetCursorPos, SetForegroundWindow,
    GWL_EXSTYLE, MONITORINFOF_PRIMARY, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
};

use crate::geometry::{best_monitor, scale_from_dpi, IRect};

#[derive(Debug, Clone)]
pub struct MonitorInfo {
    pub index: usize,
    /// Physical pixels, virtual-desktop coordinates.
    pub bounds: IRect,
    /// Device pixels per CSS pixel (1.0 = 100%).
    pub scale: f64,
    pub primary: bool,
    pub hmonitor: isize,
}

impl MonitorInfo {
    /// Layout fingerprint used to detect that overlays must be rebuilt.
    pub fn fingerprint(&self) -> (IRect, u64) {
        (self.bounds, (self.scale * 1000.0).round() as u64)
    }
}

unsafe extern "system" fn monitor_proc(
    hmon: HMONITOR,
    _hdc: HDC,
    _rect: *mut RECT,
    data: LPARAM,
) -> BOOL {
    // SAFETY: `data` is the `&mut Vec<MonitorInfo>` passed by `enumerate_monitors`, alive for
    // the whole synchronous EnumDisplayMonitors call.
    let list = unsafe { &mut *(data.0 as *mut Vec<MonitorInfo>) };
    let mut mi = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    // SAFETY: `mi.cbSize` is set; `hmon` was handed to us by the system.
    if unsafe { GetMonitorInfoW(hmon, &mut mi) }.as_bool() {
        let r = mi.rcMonitor;
        let (mut dx, mut dy) = (96u32, 96u32);
        // SAFETY: out-pointers are valid locals.
        let _ = unsafe { GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dx, &mut dy) };
        list.push(MonitorInfo {
            index: 0,
            bounds: IRect::new(r.left, r.top, r.right - r.left, r.bottom - r.top),
            scale: scale_from_dpi(dx),
            primary: mi.dwFlags & MONITORINFOF_PRIMARY != 0,
            hmonitor: hmon.0 as isize,
        });
    }
    BOOL(1)
}

/// All monitors, ordered left-to-right then top-to-bottom, with `index` assigned in that order.
pub fn enumerate_monitors() -> Result<Vec<MonitorInfo>, String> {
    let mut list: Vec<MonitorInfo> = Vec::new();
    // SAFETY: the callback only touches `list`, which outlives the call.
    let ok = unsafe {
        EnumDisplayMonitors(
            None,
            None,
            Some(monitor_proc),
            LPARAM(&mut list as *mut Vec<MonitorInfo> as isize),
        )
    };
    if !ok.as_bool() || list.is_empty() {
        return Err("Could not read the monitor layout.".to_string());
    }
    list.sort_by_key(|m| (m.bounds.x, m.bounds.y));
    for (i, m) in list.iter_mut().enumerate() {
        m.index = i;
    }
    Ok(list)
}

pub fn cursor_pos() -> Option<(i32, i32)> {
    let mut p = POINT::default();
    // SAFETY: valid out-pointer.
    unsafe { GetCursorPos(&mut p) }.ok().map(|_| (p.x, p.y))
}

/// A top-level window that is worth offering for capture.
#[derive(Debug, Clone)]
pub struct WinEntry {
    pub hwnd: isize,
    pub title: String,
    pub app: String,
    /// Visible frame (DWM extended frame bounds), global physical pixels.
    pub rect: IRect,
    /// `GetWindowRect`, including any invisible resize border.
    pub window_rect: IRect,
    pub monitor: usize,
}

const SKIP_CLASSES: [&str; 5] = [
    "Progman",
    "WorkerW",
    "Shell_TrayWnd",
    "Shell_SecondaryTrayWnd",
    "NotifyIconOverflowWindow",
];

struct EnumCtx {
    own_pid: u32,
    out: Vec<WinEntry>,
}

fn rect_of(r: RECT) -> IRect {
    IRect::new(r.left, r.top, r.right - r.left, r.bottom - r.top)
}

fn window_title(hwnd: HWND) -> String {
    // SAFETY: length query then bounded read into an owned buffer.
    unsafe {
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; len as usize + 1];
        let n = GetWindowTextW(hwnd, &mut buf);
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }
}

fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 128];
    // SAFETY: bounded buffer.
    let n = unsafe { GetClassNameW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

fn process_name(pid: u32) -> String {
    // SAFETY: the handle is closed on every path; the buffer length is passed alongside it.
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        let ok =
            QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
        let _ = CloseHandle(h);
        if ok.is_err() {
            return String::new();
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        std::path::Path::new(&path)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default()
    }
}

unsafe extern "system" fn window_proc(hwnd: HWND, data: LPARAM) -> BOOL {
    // SAFETY: `data` is the `&mut EnumCtx` passed by `enumerate_windows`.
    let ctx = unsafe { &mut *(data.0 as *mut EnumCtx) };
    // SAFETY: all calls below take the HWND just given to us by EnumWindows.
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return BOOL(1);
        }
        let mut cloaked = 0u32;
        let _ = DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut c_void,
            std::mem::size_of::<u32>() as u32,
        );
        if cloaked != 0 {
            return BOOL(1);
        }
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        if ex & WS_EX_TOOLWINDOW.0 != 0 && ex & WS_EX_APPWINDOW.0 == 0 {
            return BOOL(1);
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == ctx.own_pid {
            return BOOL(1);
        }
        let title = window_title(hwnd);
        if title.is_empty() {
            return BOOL(1);
        }
        let class = class_name(hwnd);
        if SKIP_CLASSES.contains(&class.as_str()) {
            return BOOL(1);
        }
        let mut wr = RECT::default();
        if GetWindowRect(hwnd, &mut wr).is_err() {
            return BOOL(1);
        }
        let mut fr = RECT::default();
        let have_frame = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut fr as *mut RECT as *mut c_void,
            std::mem::size_of::<RECT>() as u32,
        )
        .is_ok();
        let window_rect = rect_of(wr);
        let rect = if have_frame { rect_of(fr) } else { window_rect };
        if rect.w < 8 || rect.h < 8 {
            return BOOL(1);
        }
        ctx.out.push(WinEntry {
            hwnd: hwnd.0 as isize,
            title,
            app: process_name(pid),
            rect,
            window_rect,
            monitor: 0,
        });
    }
    BOOL(1)
}

/// Visible, uncloaked, non-minimised, non-tool windows that are not ours, front-most first.
pub fn enumerate_windows(monitors: &[MonitorInfo]) -> Vec<WinEntry> {
    let mut ctx = EnumCtx {
        own_pid: std::process::id(),
        out: Vec::new(),
    };
    // SAFETY: the callback only uses `ctx`, which outlives the synchronous call.
    let _ = unsafe { EnumWindows(Some(window_proc), LPARAM(&mut ctx as *mut EnumCtx as isize)) };
    let rects: Vec<IRect> = monitors.iter().map(|m| m.bounds).collect();
    let mut out = Vec::with_capacity(ctx.out.len());
    for mut w in ctx.out {
        if let Some(i) = best_monitor(&w.rect, &rects) {
            w.monitor = i;
            out.push(w);
        }
    }
    out
}

/// Bring `hwnd` to the foreground even when another process owns the foreground, by briefly
/// attaching to its input queue. Best effort.
pub fn force_foreground(hwnd: HWND) {
    // SAFETY: only manipulates window/thread state through documented calls.
    unsafe {
        let fg = GetForegroundWindow();
        let cur = GetCurrentThreadId();
        let fg_thread = if fg.0.is_null() {
            0
        } else {
            GetWindowThreadProcessId(fg, None)
        };
        let attach = fg_thread != 0 && fg_thread != cur;
        if attach {
            let _ = AttachThreadInput(cur, fg_thread, true);
        }
        let _ = BringWindowToTop(hwnd);
        let _ = SetForegroundWindow(hwnd);
        let _ = SetFocus(Some(hwnd));
        if attach {
            let _ = AttachThreadInput(cur, fg_thread, false);
        }
    }
}

/// Inject a vertical mouse-wheel event at screen position (`x`, `y`). The cursor is moved there
/// first because the wheel goes to the window under the pointer. Positive `delta` scrolls up.
pub fn send_wheel(x: i32, y: i32, delta: i32) -> Result<(), String> {
    // SAFETY: plain input injection; the INPUT struct outlives the call.
    unsafe {
        SetCursorPos(x, y).map_err(|_| "Could not move the pointer.".to_string())?;
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: delta as u32,
                    dwFlags: MOUSEEVENTF_WHEEL,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        if SendInput(&[input], std::mem::size_of::<INPUT>() as i32) == 1 {
            Ok(())
        } else {
            Err("Windows blocked the scroll input (is the target window running as administrator?).".to_string())
        }
    }
}

/// True while the Escape key is held down (polled; works without focus or a hook).
pub fn escape_pressed() -> bool {
    // SAFETY: plain key-state query.
    let state = unsafe { GetAsyncKeyState(i32::from(VK_ESCAPE.0)) };
    (state as u16) & 0x8000 != 0
}

/// The client area of `hwnd` in global physical pixels.
pub fn client_rect_global(hwnd: isize) -> Option<IRect> {
    let hwnd = HWND(hwnd as *mut c_void);
    let mut rc = RECT::default();
    let mut origin = POINT::default();
    // SAFETY: out-pointers are valid locals; `hwnd` is only used for these queries.
    unsafe {
        GetClientRect(hwnd, &mut rc).ok()?;
        if !ClientToScreen(hwnd, &mut origin).as_bool() {
            return None;
        }
    }
    let r = IRect::new(origin.x, origin.y, rc.right - rc.left, rc.bottom - rc.top);
    (r.w > 0 && r.h > 0).then_some(r)
}

/// Open Explorer with `path` selected.
pub fn reveal_in_explorer(path: &std::path::Path) -> Result<(), String> {
    std::process::Command::new("explorer.exe")
        .arg(format!("/select,{}", path.display()))
        .spawn()
        .map(|_| ())
        .map_err(|_| "Could not open File Explorer.".to_string())
}

/// Move the pointer to a global physical position.
pub fn set_cursor_pos(x: i32, y: i32) -> Result<(), String> {
    // SAFETY: plain call, no pointers.
    unsafe { SetCursorPos(x, y) }.map_err(|_| "Could not move the pointer.".to_string())
}

/// Parse the value from `reg query ... /v Name` output, e.g. `    SystemUsesLightTheme    REG_DWORD    0x1`.
pub fn parse_reg_dword(text: &str) -> Option<u32> {
    text.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let _name = parts.next()?;
        if parts.next()? != "REG_DWORD" {
            return None;
        }
        let v = parts.next()?;
        u32::from_str_radix(v.strip_prefix("0x")?, 16).ok()
    })
}

/// True when the Windows taskbar (and so the tray) uses the light theme; `None` if unknown.
pub fn taskbar_is_light() -> Option<bool> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
            "/v",
            "SystemUsesLightTheme",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    parse_reg_dword(&String::from_utf8_lossy(&out.stdout)).map(|v| v != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reg_output_is_parsed() {
        let out = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize\r\n    SystemUsesLightTheme    REG_DWORD    0x1\r\n\r\n";
        assert_eq!(parse_reg_dword(out), Some(1));
        assert_eq!(
            parse_reg_dword("    SystemUsesLightTheme    REG_DWORD    0x0"),
            Some(0)
        );
        assert_eq!(parse_reg_dword("    X    REG_DWORD    0xFF"), Some(255));
        assert_eq!(parse_reg_dword("    X    REG_SZ    hello"), None);
        assert_eq!(
            parse_reg_dword("ERROR: The system was unable to find the specified registry key"),
            None
        );
        assert_eq!(parse_reg_dword(""), None);
    }

    #[test]
    fn taskbar_theme_query_does_not_panic() {
        // Whatever the answer on this machine, it must be a clean Some/None.
        let _ = taskbar_is_light();
    }
}
