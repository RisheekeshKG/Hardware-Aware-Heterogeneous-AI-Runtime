use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_shell::process::CommandChild;

struct RuntimeProcesses(Mutex<Vec<CommandChild>>);

// Serializes set_runtime_role so two in-flight calls can't both drain stop_services and
// double-spawn (which left orphan runtimes bound to 8000/9000 in testing).
static ROLE_SWITCH: Mutex<()> = Mutex::new(());

fn runtime_executable_name() -> &'static str {
    if cfg!(windows) {
        "har-runtime-server.exe"
    } else {
        "har-runtime-server"
    }
}

/// The runtime ships inside the app: `Contents/Resources/runtime/` in the macOS bundle and
/// a `runtime` folder beside the executable on Windows (the Inno Setup installer puts it there).
/// Debug builds also look in `src-tauri/runtime/`, where scripts/build-sidecar.* writes it.
fn runtime_path(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates = vec![app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("runtime")];
    if let Some(exe_dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
    {
        candidates.push(exe_dir.join("runtime"));
    }
    #[cfg(debug_assertions)]
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime"));
    let executable = |dir: &PathBuf| dir.join("har-runtime-server").join(runtime_executable_name());
    Ok(candidates
        .iter()
        .map(executable)
        .find(|path| path.exists())
        .unwrap_or_else(|| executable(&candidates[0])))
}

#[derive(Serialize)]
struct RuntimeStatus {
    installed: bool,
}

#[tauri::command]
fn runtime_status(app: AppHandle) -> RuntimeStatus {
    RuntimeStatus {
        installed: runtime_path(&app).map(|path| path.exists()).unwrap_or(false),
    }
}

fn stop_services(app: &AppHandle) {
    if let Some(state) = app.try_state::<RuntimeProcesses>() {
        if let Ok(mut children) = state.0.lock() {
            for child in children.drain(..) {
                let _ = child.kill();
            }
        }
    }
    // Give the OS a moment to release the files and ports the runtime held.
    std::thread::sleep(Duration::from_millis(800));
}

#[tauri::command]
fn start_runtime(app: AppHandle) -> Result<String, String> {
    let runtime = runtime_path(&app)?;
    if !runtime.exists() {
        return Err("HAR runtime is not installed yet".to_string());
    }
    let role = stored_role(&app);
    let state = app.state::<RuntimeProcesses>();
    let mut children = state.0.lock().map_err(|error| error.to_string())?;
    if children.is_empty() {
        *children = spawn_services(&app, &runtime, &role)?;
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
        // The runtime exits on its own if this app dies without cleaning up,
        // so a crashed or force-quit app never leaves ports 8000/9000 taken.
        .env("HAR_PARENT_PID", std::process::id().to_string())
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
    // A host must be reachable by workers on the network; other roles keep the
    // dashboard API on this computer only.
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

    // A host runs local workloads itself; only a worker needs the worker
    // service that other computers connect to.
    if role == "worker" {
        let worker = spawn_process(
            app,
            runtime,
            &[
                "worker",
                "--host",
                "0.0.0.0",
                "--port",
                "9000",
                "--advertise-url",
                "http://0.0.0.0:9000",
            ],
            role,
        );
        match worker {
            Ok(child) => children.push(child),
            Err(error) => {
                for child in children.drain(..) {
                    let _ = child.kill();
                }
                return Err(error);
            }
        }
    }
    Ok(children)
}

#[tauri::command]
fn runtime_role(app: AppHandle) -> String {
    stored_role(&app)
}

#[derive(Serialize)]
struct CpuInfo {
    brand: Option<String>,
    frequency_ghz: Option<f64>,
}

#[tauri::command]
fn cpu_info() -> CpuInfo {
    use std::process::Command;
    let mut brand: Option<String> = None;
    let mut frequency_ghz: Option<f64> = None;
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = Command::new("/usr/sbin/sysctl")
            .args(["-n", "machdep.cpu.brand_string"])
            .output()
        {
            let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !value.is_empty() {
                brand = Some(value);
            }
        }
        if let Ok(output) = Command::new("/usr/sbin/sysctl")
            .args(["-n", "hw.cpufrequency_max"])
            .output()
        {
            if let Ok(hz) = String::from_utf8_lossy(&output.stdout).trim().parse::<u64>() {
                if hz > 0 {
                    frequency_ghz = Some((hz as f64) / 1_000_000_000.0);
                }
            }
        }
        if frequency_ghz.is_none() {
            if let Ok(output) = Command::new("/usr/sbin/sysctl")
                .args(["-n", "hw.tbfrequency"])
                .output()
            {
                let _ = String::from_utf8_lossy(&output.stdout);
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(content) = std::fs::read_to_string("/proc/cpuinfo") {
            for line in content.lines() {
                let lower = line.to_lowercase();
                if brand.is_none() && lower.starts_with("model name") {
                    if let Some((_, value)) = line.split_once(':') {
                        let value = value.trim();
                        if !value.is_empty() {
                            brand = Some(value.to_string());
                        }
                    }
                }
                if frequency_ghz.is_none() && lower.starts_with("cpu mhz") {
                    if let Some((_, value)) = line.split_once(':') {
                        if let Ok(mhz) = value.trim().parse::<f64>() {
                            frequency_ghz = Some(mhz / 1000.0);
                        }
                    }
                }
                if brand.is_some() && frequency_ghz.is_some() {
                    break;
                }
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        // Windows 11 24H2 removed wmic by default, so a plain wmic call silently returns
        // nothing on newer installs. Try wmic first for compatibility, then PowerShell's
        // Get-CimInstance which is available everywhere wmic used to be.
        if let Ok(output) = Command::new("wmic")
            .args(["cpu", "get", "Name,MaxClockSpeed", "/format:value"])
            .output()
        {
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                let line = line.trim();
                if let Some(value) = line.strip_prefix("Name=") {
                    if !value.is_empty() {
                        brand = Some(value.to_string());
                    }
                } else if let Some(value) = line.strip_prefix("MaxClockSpeed=") {
                    if let Ok(mhz) = value.parse::<f64>() {
                        if mhz > 0.0 {
                            frequency_ghz = Some(mhz / 1000.0);
                        }
                    }
                }
            }
        }
        if brand.is_none() || frequency_ghz.is_none() {
            if let Ok(output) = Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-Command",
                    "Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name; (Get-CimInstance Win32_Processor | Select-Object -First 1).MaxClockSpeed",
                ])
                .output()
            {
                let text = String::from_utf8_lossy(&output.stdout);
                let lines: Vec<&str> = text.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
                if brand.is_none() {
                    if let Some(first) = lines.first() {
                        if !first.is_empty() {
                            brand = Some(first.to_string());
                        }
                    }
                }
                if frequency_ghz.is_none() {
                    if let Some(second) = lines.get(1) {
                        if let Ok(mhz) = second.parse::<f64>() {
                            if mhz > 0.0 {
                                frequency_ghz = Some(mhz / 1000.0);
                            }
                        }
                    }
                }
            }
        }
    }
    if let Some(ghz) = frequency_ghz {
        frequency_ghz = Some((ghz * 100.0).round() / 100.0);
    }
    CpuInfo { brand, frequency_ghz }
}

#[tauri::command]
async fn set_runtime_role(app: AppHandle, role: String) -> Result<String, String> {
    if !matches!(role.as_str(), "host" | "worker" | "standalone") {
        return Err("Role must be host, worker, or standalone".to_string());
    }
    let runtime = runtime_path(&app)?;
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&config_dir).map_err(|error| error.to_string())?;
    std::fs::write(config_dir.join("role"), format!("{role}\n"))
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = ROLE_SWITCH.lock().map_err(|error| error.to_string())?;
        stop_services(&app);
        let children = spawn_services(&app, &runtime, &role)?;
        let state = app.state::<RuntimeProcesses>();
        let mut current = state.0.lock().map_err(|error| error.to_string())?;
        *current = children;
        Ok(role)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let role = stored_role(&handle);
            // Never let a runtime problem stop the window from opening; the UI
            // reports a missing or disconnected runtime instead.
            let children = runtime_path(&handle)
                .ok()
                .filter(|runtime| runtime.exists())
                .and_then(|runtime| match spawn_services(&handle, &runtime, &role) {
                    Ok(children) => Some(children),
                    Err(error) => {
                        eprintln!("could not start HAR runtime: {error}");
                        None
                    }
                })
                .unwrap_or_default();
            app.manage(RuntimeProcesses(Mutex::new(children)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_runtime_role,
            runtime_role,
            runtime_status,
            start_runtime,
            cpu_info
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
