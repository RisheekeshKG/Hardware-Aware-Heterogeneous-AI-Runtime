use std::path::{Path, PathBuf};
use std::sync::Mutex;

use flate2::read::GzDecoder;
use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_shell::process::CommandChild;

const RUNTIME_RELEASE_TAG: &str = "v0.3.3";
const RUNTIME_REPOSITORY: &str = "RisheekeshKG/Hardware-Aware-Heterogeneous-AI-Runtime";

struct RuntimeProcesses(Mutex<Vec<CommandChild>>);

fn runtime_path(app: &AppHandle) -> Result<PathBuf, String> {
    let runtime_name = if cfg!(windows) {
        "har-runtime-server.exe"
    } else {
        "har-runtime-server"
    };
    if let Ok(cache_dir) = app.path().app_data_dir() {
        for target in runtime_targets() {
            let cached = cache_dir.join("runtimes").join(target).join(runtime_name);
            if cached.exists() {
                return Ok(cached);
            }
        }
    }
    let bundled_runtime_dir = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("runtime")
        .join("har-runtime-server");
    let executable_runtime_dir = std::env::current_exe()
        .map_err(|error| error.to_string())?
        .parent()
        .ok_or_else(|| "application executable has no parent directory".to_string())?
        .join("runtime")
        .join("har-runtime-server");
    let runtime_dir = if bundled_runtime_dir.exists() {
        bundled_runtime_dir
    } else {
        executable_runtime_dir
    };
    Ok(runtime_dir.join(runtime_name))
}

fn runtime_target() -> &'static str {
    if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
        "macos-arm64"
    } else if cfg!(target_os = "macos") {
        "macos-x64"
    } else if cfg!(target_os = "windows") && has_nvidia_gpu() {
        "windows-x64-cuda"
    } else if cfg!(target_os = "windows") {
        "windows-x64-cpu"
    } else if cfg!(target_arch = "aarch64") {
        "linux-arm64-cpu"
    } else {
        "linux-x64-cpu"
    }
}

fn runtime_targets() -> Vec<&'static str> {
    if cfg!(target_os = "windows") && has_nvidia_gpu() {
        vec!["windows-x64-cuda", "windows-x64-cpu"]
    } else {
        vec![runtime_target()]
    }
}

fn has_nvidia_gpu() -> bool {
    std::process::Command::new("nvidia-smi")
        .arg("--query-gpu=name")
        .arg("--format=csv,noheader")
        .output()
        .map(|output| output.status.success() && !output.stdout.is_empty())
        .unwrap_or(false)
}

fn runtime_asset_name(target: &str) -> String {
    if cfg!(windows) {
        format!("har-runtime-{}.zip", target)
    } else {
        format!("har-runtime-{}.tar.gz", target)
    }
}

#[derive(Serialize)]
struct RuntimeStatus {
    installed: bool,
    target: String,
    asset: String,
    downloading: bool,
}

fn cached_runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("runtimes").join(runtime_target()))
        .map_err(|error| error.to_string())
}

fn runtime_is_installed(app: &AppHandle) -> bool {
    runtime_path(app).map(|path| path.exists()).unwrap_or(false)
}

#[tauri::command]
fn runtime_status(app: AppHandle) -> RuntimeStatus {
    RuntimeStatus {
        installed: runtime_is_installed(&app),
        target: runtime_target().to_string(),
        asset: runtime_asset_name(runtime_target()),
        downloading: false,
    }
}

#[tauri::command]
fn install_runtime(app: AppHandle) -> Result<RuntimeStatus, String> {
    if runtime_is_installed(&app) {
        return Ok(runtime_status(app));
    }
    let cache_dir = cached_runtime_dir(&app)?;
    let parent = cache_dir
        .parent()
        .ok_or_else(|| "runtime cache has no parent directory".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let client = reqwest::blocking::Client::new();
    let mut downloaded = None;
    for target in runtime_targets() {
        let asset = runtime_asset_name(target);
        let url = format!(
            "https://github.com/{}/releases/download/{}/{}",
            RUNTIME_REPOSITORY, RUNTIME_RELEASE_TAG, asset
        );
        let response = client
            .get(url)
            .send()
            .map_err(|error| format!("runtime download failed: {error}"))?;
        if response.status().is_success() {
            let bytes = response
                .bytes()
                .map_err(|error| format!("could not read runtime download: {error}"))?;
            downloaded = Some((target, asset, bytes));
            break;
        }
        if response.status() != reqwest::StatusCode::NOT_FOUND {
            return Err(format!(
                "runtime download returned HTTP {}",
                response.status()
            ));
        }
    }
    let (target, asset, bytes) = downloaded.ok_or_else(|| {
        "runtime download returned HTTP 404 for all compatible runtime assets".to_string()
    })?;
    let archive = parent.join(format!("{}.download", asset));
    std::fs::write(&archive, &bytes).map_err(|error| error.to_string())?;
    let destination = parent.join(target);
    let staging = parent.join(format!("{}.staging", target));
    if staging.exists() {
        std::fs::remove_dir_all(&staging).map_err(|error| error.to_string())?;
    }
    std::fs::create_dir_all(&staging).map_err(|error| error.to_string())?;
    if cfg!(windows) {
        let file = std::fs::File::open(&archive).map_err(|error| error.to_string())?;
        let mut zip = zip::ZipArchive::new(file)
            .map_err(|error| format!("could not open runtime archive: {error}"))?;
        zip.extract(&staging)
            .map_err(|error| format!("could not extract runtime: {error}"))?;
    } else {
        let file = std::fs::File::open(&archive).map_err(|error| error.to_string())?;
        let decoder = GzDecoder::new(file);
        tar::Archive::new(decoder)
            .unpack(&staging)
            .map_err(|error| format!("could not extract runtime: {error}"))?;
    }
    let extracted = staging.join("har-runtime-server");
    if !extracted.join("har-runtime-server").exists() {
        return Err("runtime archive has an unexpected layout".to_string());
    }
    if destination.exists() {
        std::fs::remove_dir_all(&destination).map_err(|error| error.to_string())?;
    }
    std::fs::rename(extracted, &destination).map_err(|error| error.to_string())?;
    std::fs::remove_dir_all(staging).map_err(|error| error.to_string())?;
    std::fs::remove_file(archive).map_err(|error| error.to_string())?;
    let runtime = runtime_path(&app)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(&runtime)
            .map_err(|error| error.to_string())?
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&runtime, permissions).map_err(|error| error.to_string())?;
    }
    Ok(runtime_status(app))
}

