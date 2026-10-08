//! Authentication flow interface

use reqwest::StatusCode;

use crate::State;
use crate::state::{Credentials, MinecraftLoginFlow};
use crate::util::fetch::{INSECURE_REQWEST_CLIENT, relay_request};

#[tracing::instrument]
pub async fn check_reachable() -> crate::Result<()> {
	let req = relay_request(
		&INSECURE_REQWEST_CLIENT,
		reqwest::Method::GET,
		"https://sessionserver.mojang.com/session/minecraft/hasJoined",
	)?;
	let resp = match req.send().await {
		Ok(r) => r,
		Err(_) => return Ok(()),
	};
	if resp.status() == StatusCode::NO_CONTENT {
		return Ok(());
	}
	let _ = resp.error_for_status();
	Ok(())
}

#[tracing::instrument]
pub async fn begin_login() -> crate::Result<MinecraftLoginFlow> {
    let state = State::get().await?;

    crate::state::login_begin(&state.pool).await
}

#[tracing::instrument]
pub async fn finish_login(
    code: &str,
    flow: MinecraftLoginFlow,
) -> crate::Result<Credentials> {
    let state = State::get().await?;

    let credentials =
        crate::state::login_finish(code, flow, &state.pool).await?;

    if let Err(error) =
        crate::onboarding_checklist::mark_logged_into_minecraft().await
    {
        tracing::warn!(
            "Failed to mark Minecraft login in onboarding checklist: {error}"
        );
    }

    Ok(credentials)
}

/// Create a new offline user identity using username + Identity PIN.
#[tracing::instrument(skip(pin))]
pub async fn add_offline_user(
    username: &str,
    pin: &str,
) -> crate::Result<Credentials> {
    let state = State::get().await?;
    let credentials =
        Credentials::create_offline_user(username, pin, &state.pool).await?;

    if let Err(error) =
        crate::onboarding_checklist::mark_logged_into_minecraft().await
    {
        tracing::warn!(
            "Failed to mark Minecraft login in onboarding checklist: {error}"
        );
    }

    Ok(credentials)
}

#[tracing::instrument]
pub async fn get_default_user() -> crate::Result<Option<uuid::Uuid>> {
    let state = State::get().await?;
    let user = Credentials::get_default_credential(&state.pool).await?;
    Ok(user.map(|user| user.offline_profile.id))
}

#[tracing::instrument]
pub async fn set_default_user(user: uuid::Uuid) -> crate::Result<()> {
    let state = State::get().await?;
	Credentials::set_active(user, &state.pool).await
}

/// Remove a user account from the database
#[tracing::instrument]
pub async fn remove_user(uuid: uuid::Uuid) -> crate::Result<()> {
    let state = State::get().await?;
	Credentials::remove_and_select(uuid, &state.pool).await
}

/// Get a copy of the list of all user credentials
#[tracing::instrument]
pub async fn users() -> crate::Result<Vec<Credentials>> {
    let state = State::get().await?;
    let users = Credentials::get_all(&state.pool).await?;
    Ok(users.into_iter().map(|x| x.1).collect())
}
