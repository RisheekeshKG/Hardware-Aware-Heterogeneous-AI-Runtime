use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, RunEvent};
use tauri_plugin_shell::process::CommandChild;

struct RuntimeProcesses(Mutex<Vec<CommandChild>>);

// Serializes service restarts (role switches, the restart after installing PyTorch) so two
// in-flight calls can't both drain stop_services and double-spawn, which left orphan runtimes
// bound to 8000/9000 in testing.
static ROLE_SWITCH: Mutex<()> = Mutex::new(());

static INSTALLING_TORCH: AtomicBool = AtomicBool::new(false);
// The running `uv pip install`, held here so cancel_torch_install can kill it. Downloads can stall
// on a bad connection without uv ever timing out (seen in testing), so the user needs a way out.
static INSTALL_PROCESS: Mutex<Option<std::process::Child>> = Mutex::new(None);
static INSTALL_CANCELLED: AtomicBool = AtomicBool::new(false);

/// Installed by uv on first launch. numpy isn't a torch dependency, but most user scripts import it.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn exe_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// The runtime and uv ship inside the app: `Contents/Resources/runtime/` in the macOS bundle and
/// a `runtime` folder beside the executable on Windows (the Inno Setup installer puts them there).
/// Debug builds also look in `src-tauri/runtime/`, where scripts/build-sidecar.* writes them.
fn bundled(app: &AppHandle, folder: &str, file: &str) -> PathBuf {
    let mut roots: Vec<PathBuf> = app
        .path()
        .resource_dir()
        .ok()
        .into_iter()
        .map(|dir| dir.join("runtime"))
        .collect();
    if let Some(exe_dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
    {
        roots.push(exe_dir.join("runtime"));
    }
    #[cfg(debug_assertions)]
    roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime"));
    let candidates: Vec<PathBuf> = roots.iter().map(|root| root.join(folder).join(file)).collect();
    candidates
        .iter()
        .find(|path| path.exists())
        .or(candidates.first())
        .cloned()
        .unwrap_or_else(|| PathBuf::from(file))
}

fn runtime_path(app: &AppHandle) -> PathBuf {
    bundled(app, "har-runtime-server", &exe_name("har-runtime-server"))
}

fn uv_path(app: &AppHandle) -> PathBuf {
    bundled(app, "uv", &exe_name("uv"))
}

/// Where uv installs PyTorch. Passed to the runtime as HAR_USER_PKGS_DIR, which
/// desktop_entry.py puts on sys.path before anything imports torch.
fn python_packages_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("python-packages"))
        .map_err(|error| error.to_string())
}

/// Downloaded PyTorch wheels, kept between installs so Repair/Reinstall don't download again.
/// A torch .whl copied here from another computer is used instead of downloading.
fn wheels_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("wheels"))
        .map_err(|error| error.to_string())
}

/// The JSON line printed by `har-runtime-server setup-check`.
#[derive(Deserialize)]
struct SetupCheck {
    torch_installed: bool,
    torch_version: Option<String>,
    import_error: Option<String>,
    python_version: String,
}

