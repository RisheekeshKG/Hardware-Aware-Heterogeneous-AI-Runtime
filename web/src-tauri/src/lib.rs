#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            use tauri_plugin_shell::ShellExt;

            let (mut events, _child) = app
                .shell()
                .sidecar("har-runtime-server")?
                .args(["serve", "--host", "127.0.0.1", "--port", "8000"])
                .spawn()?;

            tauri::async_runtime::spawn(async move {
                while let Some(_event) = events.recv().await {}
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running HAR Runtime");
}
