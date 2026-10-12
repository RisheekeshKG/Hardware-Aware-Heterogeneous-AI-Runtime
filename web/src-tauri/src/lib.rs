use std::{fs, path::PathBuf};

use tauri::Manager;

const RUNTIME_RELEASE: &str = "v0.1.0";
const RUNTIME_BASE_URL: &str = "https://github.com/RisheekeshKG/Hardware-Aware-Heterogeneous-AI-Runtime/releases/download";

fn runtime_target() -> &'static str {
    option_env!("TAURI_ENV_TARGET_TRIPLE").unwrap_or("unknown-target")
}

fn runtime_asset_name() -> String {
    let extension = if cfg!(windows) { ".exe" } else { "" };
    format!("har-runtime-server-{}{}", runtime_target(), extension)
}

fn ensure_runtime(app: &tauri::AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let asset_name = runtime_asset_name();
    let cache_dir = app.path().app_data_dir()?.join("runtime");
    fs::create_dir_all(&cache_dir)?;
    let cached = cache_dir.join(if cfg!(windows) { "har-runtime-server.exe" } else { "har-runtime-server" });

    if !cached.exists() {
        let base_url = std::env::var("HAR_RUNTIME_DOWNLOAD_BASE_URL")
            .unwrap_or_else(|_| RUNTIME_BASE_URL.to_string());
        let url = format!("{}/{}/{}", base_url.trim_end_matches('/'), RUNTIME_RELEASE, asset_name);
        let response = reqwest::blocking::get(url)?.error_for_status()?;
        let temporary = cached.with_extension("download");
        fs::write(&temporary, response.bytes()?)?;
        fs::rename(temporary, &cached)?;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&cached, fs::Permissions::from_mode(0o755))?;
    }
    Ok(cached)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            use tauri_plugin_shell::ShellExt;

            let bundled = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("binaries")
                .join(runtime_asset_name());
            let runtime = if bundled.exists() {
                bundled
            } else {
                ensure_runtime(app.handle())?
            };
            let (mut events, _child) = app
                .shell()
                .command(runtime)
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
