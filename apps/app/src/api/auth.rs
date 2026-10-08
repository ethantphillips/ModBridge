use crate::api::Result;
use tauri::plugin::TauriPlugin;
use tauri::Runtime;
use theseus::prelude::*;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::<R>::new("auth")
        .invoke_handler(tauri::generate_handler![
            check_reachable,
            login,
            add_offline_user,
            remove_user,
            get_default_user,
            set_default_user,
            get_users,
        ])
        .build()
}

/// Checks if the authentication servers are reachable.
#[tauri::command]
pub async fn check_reachable() -> Result<()> {
    minecraft_auth::check_reachable().await?;
    Ok(())
}

/// Online Minecraft authentication is unavailable in Relay-only mode.
#[tauri::command]
pub async fn login<R: Runtime>(
	_app: tauri::AppHandle<R>,
) -> Result<Option<Credentials>> {
	Err(theseus::ErrorKind::OtherError(
		"Online Minecraft sign-in is unavailable through Relay. Add an offline identity using a username and Identity PIN.".to_string(),
	)
	.as_error()
	.into())
}

#[tauri::command]
pub async fn add_offline_user(
    username: String,
    pin: String,
) -> Result<Credentials> {
    Ok(minecraft_auth::add_offline_user(&username, &pin).await?)
}

#[tauri::command]
pub async fn remove_user(user: uuid::Uuid) -> Result<()> {
    Ok(minecraft_auth::remove_user(user).await?)
}

#[tauri::command]
pub async fn get_default_user() -> Result<Option<uuid::Uuid>> {
    Ok(minecraft_auth::get_default_user().await?)
}

#[tauri::command]
pub async fn set_default_user(user: uuid::Uuid) -> Result<()> {
    Ok(minecraft_auth::set_default_user(user).await?)
}

/// Get a copy of the list of all user credentials
#[tauri::command]
pub async fn get_users() -> Result<Vec<Credentials>> {
    Ok(minecraft_auth::users().await?)
}
