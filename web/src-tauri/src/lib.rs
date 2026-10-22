use std::collections::VecDeque;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, RunEvent};
use tauri_plugin_shell::process::CommandChild;

const RUNTIME_RELEASE_TAG: &str = concat!("v", env!("CARGO_PKG_VERSION"));
const RUNTIME_REPOSITORY: &str = "RisheekeshKG/Hardware-Aware-Heterogeneous-AI-Runtime";

struct RuntimeProcesses(Mutex<Vec<CommandChild>>);

fn runtime_executable_name() -> &'static str {
    if cfg!(windows) {
        "har-runtime-server.exe"
    } else {
        "har-runtime-server"
    }
}

fn runtime_path(app: &AppHandle) -> Result<PathBuf, String> {
    let runtime_name = runtime_executable_name();
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
    static DETECTED: OnceLock<bool> = OnceLock::new();
    *DETECTED.get_or_init(|| {
        let mut command = std::process::Command::new("nvidia-smi");
        command.arg("--query-gpu=name").arg("--format=csv,noheader");
        #[cfg(windows)]
        {
            // Keep the GUI app from flashing a console window for nvidia-smi.
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        command
            .output()
            .map(|output| output.status.success() && !output.stdout.is_empty())
            .unwrap_or(false)
    })
}

fn runtime_asset_name(target: &str) -> String {
    if cfg!(windows) {
        format!("har-runtime-{}.zip", target)
    } else {
        format!("har-runtime-{}.tar.gz", target)
    }
}

/// Written next to a downloaded runtime so an app update can tell it is stale.
const RUNTIME_VERSION_FILE: &str = ".har-runtime-version";

static INSTALLING: AtomicBool = AtomicBool::new(false);

#[derive(Serialize)]
struct RuntimeStatus {
    installed: bool,
    target: String,
    asset: String,
    downloading: bool,
    /// Release tag of the installed runtime, when it was downloaded by the app.
    installed_version: Option<String>,
    expected_version: String,
    update_available: bool,
}

#[derive(Clone, Serialize)]
struct InstallProgress {
    stage: &'static str,
    asset: String,
    downloaded: u64,
    total: Option<u64>,
}

#[derive(Deserialize)]
struct Release {
    assets: Vec<ReleaseAsset>,
}

#[derive(Deserialize)]
struct ReleaseAsset {
    name: String,
    size: u64,
    browser_download_url: String,
}

struct DownloadPlan {
    target: &'static str,
    asset: String,
    /// Each published file (one, or numbered parts) with its size when known.
    parts: Vec<(String, Option<u64>)>,
    total: Option<u64>,
}

enum DownloadError {
    NotFound,
    Failed(String),
}

fn runtime_is_installed(app: &AppHandle) -> bool {
    runtime_path(app).map(|path| path.exists()).unwrap_or(false)
}

fn runtimes_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("runtimes"))
        .map_err(|error| error.to_string())
}

/// `None` for a runtime bundled with the app, which always matches the app.
fn installed_version(app: &AppHandle) -> Option<Option<String>> {
    let runtime = runtime_path(app).ok().filter(|path| path.exists())?;
    let runtime_dir = runtime.parent()?;
    let downloaded = runtimes_dir(app)
        .map(|dir| runtime_dir.starts_with(dir))
        .unwrap_or(false);
    if !downloaded {
        return None;
    }
    Some(
        std::fs::read_to_string(runtime_dir.join(RUNTIME_VERSION_FILE))
            .ok()
            .map(|version| version.trim().to_string()),
    )
}

fn current_status(app: &AppHandle) -> RuntimeStatus {
    let version = installed_version(app);
    RuntimeStatus {
        installed: runtime_is_installed(app),
        target: runtime_target().to_string(),
        asset: runtime_asset_name(runtime_target()),
        downloading: INSTALLING.load(Ordering::SeqCst),
        installed_version: version.clone().flatten(),
        expected_version: RUNTIME_RELEASE_TAG.to_string(),
        update_available: matches!(&version, Some(found) if found.as_deref() != Some(RUNTIME_RELEASE_TAG)),
    }
}

#[tauri::command]
fn runtime_status(app: AppHandle) -> RuntimeStatus {
    current_status(&app)
}

fn release_download_url(asset: &str) -> String {
    format!(
        "https://github.com/{}/releases/download/{}/{}",
        RUNTIME_REPOSITORY, RUNTIME_RELEASE_TAG, asset
    )
}

