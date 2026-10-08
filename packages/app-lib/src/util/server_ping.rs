use crate::error::Result;
use crate::util::protocol_version::ProtocolVersion;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use url::Url;

/// Server status returned by Relay after it resolves and pings the server.
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
	#[serde(skip_serializing_if = "Option::is_none")]
	pub description: Option<Box<RawValue>>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub players: Option<ServerPlayers>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub version: Option<ServerVersion>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub favicon: Option<Url>,
	#[serde(default)]
	pub enforces_secure_chat: bool,
	/// Connection and status-response latency measured from Relay, in milliseconds.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub ping: Option<i64>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct ServerPlayers {
	pub max: i32,
	pub online: i32,
	#[serde(default)]
	pub sample: Vec<ServerGameProfile>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct ServerGameProfile {
	pub id: String,
	pub name: String,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct ServerVersion {
	pub name: String,
	pub protocol: i32,
	#[serde(default)]
	pub legacy: bool,
}

pub async fn get_server_status(
	original_address: (&str, u16),
	protocol_version: Option<ProtocolVersion>,
) -> Result<ServerStatus> {
	get_server_status_with_base(
		original_address,
		protocol_version,
		crate::util::relay::get_relay_base_url(),
		&crate::util::fetch::INSECURE_REQWEST_CLIENT,
	)
	.await
}

async fn get_server_status_with_base(
	original_address: (&str, u16),
	protocol_version: Option<ProtocolVersion>,
	relay_base: &str,
	client: &reqwest::Client,
) -> Result<ServerStatus> {
	let (host, port) = original_address;
	let address = if host.contains(':') {
		format!("[{host}]:{port}")
	} else {
		format!("{host}:{port}")
	};
	let mut body = serde_json::json!({"address": address});
	if let Some(protocol) = protocol_version {
		body["protocol"] = serde_json::json!(protocol);
	}
	let response = crate::util::relay::relay_request_with_base(
		client,
		reqwest::Method::POST,
		&format!("{}/server/status", relay_base.trim_end_matches('/')),
		relay_base,
		crate::util::relay::get_relay_token(),
	)?
	.json(&body)
	.timeout(std::time::Duration::from_secs(10))
	.send()
	.await?
	.error_for_status()?;
	Ok(response.json().await?)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[tokio::test]
	async fn requests_remote_server_status_only_from_relay() {
		use tokio::io::{AsyncReadExt, AsyncWriteExt};
		let listener =
			tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
		let base = format!("http://{}", listener.local_addr().unwrap());
		let server = tokio::spawn(async move {
			let (mut stream, _) = listener.accept().await.unwrap();
			let mut received = Vec::new();
			loop {
				let mut buffer = [0; 4096];
				let size = stream.read(&mut buffer).await.unwrap();
				assert!(size > 0);
				received.extend_from_slice(&buffer[..size]);
				if let Some(start) =
					received.windows(4).position(|chunk| chunk == b"\r\n\r\n")
				{
					if let Ok(body) = serde_json::from_slice::<serde_json::Value>(
						&received[start + 4..],
					) {
						assert!(
							received.starts_with(
								b"POST /server/status HTTP/1.1\r\n"
							)
						);
						assert_eq!(
							body,
							serde_json::json!({
								"address": "minecraft.example:25565",
								"protocol": {"version": 74, "legacy": true},
							})
						);
						break;
					}
				}
			}
			let body = serde_json::json!({
				"description": {"text": "Relay status"},
				"players": {"max": 20, "online": 2},
				"version": {"name": "1.6.4", "protocol": 74, "legacy": true},
				"enforcesSecureChat": false,
				"ping": 12,
			})
			.to_string();
			stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
		});
		let status = get_server_status_with_base(
			("minecraft.example", 25565),
			Some(ProtocolVersion::legacy(74)),
			&base,
			&reqwest::Client::builder().no_proxy().build().unwrap(),
		)
		.await
		.unwrap();
		assert_eq!(status.ping, Some(12));
		assert!(status.version.unwrap().legacy);
		assert!(status.players.unwrap().sample.is_empty());
		server.await.unwrap();
	}
}