fn setup_check(app: &AppHandle, runtime: &Path) -> Result<SetupCheck, String> {
    let mut command = std::process::Command::new(runtime);
    command.arg("setup-check");
    if let Ok(packages) = python_packages_dir(app) {
        command.env("HAR_USER_PKGS_DIR", packages);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command
        .output()
        .map_err(|error| format!("could not run the HAR runtime: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let report = stdout
        .lines()
        .rev()
        .find(|line| line.trim_start().starts_with('{'))
        .ok_or_else(|| {
            format!(
                "the HAR runtime did not report its setup: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )
        })?;
    serde_json::from_str(report)
        .map_err(|error| format!("unreadable setup report from the HAR runtime: {error}"))
}

#[derive(Serialize)]
struct RuntimeStatus {
    installed: bool,
    torch_installed: bool,
    torch_version: Option<String>,
    /// Why torch didn't import, e.g. "No module named 'torch'" before first-launch setup.
    torch_error: Option<String>,
    installing: bool,
    /// Where downloaded wheels are kept (shown in Settings so they can be copied to another PC).
    wheels_dir: Option<String>,
}

fn current_status(app: &AppHandle) -> RuntimeStatus {
    let runtime = runtime_path(app);
    let installed = runtime.exists();
    let (torch_installed, torch_version, torch_error) = if !installed {
        (false, None, None)
    } else {
        match setup_check(app, &runtime) {
            Ok(check) => (check.torch_installed, check.torch_version, check.import_error),
            Err(error) => (false, None, Some(error)),
        }
    };
    RuntimeStatus {
        installed,
        torch_installed,
        torch_version,
        torch_error,
        installing: INSTALLING_TORCH.load(Ordering::SeqCst),
        wheels_dir: wheels_dir(app).ok().map(|dir| dir.display().to_string()),
    }
}

/// Async because setup-check starts the runtime, which imports torch when it's present.
#[tauri::command]
async fn runtime_status(app: AppHandle) -> Result<RuntimeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || current_status(&app))
        .await
        .map_err(|error| error.to_string())
}

#[derive(Clone, Serialize)]
struct InstallLog {
    line: String,
}

fn install_torch_blocking(app: &AppHandle) -> Result<(), String> {
    let python_version = setup_check(app, &runtime_path(app))?.python_version;
    let uv = uv_path(app);
    if !uv.exists() {
        return Err("This copy of HAR is missing its package installer (uv). Reinstall HAR.".to_string());
    }
    let target = python_packages_dir(app)?;
    let staging = target.with_file_name("python-packages.partial");
    if staging.exists() {
        std::fs::remove_dir_all(&staging).map_err(|error| error.to_string())?;
    }

    let cache = wheels_dir(app)?;

    // `install-torch` (har/runtime/torch_install.py) has uv resolve the right build for this
    // computer, downloads the big wheel itself in parallel, resumable pieces into `cache`, then
    // runs uv to install from it. Packages must match the runtime's own Python; uv downloads
    // that Python version to resolve against if the computer has none.
    let mut command = std::process::Command::new(runtime_path(app));
    command
        .arg("install-torch")
        .arg("--target")
        .arg(&staging)
        .arg("--uv")
        .arg(&uv)
        .arg("--cache")
        .arg(&cache)
        .args(["--python-version", &python_version])
        .env("UV_PYTHON_DOWNLOADS", "automatic")
        .env("UV_NO_CONFIG", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    // Own process group, so Cancel can stop the installer and the uv it starts together.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("could not start the PyTorch installer: {error}"))?;

    let recent = Arc::new(Mutex::new(VecDeque::new()));
    let streams: Vec<Box<dyn Read + Send>> = [
        child.stdout.take().map(|stream| Box::new(stream) as Box<dyn Read + Send>),
        child.stderr.take().map(|stream| Box::new(stream) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    .collect();
    let readers: Vec<_> = streams
        .into_iter()
        .map(|stream| {
            let app = app.clone();
            let recent = Arc::clone(&recent);
            std::thread::spawn(move || {
                // Decode leniently and never stop early: if this reader quit on a non-UTF-8
                // byte, the pipe would close and the installer's next print would fail
                // (EINVAL on Windows), killing the install.
                let mut reader = BufReader::new(stream);
                let mut raw = Vec::new();
                while reader.read_until(b'\n', &mut raw).is_ok_and(|read| read > 0) {
                    let line = String::from_utf8_lossy(&raw).trim().to_string();
                    raw.clear();
                    if line.is_empty() {
                        continue;
                    }
                    if let Ok(mut recent) = recent.lock() {
                        if recent.len() == 12 {
                            recent.pop_front();
                        }
                        recent.push_back(line.clone());
                    }
                    let _ = app.emit("torch-install-log", InstallLog { line });
                }
            })
        })
        .collect();
    *INSTALL_PROCESS.lock().map_err(|error| error.to_string())? = Some(child);
    // Poll rather than wait() so cancel_torch_install can take the lock and kill uv.
    let status = loop {
        let mut slot = INSTALL_PROCESS.lock().map_err(|error| error.to_string())?;
        let Some(child) = slot.as_mut() else {
            break None;
        };
        match child.try_wait() {
            Ok(Some(status)) => {
                *slot = None;
                break Some(status);
            }
            Ok(None) => {}
            Err(_) => {
                *slot = None;
                break None;
            }
        }
        drop(slot);
        std::thread::sleep(Duration::from_millis(200));
    };
    for reader in readers {
        let _ = reader.join();
    }
    if !status.is_some_and(|status| status.success()) {
        let _ = std::fs::remove_dir_all(&staging);
        if INSTALL_CANCELLED.swap(false, Ordering::SeqCst) {
            return Err("Install cancelled. The download is kept, so trying again continues where it stopped.".to_string());
        }
        let detail = recent
            .lock()
            .map(|lines| lines.iter().cloned().collect::<Vec<_>>().join("\n"))
            .unwrap_or_default();
        return Err(format!("PyTorch install failed.\n{detail}"));
    }

    // The runtime imports torch only at startup, and on Windows it holds files in the old folder
    // open, so stop it, swap the new folder in, and start it again even if the swap failed.
    let _guard = ROLE_SWITCH.lock().map_err(|error| error.to_string())?;
    stop_services(app);
    let swapped = (|| {
        if target.exists() {
            std::fs::remove_dir_all(&target)
                .map_err(|error| format!("could not replace the old PyTorch install: {error}"))?;
        }
        std::fs::rename(&staging, &target).map_err(|error| error.to_string())
    })();
    let restarted = start_services(app, &stored_role(app));
    swapped.and(restarted)
}

/// Installs PyTorch with the bundled uv. Async so the download (minutes; gigabytes for CUDA
/// builds) runs off the main thread. Progress arrives as `torch-install-log` events.
#[tauri::command]
async fn install_torch(app: AppHandle) -> Result<RuntimeStatus, String> {
    if INSTALLING_TORCH.swap(true, Ordering::SeqCst) {
        return Err("PyTorch is already being installed".to_string());
    }
    INSTALL_CANCELLED.store(false, Ordering::SeqCst);
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || install_torch_blocking(&handle))
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result);
    INSTALLING_TORCH.store(false, Ordering::SeqCst);
    result?;
    runtime_status(app).await
}

#[tauri::command]
fn cancel_torch_install() -> Result<(), String> {
    let mut slot = INSTALL_PROCESS.lock().map_err(|error| error.to_string())?;
    if let Some(child) = slot.as_mut() {
        INSTALL_CANCELLED.store(true, Ordering::SeqCst);
        kill_tree(child);
    }
    Ok(())
}

/// Stops the installer and whatever it started (uv). Killing only the parent would leave uv
/// running and holding the staging folder.
fn kill_tree(child: &mut std::process::Child) {
    let pid = child.id().to_string();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    #[cfg(unix)]
    {
        // The installer leads its own process group (process_group(0) at spawn).
        let _ = std::process::Command::new("kill")
            .args(["-KILL", &format!("-{pid}")])
            .status();
    }
    let _ = child.kill();
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

/// Spawns the services for `role` and records them. Callers stop the old ones first and hold
/// ROLE_SWITCH.
fn start_services(app: &AppHandle, role: &str) -> Result<(), String> {
    let children = spawn_services(app, &runtime_path(app), role)?;
    let state = app.state::<RuntimeProcesses>();
    *state.0.lock().map_err(|error| error.to_string())? = children;
    Ok(())
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

    let mut command = app
        .shell()
        .command(runtime)
        .args(args)
        .env("HAR_RUNTIME_ROLE", role)
        // The runtime exits on its own if this app dies without cleaning up,
        // so a crashed or force-quit app never leaves ports 8000/9000 taken.
        .env("HAR_PARENT_PID", std::process::id().to_string());
    if let Ok(packages) = python_packages_dir(app) {
        command = command.env("HAR_USER_PKGS_DIR", packages);
    }
    let (mut events, child) = command
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
        start_services(&app, &role)?;
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
            let runtime = runtime_path(&handle);
            let children = if runtime.exists() {
                spawn_services(&handle, &runtime, &role).unwrap_or_else(|error| {
                    eprintln!("could not start HAR runtime: {error}");
                    Vec::new()
                })
            } else {
                Vec::new()
            };
            app.manage(RuntimeProcesses(Mutex::new(children)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_runtime_role,
            runtime_role,
            runtime_status,
            install_torch,
            cancel_torch_install,
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