/// Lists the compatible runtimes in this release, best first. GitHub rejects
/// release assets over 2 GiB, so large runtimes (CUDA) are published as
/// numbered parts (`<asset>.001`, `<asset>.002`, ...) that are joined on download.
fn plan_downloads(client: &reqwest::blocking::Client) -> Result<Vec<DownloadPlan>, String> {
    let targets = runtime_targets();
    let release_url = format!(
        "https://api.github.com/repos/{}/releases/tags/{}",
        RUNTIME_REPOSITORY, RUNTIME_RELEASE_TAG
    );
    let release = client
        .get(release_url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .and_then(|response| response.error_for_status())
        .and_then(|response| response.json::<Release>());
    let Ok(release) = release else {
        // The release API is rate limited; fall back to each direct asset URL in turn.
        return Ok(targets
            .iter()
            .map(|&target| {
                let asset = runtime_asset_name(target);
                DownloadPlan {
                    target,
                    parts: vec![(release_download_url(&asset), None)],
                    asset,
                    total: None,
                }
            })
            .collect());
    };
    let mut plans = Vec::new();
    for &target in &targets {
        let asset = runtime_asset_name(target);
        if let Some(found) = release.assets.iter().find(|item| item.name == asset) {
            plans.push(DownloadPlan {
                target,
                asset,
                parts: vec![(found.browser_download_url.clone(), Some(found.size))],
                total: Some(found.size),
            });
            continue;
        }
        let prefix = format!("{asset}.");
        let mut parts: Vec<&ReleaseAsset> = release
            .assets
            .iter()
            .filter(|item| {
                item.name.strip_prefix(&prefix).is_some_and(|suffix| {
                    !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit())
                })
            })
            .collect();
        if !parts.is_empty() {
            parts.sort_by(|a, b| a.name.cmp(&b.name));
            plans.push(DownloadPlan {
                target,
                asset,
                parts: parts
                    .iter()
                    .map(|part| (part.browser_download_url.clone(), Some(part.size)))
                    .collect(),
                total: Some(parts.iter().map(|part| part.size).sum()),
            });
        }
    }
    if plans.is_empty() {
        return Err(format!(
            "release {} has no runtime for this computer ({})",
            RUNTIME_RELEASE_TAG,
            targets.join(", ")
        ));
    }
    Ok(plans)
}

// GitHub's release CDN can be slow per connection (~100 KB/s on some
// networks), so files of known size are fetched as byte ranges over several
// connections at once and written in place.
const DOWNLOAD_CONNECTIONS: usize = 8;
const DOWNLOAD_CHUNK_BYTES: u64 = 8 * 1024 * 1024;
const DOWNLOAD_CHUNK_ATTEMPTS: u32 = 5;
const DOWNLOAD_CHUNK_TIMEOUT: Duration = Duration::from_secs(300);

fn download(
    app: &AppHandle,
    client: &reqwest::blocking::Client,
    plan: &DownloadPlan,
    archive: &Path,
) -> Result<(), DownloadError> {
    let downloaded = AtomicU64::new(0);
    let report = || {
        let _ = app.emit(
            "runtime-install-progress",
            InstallProgress {
                stage: "downloading",
                asset: plan.asset.clone(),
                downloaded: downloaded.load(Ordering::Relaxed),
                total: plan.total,
            },
        );
    };
    report();
    let sizes: Option<Vec<u64>> = plan.parts.iter().map(|(_, size)| *size).collect();
    let result = match sizes {
        Some(sizes) => download_ranges(client, plan, &sizes, archive, &downloaded, &report),
        None => download_stream(client, plan, archive, &downloaded, &report),
    };
    report();
    result
}

