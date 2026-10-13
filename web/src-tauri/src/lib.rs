use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_shell::process::CommandChild;

struct RuntimeProcesses(Mutex<Vec<CommandChild>>);

fn runtime_path(app: &AppHandle) -> Result<PathBuf, String> {
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
    let runtime_name = if cfg!(windows) {
        "har-runtime-server.exe"
    } else {
        "har-runtime-server"
    };
    Ok(runtime_dir.join(runtime_name))
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

    if role != "standalone" {
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
            let runtime = runtime_path(&handle).map_err(std::io::Error::other)?;
            let role = stored_role(&handle);
            let children =
                spawn_services(&handle, &runtime, &role).map_err(std::io::Error::other)?;
            app.manage(RuntimeProcesses(Mutex::new(children)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![set_runtime_role])
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