#[tauri::command]
fn start_runtime(app: AppHandle) -> Result<String, String> {
    let runtime = runtime_path(&app)?;
    if !runtime.exists() {
        return Err("HAR runtime is not installed yet".to_string());
    }
    let role = stored_role(&app);
    let state = app.state::<RuntimeProcesses>();
    if let Ok(mut children) = state.0.lock() {
        if children.is_empty() {
            *children = spawn_services(&app, &runtime, &role)?;
        }
    }
    Ok(role)
}

fn stored_role(app: &AppHandle) -> String {
    app.path()
        .app_config_dir()
        .ok()
        .map(|path| path.join("role"))
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|role| role.trim().to_string())
        .filter(|role| matches!(role.as_str(), "host" | "worker" | "standalone"))
        .unwrap_or_else(|| "host".to_string())
}

fn spawn_process(
    app: &AppHandle,
    runtime: &Path,
    args: &[&str],
    role: &str,
) -> Result<CommandChild, String> {
    use tauri_plugin_shell::ShellExt;

    let (mut events, child) = app
        .shell()
        .command(runtime)
        .args(args)
        .env("HAR_RUNTIME_ROLE", role)
        .set_process_group(true)
        .spawn()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn(async move { while let Some(_event) = events.recv().await {} });
    Ok(child)
}

fn spawn_services(
    app: &AppHandle,
    runtime: &Path,
    role: &str,
) -> Result<Vec<CommandChild>, String> {
    let host_bind = if role == "host" {
        "0.0.0.0"
    } else {
        "127.0.0.1"
    };
    let mut children = vec![spawn_process(
        app,
        runtime,
        &[
            "serve",
            "--host",
            host_bind,
            "--port",
            "8000",
            "--advertise-url",
            "http://0.0.0.0:8000",
            "--role",
            role,
        ],
        role,
    )?];

    // The host already executes local workloads through its coordinator.
    // Only a worker role needs the extra worker service process.
    if role == "worker" {
        let mut worker_args = vec![
            "worker",
            "--host",
            "0.0.0.0",
            "--port",
            "9000",
            "--advertise-url",
            "http://0.0.0.0:9000",
            "--name",
            "This device",
        ];
        if role == "host" {
            worker_args.extend(["--coordinator", "http://127.0.0.1:8000"]);
        }
        children.push(spawn_process(app, runtime, &worker_args, role)?);
    }
    Ok(children)
}

#[tauri::command]
fn set_runtime_role(app: AppHandle, role: String) -> Result<String, String> {
    if !matches!(role.as_str(), "host" | "worker" | "standalone") {
        return Err("Role must be host, worker, or standalone".to_string());
    }
    let runtime = runtime_path(&app)?;
    let state = app.state::<RuntimeProcesses>();
    if let Ok(mut children) = state.0.lock() {
        for child in children.drain(..) {
            let _ = child.kill();
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
        *children = spawn_services(&app, &runtime, &role)?;
    }
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&config_dir).map_err(|error| error.to_string())?;
    std::fs::write(config_dir.join("role"), format!("{role}\n"))
        .map_err(|error| error.to_string())?;
    Ok(role)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let role = stored_role(&handle);
            let children = runtime_path(&handle)
                .ok()
                .filter(|runtime| runtime.exists())
                .map(|runtime| spawn_services(&handle, &runtime, &role))
                .transpose()
                .map_err(std::io::Error::other)?
                .unwrap_or_default();
            app.manage(RuntimeProcesses(Mutex::new(children)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_runtime_role,
            runtime_status,
            install_runtime,
            start_runtime
        ])
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
