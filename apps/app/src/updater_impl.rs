use crate::api::Result;
use reqwest::ClientBuilder;
use std::sync::{Arc, Mutex};
use tauri::http::HeaderValue;
use tauri::http::header::ACCEPT;
use tauri::{Manager, ResourceId, Runtime, Webview};
use tauri_plugin_updater::Error;
use tauri_plugin_updater::Update;
use tauri_plugin_updater::UpdaterExt;
use theseus::{
	LoadingBarType, emit_loading, init_loading, launcher_user_agent,
};
use tokio::time::Instant;

#[derive(Default)]
pub struct PendingUpdateData(pub Mutex<Option<(Arc<Update>, Vec<u8>)>>);

const UPDATE_SERVICE: &str = "https://br-divine-snow-ahjav8i1-updates.compute.c-3.us-east-1.aws.neon.tech";

fn is_update_service_url(url: &url::Url) -> bool {
	theseus::is_relay_url(url.as_str())
		|| (url.username().is_empty()
			&& url.password().is_none()
			&& url.origin()
				== url::Url::parse(UPDATE_SERVICE).unwrap().origin())
}

fn update_manifest_url(base: &str) -> tauri_plugin_updater::Result<url::Url> {
	let mut endpoint = url::Url::parse(base)?;
	if !is_update_service_url(&endpoint)
		|| endpoint.query().is_some()
		|| endpoint.fragment().is_some()
	{
		return Err(Error::Network(
			"Update checks must use a ModBridge service base URL".into(),
		));
	}
	endpoint.set_path(&format!(
		"{}/updates.json",
		endpoint.path().trim_end_matches('/')
	));
	Ok(endpoint)
}

fn update_client(builder: ClientBuilder) -> ClientBuilder {
	builder.redirect(reqwest::redirect::Policy::custom(|attempt| {
		if attempt.previous().len() >= 10 {
			attempt.error("Too many update redirects")
		} else if is_update_service_url(attempt.url()) {
			attempt.follow()
		} else {
			attempt.error("Update redirects must stay on a ModBridge service")
		}
	}))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
	rid: ResourceId,
	current_version: String,
	version: String,
	date: Option<String>,
	body: Option<String>,
	raw_json: serde_json::Value,
}

#[tauri::command]
pub async fn check_for_update<R: Runtime>(
	webview: Webview<R>,
) -> Result<Option<UpdateMetadata>> {
	let update_base = theseus::get_update_base_url().unwrap_or(UPDATE_SERVICE);
	let endpoint = update_manifest_url(update_base)?;
	let mut builder = webview
		.updater_builder()
		.endpoints(vec![endpoint])?
		.configure_client(update_client);
	if let Some(token) = theseus::get_relay_token() {
		builder = builder.header("X-Modbridge-Token", token)?;
	}
	let Some(update) = builder.build()?.check().await? else {
		return Ok(None);
	};
	if !is_update_service_url(&update.download_url) {
		return Err(Error::Network(
			"Update download must use a ModBridge service".into(),
		)
		.into());
	}
	let metadata = UpdateMetadata {
		current_version: update.current_version.clone(),
		version: update.version.clone(),
		date: update.date.map(|date| date.to_string()),
		body: update.body.clone(),
		raw_json: update.raw_json.clone(),
		rid: webview.resources_table().add(update),
	};
	Ok(Some(metadata))
}

// Reimplementation of Update::download mostly, minus the actual download part
#[tauri::command]
pub async fn get_update_size<R: Runtime>(
	webview: Webview<R>,
	rid: ResourceId,
) -> Result<Option<u64>> {
	let update = webview.resources_table().get::<Update>(rid)?;
	if !is_update_service_url(&update.download_url) {
		return Err(Error::Network(
			"Update download must use a ModBridge service".into(),
		)
		.into());
	}

	let mut headers = update.headers.clone();
	if !headers.contains_key(ACCEPT) {
		headers.insert(
			ACCEPT,
			HeaderValue::from_static("application/octet-stream"),
		);
	}

	let mut request =
		update_client(ClientBuilder::new()).user_agent(launcher_user_agent());
	if let Some(timeout) = update.timeout {
		request = request.timeout(timeout);
	}
	if let Some(ref proxy) = update.proxy {
		let proxy = reqwest::Proxy::all(proxy.as_str())?;
		request = request.proxy(proxy);
	}
	let response = request
		.build()?
		.head(update.download_url.clone())
		.headers(headers)
		.send()
		.await?;

	if !response.status().is_success() {
		return Err(Error::Network(format!(
			"Download request failed with status: {}",
			response.status()
		))
		.into());
	}

	let content_length = response
		.headers()
		.get("Content-Length")
		.and_then(|value| value.to_str().ok())
		.and_then(|value| value.parse().ok());

	Ok(content_length)
}

