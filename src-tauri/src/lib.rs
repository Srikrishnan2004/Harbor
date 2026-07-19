use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;

/// Handle to the Harbor control daemon spawned as a child of the desktop app,
/// kept alive for the app's lifetime and killed on exit.
struct DaemonProcess(Mutex<Option<Child>>);

/// The URL the UI expects the daemon on (mirrors Settings.daemonPort default).
#[tauri::command]
fn daemon_url() -> String {
    let port = std::env::var("HARBOR_PORT").unwrap_or_else(|_| "4747".into());
    format!("http://127.0.0.1:{port}")
}

/// Try to start `harbor daemon` in the background. Best-effort: if the binary
/// isn't on PATH the UI simply shows a "start the daemon" message.
fn spawn_daemon() -> Option<Child> {
    Command::new("harbor").arg("daemon").spawn().ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let daemon = spawn_daemon();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(DaemonProcess(Mutex::new(daemon)))
        .invoke_handler(tauri::generate_handler![daemon_url])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<DaemonProcess>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(child) = guard.as_mut() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