fn download_ranges(
    client: &reqwest::blocking::Client,
    plan: &DownloadPlan,
    sizes: &[u64],
    archive: &Path,
    downloaded: &AtomicU64,
    report: &(dyn Fn() + Sync),
) -> Result<(), DownloadError> {
    let failed = |error: std::io::Error| DownloadError::Failed(error.to_string());
    let total: u64 = sizes.iter().sum();
    std::fs::File::create(archive)
        .and_then(|file| file.set_len(total))
        .map_err(failed)?;

    // (url, offset in the joined archive, first byte, last byte)
    let mut chunks = VecDeque::new();
    let mut part_offset = 0u64;
    for ((url, _), &size) in plan.parts.iter().zip(sizes) {
        let mut start = 0u64;
        while start < size {
            let end = (start + DOWNLOAD_CHUNK_BYTES).min(size) - 1;
            chunks.push_back((url.as_str(), part_offset + start, start, end));
            start = end + 1;
        }
        part_offset += size;
    }
    let queue = Mutex::new(chunks);
    let first_error: Mutex<Option<DownloadError>> = Mutex::new(None);

    std::thread::scope(|scope| {
        let workers: Vec<_> = (0..DOWNLOAD_CONNECTIONS)
            .map(|_| {
                scope.spawn(|| {
                    let mut file = match std::fs::OpenOptions::new().write(true).open(archive) {
                        Ok(file) => file,
                        Err(error) => {
                            first_error.lock().unwrap().get_or_insert(failed(error));
                            return;
                        }
                    };
                    let mut buffer = vec![0u8; 64 * 1024];
                    loop {
                        if first_error.lock().unwrap().is_some() {
                            return;
                        }
                        let Some((url, offset, start, end)) = queue.lock().unwrap().pop_front()
                        else {
                            return;
                        };
                        if let Err(error) = fetch_range(
                            client,
                            url,
                            (start, end),
                            &mut file,
                            offset,
                            &mut buffer,
                            downloaded,
                        ) {
                            first_error.lock().unwrap().get_or_insert(error);
                            return;
                        }
                    }
                })
            })
            .collect();
        while !workers.iter().all(|worker| worker.is_finished()) {
            report();
            std::thread::sleep(Duration::from_millis(250));
        }
    });

    match first_error.into_inner().unwrap() {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

/// Downloads one byte range into `file` at `offset`, retrying a dropped or
/// stalled connection a few times before giving up.
fn fetch_range(
    client: &reqwest::blocking::Client,
    url: &str,
    (start, end): (u64, u64),
    file: &mut std::fs::File,
    offset: u64,
    buffer: &mut [u8],
    downloaded: &AtomicU64,
) -> Result<(), DownloadError> {
    let mut last_error = String::new();
    for attempt in 1..=DOWNLOAD_CHUNK_ATTEMPTS {
        let mut written = 0u64;
        let result = (|| -> Result<(), DownloadError> {
            let failed = |error: String| DownloadError::Failed(error);
            let mut response = client
                .get(url)
                .header(reqwest::header::RANGE, format!("bytes={start}-{end}"))
                .timeout(DOWNLOAD_CHUNK_TIMEOUT)
                .send()
                .map_err(|error| failed(error.to_string()))?;
            if response.status() == reqwest::StatusCode::NOT_FOUND {
                return Err(DownloadError::NotFound);
            }
            if response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
                return Err(failed(format!("server returned HTTP {}", response.status())));
            }
            file.seek(SeekFrom::Start(offset))
                .map_err(|error| failed(error.to_string()))?;
            loop {
                let read = response
                    .read(buffer)
                    .map_err(|error| failed(error.to_string()))?;
                if read == 0 {
                    break;
                }
                file.write_all(&buffer[..read])
                    .map_err(|error| failed(format!("could not save runtime download: {error}")))?;
                written += read as u64;
                downloaded.fetch_add(read as u64, Ordering::Relaxed);
            }
            if written != end - start + 1 {
                return Err(failed("connection closed early".to_string()));
            }
            Ok(())
        })();
        match result {
            Ok(()) => return Ok(()),
            Err(DownloadError::NotFound) => return Err(DownloadError::NotFound),
            Err(DownloadError::Failed(error)) => {
                downloaded.fetch_sub(written, Ordering::Relaxed);
                last_error = error;
                std::thread::sleep(Duration::from_secs(u64::from(attempt)));
            }
        }
    }
    Err(DownloadError::Failed(format!(
        "runtime download failed: {last_error}"
    )))
}

/// Single-connection fallback for when asset sizes are unknown (the release
/// API was unavailable).
fn download_stream(
    client: &reqwest::blocking::Client,
    plan: &DownloadPlan,
    archive: &Path,
    downloaded: &AtomicU64,
    report: &dyn Fn(),
) -> Result<(), DownloadError> {
    let failed = |error: String| DownloadError::Failed(error);
    let mut file = std::fs::File::create(archive).map_err(|error| failed(error.to_string()))?;
    let mut buffer = vec![0u8; 256 * 1024];
    let mut last_report = Instant::now();
    for (url, _) in &plan.parts {
        let mut response = client
            .get(url)
            .send()
            .map_err(|error| failed(format!("runtime download failed: {error}")))?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(DownloadError::NotFound);
        }
        if !response.status().is_success() {
            return Err(failed(format!(
                "runtime download returned HTTP {}",
                response.status()
            )));
        }
        loop {
            let read = response
                .read(&mut buffer)
                .map_err(|error| failed(format!("could not read runtime download: {error}")))?;
            if read == 0 {
                break;
            }
            file.write_all(&buffer[..read])
                .map_err(|error| failed(format!("could not save runtime download: {error}")))?;
            downloaded.fetch_add(read as u64, Ordering::Relaxed);
            if last_report.elapsed() >= Duration::from_millis(200) {
                report();
                last_report = Instant::now();
            }
        }
    }
    file.flush().map_err(|error| failed(error.to_string()))
}