#[tauri::command]
pub async fn enqueue_update_for_installation<R: Runtime>(
	webview: Webview<R>,
	rid: ResourceId,
) -> Result<()> {
	let pending_data = webview.state::<PendingUpdateData>().inner();

	let update = webview.resources_table().get::<Update>(rid)?;
	if !is_update_service_url(&update.download_url) {
		return Err(Error::Network(
			"Update download must use a ModBridge service".into(),
		)
		.into());
	}

	let progress = init_loading(
		LoadingBarType::LauncherUpdate {
			version: update.version.clone(),
			current_version: update.current_version.clone(),
		},
		1.0,
		"Downloading update...",
	)
	.await?;

	let download_start = Instant::now();
	let update_data = update
		.download(
			|chunk_size, total_size| {
				let Some(total_size) = total_size else {
					return;
				};
				if let Err(e) = emit_loading(
					&progress,
					chunk_size as f64 / total_size as f64,
					None,
				) {
					tracing::error!(
						"Failed to update download progress bar: {e}"
					);
				}
			},
			|| {},
		)
		.await?;
	let download_duration = download_start.elapsed();
	tracing::info!("Downloaded update in {download_duration:?}");

	pending_data
		.0
		.lock()
		.unwrap()
		.replace((update, update_data));

	Ok(())
}

#[tauri::command]
pub fn remove_enqueued_update<R: Runtime>(webview: Webview<R>) {
	let pending_data = webview.state::<PendingUpdateData>().inner();
	pending_data.0.lock().unwrap().take();
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn configured_update_base_is_validated_before_networking() {
		assert_eq!(
			update_manifest_url(&format!("{UPDATE_SERVICE}/"))
				.unwrap()
				.as_str(),
			format!("{UPDATE_SERVICE}/updates.json")
		);
		let relay_base = format!("{}/updates", theseus::get_relay_base_url());
		assert_eq!(
			update_manifest_url(&relay_base).unwrap().as_str(),
			format!("{relay_base}/updates.json")
		);
		for base in [
			"https://github.com/ethantphillips/ModBridge/releases/latest",
			&format!("{UPDATE_SERVICE}?token=secret"),
			&format!("{UPDATE_SERVICE}#fragment"),
		] {
			assert!(update_manifest_url(base).is_err());
		}
	}

	#[test]
	fn update_urls_are_confined_to_owned_services() {
		for url in [
			format!("{UPDATE_SERVICE}/download/latest/asset.exe"),
			format!(
				"{}/updates/download/latest/asset.exe",
				theseus::get_relay_base_url()
			),
		] {
			assert!(is_update_service_url(&url::Url::parse(&url).unwrap()));
		}
		for url in [
			"https://github.com/ethantphillips/ModBridge/releases/latest",
			"https://br-divine-snow-ahjav8i1-updates.compute.c-3.us-east-1.aws.neon.tech.evil.invalid/file",
			"https://user@br-divine-snow-ahjav8i1-updates.compute.c-3.us-east-1.aws.neon.tech/file",
			"https://br-divine-snow-ahjav8i1-updates.compute.c-3.us-east-1.aws.neon.tech:444/file",
			"http://br-divine-snow-ahjav8i1-updates.compute.c-3.us-east-1.aws.neon.tech/file",
		] {
			assert!(
				!is_update_service_url(&url::Url::parse(url).unwrap()),
				"{url}"
			);
		}
	}
}
