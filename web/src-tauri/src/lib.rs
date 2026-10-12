use std::sync::Mutex;

use tauri::{Manager, RunEvent};
use tauri_plugin_shell::process::CommandChild;

struct RuntimeProcesses(Mutex<Vec<CommandChild>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            use tauri_plugin_shell::ShellExt;

            let (mut events, host_child) = app
                .shell()
                .sidecar("har-runtime-server")?
                .args([
                    "serve",
                    "--host",
                    "0.0.0.0",
                    "--port",
                    "8000",
                    "--advertise-url",
                    "http://0.0.0.0:8000",
                ])
                .set_process_group(true)
                .spawn()?;
            let (mut worker_events, worker_child) = app
                .shell()
                .sidecar("har-runtime-server")?
                .args([
                    "worker",
                    "--coordinator",
                    "http://127.0.0.1:8000",
                    "--host",
                    "0.0.0.0",
                    "--port",
                    "9000",
                    "--advertise-url",
                    "http://127.0.0.1:9000",
                    "--name",
                    "This device",
                ])
                .set_process_group(true)
                .spawn()?;
            app.manage(RuntimeProcesses(Mutex::new(vec![host_child, worker_child])));

            tauri::async_runtime::spawn(
                async move { while let Some(_event) = events.recv().await {} },
            );
            tauri::async_runtime::spawn(async move {
                while let Some(_event) = worker_events.recv().await {}
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building HAR Runtime");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            if let Some(processes) = app_handle.try_state::<RuntimeProcesses>() {
                if let Ok(mut children) = processes.0.lock() {
                    for child in children.drain(..) {
                        let _ = child.kill();
                    }
                }
            }
        }
    });
}
