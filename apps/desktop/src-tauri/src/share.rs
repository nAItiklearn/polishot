//! Windows Share UI (DataTransferManager interop). Best effort: the share sheet needs a visible
//! window and some environments (Windows N editions, locked-down policies) lack it.

use std::path::Path;
use std::sync::Mutex;

use tauri::{AppHandle, Manager};
use windows::core::{factory, HSTRING};
use windows::ApplicationModel::DataTransfer::{DataRequestedEventArgs, DataTransferManager};
use windows::Foundation::TypedEventHandler;
use windows::Storage::StorageFile;
use windows::Storage::Streams::RandomAccessStreamReference;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
use windows::Win32::UI::Shell::IDataTransferManagerInterop;

use crate::winmgr;

/// Token of the previous `DataRequested` subscription, so repeated shares do not stack handlers.
static LAST_TOKEN: Mutex<Option<(isize, i64)>> = Mutex::new(None);

fn werr(e: windows::core::Error) -> String {
    e.message()
}

pub fn share_file(app: &AppHandle, path: &Path) -> Result<(), String> {
    // Resolve the file on this worker thread; the UI thread must not block on WinRT async calls.
    // SAFETY: plain WinRT initialisation.
    let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path.as_os_str()))
        .map_err(werr)?
        .join()
        .map_err(werr)?;
    let stream = RandomAccessStreamReference::CreateFromFile(&file).map_err(werr)?;
    let title = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let hwnd = app
        .get_webview_window(winmgr::PREVIEW)
        .ok_or("The main window is not available.")?
        .hwnd()
        .map_err(|e| e.to_string())?;
    let hwnd_raw = hwnd.0 as isize;

    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    app.run_on_main_thread(move || {
        let _ = tx.send(show(HWND(hwnd_raw as *mut _), stream, title));
    })
    .map_err(|e| e.to_string())?;
    // The share sheet is shown from the UI thread. If that thread is wedged, give up instead of
    // holding this worker (and the caller's spinner) forever.
    rx.recv_timeout(std::time::Duration::from_secs(10))
        .map_err(|_| "The share sheet did not respond.".to_string())?
}

fn show(hwnd: HWND, stream: RandomAccessStreamReference, title: String) -> Result<(), String> {
    let interop = factory::<DataTransferManager, IDataTransferManagerInterop>().map_err(werr)?;
    // SAFETY: `hwnd` is the live preview window handle.
    let dtm: DataTransferManager = unsafe { interop.GetForWindow(hwnd) }.map_err(werr)?;

    if let Ok(mut last) = LAST_TOKEN.lock() {
        if let Some((h, token)) = last.take() {
            if h == hwnd.0 as isize {
                let _ = dtm.RemoveDataRequested(token);
            }
        }
    }
    let handler = TypedEventHandler::<DataTransferManager, DataRequestedEventArgs>::new(
        move |_sender, args| {
            if let Some(args) = args.as_ref() {
                let data = args.Request()?.Data()?;
                data.Properties()?
                    .SetTitle(&HSTRING::from(title.as_str()))?;
                data.SetBitmap(&stream)?;
            }
            Ok(())
        },
    );
    let token = dtm.DataRequested(&handler).map_err(werr)?;
    if let Ok(mut last) = LAST_TOKEN.lock() {
        *last = Some((hwnd.0 as isize, token));
    }
    // SAFETY: same window handle as above.
    unsafe { interop.ShowShareUIForWindow(hwnd) }.map_err(werr)
}
