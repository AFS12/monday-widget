// Sem janela de console no build de release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::time::Duration;

use keyring::Entry;
use serde_json::{json, Value};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_window_state::StateFlags;

const API_URL: &str = "https://api.monday.com/v2";
const KEYRING_SERVICE: &str = "monday-widget";
const KEYRING_ACCOUNT: &str = "api-token";
/// Precisa ser IDÊNTICO ao "additionalBrowserArgs" do tauri.conf.json:
/// janelas com argumentos diferentes não conseguem compartilhar o mesmo WebView2.
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-gpu --disable-background-networking --disable-component-update --renderer-process-limit=1 --no-pings";
const DETAIL_W: f64 = 480.0;
const DETAIL_H: f64 = 640.0;

/// O token fica no Gerenciador de Credenciais do Windows, nunca em arquivo.
fn token_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|e| e.to_string())
}

fn read_token() -> Option<String> {
    token_entry()
        .ok()?
        .get_password()
        .ok()
        .filter(|t| !t.trim().is_empty())
}

#[tauri::command]
fn has_token() -> bool {
    read_token().is_some()
}

#[tauri::command]
fn save_token(token: String) -> Result<(), String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("Token vazio".into());
    }
    token_entry()?
        .set_password(token)
        .map_err(|e| format!("Não foi possível salvar o token: {e}"))
}

#[tauri::command]
fn clear_token() -> Result<(), String> {
    match token_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Executa uma query GraphQL no monday. O token não sai do processo nativo.
#[tauri::command]
async fn monday_query(query: String, variables: Option<Value>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || run_query(&query, variables))
        .await
        .map_err(|e| e.to_string())?
}

fn run_query(query: &str, variables: Option<Value>) -> Result<Value, String> {
    let token = read_token().ok_or("Token não configurado")?;
    let body = json!({ "query": query, "variables": variables.unwrap_or_else(|| json!({})) });

    let response = ureq::post(API_URL)
        .set("Authorization", &token)
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(25))
        .send_json(body);

    let value: Value = match response {
        Ok(r) => r.into_json().map_err(|e| format!("Resposta inválida: {e}"))?,
        Err(ureq::Error::Status(code, r)) => {
            let text = r.into_string().unwrap_or_default();
            return Err(match code {
                401 | 403 => "Token inválido ou sem permissão (401)".into(),
                429 => "Limite de requisições do monday atingido, tentando de novo mais tarde".into(),
                _ => format!("HTTP {code}: {}", truncate(&text, 300)),
            });
        }
        Err(e) => return Err(format!("Falha de conexão: {e}")),
    };

    if let Some(errors) = value.get("errors").and_then(Value::as_array) {
        let msgs: Vec<&str> = errors
            .iter()
            .filter_map(|e| e.get("message").and_then(Value::as_str))
            .collect();
        if !msgs.is_empty() {
            return Err(msgs.join("; "));
        }
    }
    if let Some(msg) = value.get("error_message").and_then(Value::as_str) {
        return Err(msg.to_string());
    }

    Ok(value.get("data").cloned().unwrap_or(Value::Null))
}

/// Abre (ou reaproveita) a janela de detalhes de um item.
/// Precisa ser async: criar janelas num comando síncrono trava no Windows.
#[tauri::command]
async fn open_detail(app: AppHandle, item_id: String) -> Result<(), String> {
    if item_id.is_empty() || !item_id.chars().all(|c| c.is_ascii_digit()) {
        return Err("ID de item inválido".into());
    }

    if let Some(w) = app.get_webview_window("detail") {
        app.emit_to("detail", "load-item", &item_id)
            .map_err(|e| e.to_string())?;
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }

    let url = WebviewUrl::App(format!("detail.html?id={item_id}").into());
    let mut builder = WebviewWindowBuilder::new(&app, "detail", url)
        .title("Tarefa — Monday Widget")
        .inner_size(DETAIL_W, DETAIL_H)
        .min_inner_size(340.0, 280.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .additional_browser_args(BROWSER_ARGS);

    builder = match detail_position(&app) {
        Some((x, y)) => builder.position(x, y),
        None => builder.center(),
    };
    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

/// Posição ao lado do widget (à esquerda se couber, senão à direita), no mesmo monitor.
fn detail_position(app: &AppHandle) -> Option<(f64, f64)> {
    let main = app.get_webview_window("main")?;
    let scale = main.scale_factor().ok()?;
    let pos = main.outer_position().ok()?.to_logical::<f64>(scale);
    let size = main.outer_size().ok()?.to_logical::<f64>(scale);
    let monitor = main.current_monitor().ok()??;
    let mpos = monitor.position().to_logical::<f64>(scale);
    let msize = monitor.size().to_logical::<f64>(scale);
    let gap = 12.0;

    let x = if pos.x - DETAIL_W - gap >= mpos.x {
        pos.x - DETAIL_W - gap
    } else if pos.x + size.width + gap + DETAIL_W <= mpos.x + msize.width {
        pos.x + size.width + gap
    } else {
        mpos.x + (msize.width - DETAIL_W) / 2.0
    };
    let max_y = (mpos.y + msize.height - DETAIL_H - 48.0).max(mpos.y);
    let y = pos.y.clamp(mpos.y, max_y);
    Some((x, y))
}

fn truncate(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        // Sai do "fundo" para aparecer na frente; o JS devolve ao fundo quando perde o foco
        let _ = w.set_always_on_bottom(false);
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn toggle_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        // Só oculta se estiver visível E em foco; se estiver escondido atrás de outras janelas, traz para frente
        if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
            let _ = w.hide();
        } else {
            show_window(app);
        }
    }
}

fn main() {
    tauri::Builder::default()
        // Precisa ser o primeiro plugin: impede abrir dois widgets ao mesmo tempo
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_window(app);
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::POSITION | StateFlags::SIZE)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .invoke_handler(tauri::generate_handler![
            has_token,
            save_token,
            clear_token,
            monday_query,
            open_detail
        ])
        .setup(|app| {
            let toggle = MenuItem::with_id(app, "toggle", "Mostrar / ocultar", true, None::<&str>)?;
            let refresh = MenuItem::with_id(app, "refresh", "Atualizar agora", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&toggle, &refresh, &quit])?;

            TrayIconBuilder::with_id("tray")
                .icon(app.default_window_icon().cloned().expect("ícone padrão"))
                .tooltip("Monday Widget")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => toggle_window(app),
                    "refresh" => {
                        show_window(app);
                        let _ = app.emit("refresh", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_window(tray.app_handle());
                    }
                })
                .build(app)?;
            // Ao abrir, aparece na frente (vai para o fundo quando perde o foco)
            show_window(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Monday Widget");
}