fn extract(archive: &Path, staging: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|error| error.to_string())?;
    if cfg!(windows) {
        let mut zip = zip::ZipArchive::new(file)
            .map_err(|error| format!("could not open runtime archive: {error}"))?;
        zip.extract(staging)
            .map_err(|error| format!("could not extract runtime: {error}"))
    } else {
        tar::Archive::new(GzDecoder::new(file))
            .unpack(staging)
            .map_err(|error| format!("could not extract runtime: {error}"))
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

fn install_plan(
    app: &AppHandle,
    client: &reqwest::blocking::Client,
    plan: &DownloadPlan,
    runtimes_dir: &Path,
) -> Result<(), DownloadError> {
    let failed = |error: String| DownloadError::Failed(error);
    let archive = runtimes_dir.join(format!("{}.download", plan.asset));
    let staging = runtimes_dir.join(format!("{}.staging", plan.target));
    let destination = runtimes_dir.join(plan.target);

    let result = (|| -> Result<(), DownloadError> {
        download(app, client, plan, &archive)?;
        let _ = app.emit(
            "runtime-install-progress",
            InstallProgress {
                stage: "extracting",
                asset: plan.asset.clone(),
                downloaded: 0,
                total: None,
            },
        );
        if staging.exists() {
            std::fs::remove_dir_all(&staging).map_err(|error| failed(error.to_string()))?;
        }
        std::fs::create_dir_all(&staging).map_err(|error| failed(error.to_string()))?;
        extract(&archive, &staging).map_err(failed)?;
        let extracted = staging.join("har-runtime-server");
        if !extracted.join(runtime_executable_name()).exists() {
            return Err(failed("runtime archive has an unexpected layout".to_string()));
        }
        std::fs::write(extracted.join(RUNTIME_VERSION_FILE), RUNTIME_RELEASE_TAG)
            .map_err(|error| failed(error.to_string()))?;
        if destination.exists() {
            // A running runtime locks its files on Windows; stop it before replacing it.
            stop_services(app);
            std::fs::remove_dir_all(&destination).map_err(|error| {
                failed(format!("could not remove the old runtime: {error}"))
            })?;
        }
        std::fs::rename(&extracted, &destination).map_err(|error| failed(error.to_string()))?;
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&staging);
    let _ = std::fs::remove_file(&archive);
    result
}

fn install_runtime_blocking(app: &AppHandle) -> Result<RuntimeStatus, String> {
    let status = current_status(app);
    if status.installed && !status.update_available {
        return Ok(status);
    }
    let runtimes_dir = runtimes_dir(app)?;
    std::fs::create_dir_all(&runtimes_dir).map_err(|error| error.to_string())?;
    let client = reqwest::blocking::Client::builder()
        .user_agent(concat!("har-runtime/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(30))
        // Runtimes are hundreds of MB to several GB; never cap the whole transfer.
        .timeout(None)
        .build()
        .map_err(|error| error.to_string())?;

    let mut installed = false;
    for plan in plan_downloads(&client)? {
        match install_plan(app, &client, &plan, &runtimes_dir) {
            Ok(()) => {
                installed = true;
                break;
            }
            Err(DownloadError::NotFound) => continue,
            Err(DownloadError::Failed(error)) => return Err(error),
        }
    }
    if !installed {
        return Err(format!(
            "release {} has no runtime for this computer",
            RUNTIME_RELEASE_TAG
        ));
    }
    if status.installed {
        // The update may have landed in a different folder (e.g. CPU -> CUDA);
        // stop the old processes so start_runtime launches the new runtime.
        stop_services(app);
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let runtime = runtime_path(app)?;
        let mut permissions = std::fs::metadata(&runtime)
            .map_err(|error| error.to_string())?
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&runtime, permissions).map_err(|error| error.to_string())?;
    }
    Ok(current_status(app))
}

/// Downloads (or updates) the runtime. Async so the multi-GB download runs off
/// the main thread and the window stays responsive.
#[tauri::command]
async fn install_runtime(app: AppHandle) -> Result<RuntimeStatus, String> {
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("The runtime is already being downloaded".to_string());
    }
    let result = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || install_runtime_blocking(&app)
    })
    .await
    .map_err(|error| error.to_string())
    .and_then(|result| result);
    INSTALLING.store(false, Ordering::SeqCst);
    result
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
            // reports a disconnected runtime and offers to reinstall it.
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
