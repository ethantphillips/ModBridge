//! Modbridge Relay client-side request routing.

use std::sync::LazyLock;
use url::Url;

pub const DEFAULT_RELAY_URL: &str =
	"https://br-divine-snow-ahjav8i1-relay.compute.c-3.us-east-1.aws.neon.tech";

pub static RELAY_BASE_URL: LazyLock<String> = LazyLock::new(|| {
	std::env::var("MODBRIDGE_RELAY_BASE_URL")
		.ok()
		.filter(|url| !url.trim().is_empty())
		.or_else(|| option_env!("MODBRIDGE_RELAY_BASE_URL").map(str::to_owned))
		.filter(|url| !url.trim().is_empty())
		.unwrap_or_else(|| DEFAULT_RELAY_URL.to_string())
		.trim()
		.trim_end_matches('/')
		.to_string()
});

pub static RELAY_AUTH_TOKEN: LazyLock<Option<String>> = LazyLock::new(|| {
	std::env::var("MODBRIDGE_RELAY_AUTH_TOKEN")
		.ok()
		.filter(|token| !token.trim().is_empty())
		.or_else(|| {
			option_env!("MODBRIDGE_RELAY_AUTH_TOKEN").map(str::to_owned)
		})
		.map(|token| token.trim().to_string())
		.filter(|token| !token.is_empty())
});

#[derive(Debug, thiserror::Error)]
pub enum RelayRoutingError {
	#[error("The Relay base URL is invalid")]
	InvalidBase,
	#[error("The requested URL is invalid")]
	InvalidUrl,
	#[error("Relay does not support requests to {0}")]
	UnsupportedHost(String),
	#[error(
		"Relay does not support this URL scheme, port, or embedded credentials"
	)]
	UnsupportedUrl,
	#[error("The Relay token is not a valid HTTP header")]
	InvalidToken,
}

pub fn get_relay_base_url() -> &'static str {
	&RELAY_BASE_URL
}

pub fn get_relay_token() -> Option<&'static str> {
	RELAY_AUTH_TOKEN.as_deref()
}

pub fn get_update_base_url() -> Option<&'static str> {
	option_env!("MODBRIDGE_UPDATE_BASE_URL")
		.map(|url| url.trim().trim_end_matches('/'))
		.filter(|url| !url.is_empty())
}

pub fn is_relay_url(url: &str) -> bool {
	parse_relay_base(get_relay_base_url())
		.ok()
		.is_some_and(|base| {
			Url::parse(url)
				.ok()
				.is_some_and(|url| is_relay_destination(&url, &base))
		})
}

/// Routes supported upstream requests through Relay and rejects unsupported destinations.
pub fn route_url_through_relay(url: &str) -> Result<String, RelayRoutingError> {
	route_url_with_base(url, get_relay_base_url())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ModrinthRoute {
	Api,
	Cdn,
}

pub(crate) fn modrinth_route(url: &str) -> Option<ModrinthRoute> {
	modrinth_route_with_base(url, get_relay_base_url())
}

fn modrinth_route_with_base(
	url: &str,
	relay_base: &str,
) -> Option<ModrinthRoute> {
	let routed = route_url_with_base(url, relay_base).ok()?;
	let routed = Url::parse(&routed).ok()?;
	let base = parse_relay_base(relay_base).ok()?;
	let path = routed
		.path()
		.strip_prefix(base.path().trim_end_matches('/'))?;
	for (prefix, kind) in [
		("/api", ModrinthRoute::Api),
		("/staging-api", ModrinthRoute::Api),
		("/modrinth/api", ModrinthRoute::Api),
		("/cdn", ModrinthRoute::Cdn),
		("/staging-cdn", ModrinthRoute::Cdn),
		("/modrinth/cdn", ModrinthRoute::Cdn),
	] {
		if path == prefix || path.starts_with(&format!("{prefix}/")) {
			return Some(kind);
		}
	}
	None
}

pub fn route_websocket_url_through_relay(
	url: &str,
) -> Result<String, RelayRoutingError> {
	route_websocket_url_with_base(url, get_relay_base_url())
}

fn route_websocket_url_with_base(
	url: &str,
	relay_base: &str,
) -> Result<String, RelayRoutingError> {
	let mut source =
		Url::parse(url).map_err(|_| RelayRoutingError::InvalidUrl)?;
	let http_scheme = match source.scheme() {
		"wss" => "https",
		"ws" => "http",
		_ => return Err(RelayRoutingError::UnsupportedUrl),
	};
	source
		.set_scheme(http_scheme)
		.map_err(|_| RelayRoutingError::UnsupportedUrl)?;
	let base = parse_relay_base(relay_base)?;
	if !is_relay_destination(&source, &base)
		&& !source.host_str().is_some_and(|host| {
			matches!(host, "api.modrinth.com" | "staging-api.modrinth.com")
				|| is_modrinth_node_host(host)
		}) {
		return Err(RelayRoutingError::UnsupportedHost(
			source.host_str().unwrap_or_default().to_string(),
		));
	}
	let target = route_url_with_base(source.as_str(), relay_base)?;
	let mut target =
		Url::parse(&target).map_err(|_| RelayRoutingError::InvalidUrl)?;
	let websocket_scheme = if target.scheme() == "https" {
		"wss"
	} else {
		"ws"
	};
	target
		.set_scheme(websocket_scheme)
		.map_err(|_| RelayRoutingError::UnsupportedUrl)?;
	Ok(target.to_string())
}

/// Connects a validated Relay WebSocket through the process's HTTP proxy when configured.
pub async fn connect_relay_websocket(
	request: async_tungstenite::tungstenite::handshake::client::Request,
) -> crate::Result<(
	async_tungstenite::WebSocketStream<async_tungstenite::tokio::ConnectStream>,
	async_tungstenite::tungstenite::handshake::client::Response,
)> {
	let url = Url::parse(&request.uri().to_string())?;
	let proxy_variables = if url.scheme() == "wss" {
		["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]
	} else {
		["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]
	};
	let proxy = proxy_variables.into_iter().find_map(|name| {
		std::env::var(name)
			.ok()
			.filter(|value| !value.trim().is_empty())
	});
	let no_proxy = std::env::var("NO_PROXY")
		.or_else(|_| std::env::var("no_proxy"))
		.unwrap_or_default();
	let bypass_proxy = url.host_str().is_some_and(|host| {
		no_proxy.split(',').any(|entry| {
			let entry = entry.trim().trim_start_matches('.');
			!entry.is_empty()
				&& (entry == "*"
					|| host.eq_ignore_ascii_case(entry)
					|| host
						.to_ascii_lowercase()
						.ends_with(&format!(".{}", entry.to_ascii_lowercase())))
		})
	});
	let proxy = if bypass_proxy { None } else { proxy.as_deref() };
	tokio::time::timeout(
		std::time::Duration::from_secs(15),
		connect_relay_websocket_with_proxy(
			request,
			get_relay_base_url(),
			proxy,
		),
	)
	.await
	.map_err(|_| {
		crate::ErrorKind::OtherError(
			"Relay WebSocket connection timed out".to_string(),
		)
	})?
}

async fn connect_relay_websocket_with_proxy(
	request: async_tungstenite::tungstenite::handshake::client::Request,
	relay_base: &str,
	proxy: Option<&str>,
) -> crate::Result<(
	async_tungstenite::WebSocketStream<async_tungstenite::tokio::ConnectStream>,
	async_tungstenite::tungstenite::handshake::client::Response,
)> {
	use tokio::io::{AsyncReadExt, AsyncWriteExt};
	let request_url = request.uri().to_string();
	let target = route_websocket_url_with_base(&request_url, relay_base)?;
	if target != request_url {
		return Err(RelayRoutingError::UnsupportedUrl.into());
	}
	let Some(proxy) = proxy else {
		return Ok(async_tungstenite::tokio::connect_async(request).await?);
	};
	let proxy = Url::parse(proxy).map_err(|_| {
		crate::ErrorKind::InputError(
			"Invalid WebSocket HTTP proxy URL".to_string(),
		)
	})?;
	if proxy.scheme() != "http" || proxy.host_str().is_none() {
		return Err(crate::ErrorKind::InputError(
			"Relay WebSockets require an HTTP CONNECT proxy".to_string(),
		)
		.into());
	}
	let proxy_host = proxy.host_str().unwrap().trim_matches(['[', ']']);
	let proxy_port = proxy.port_or_known_default().unwrap();
	let target = Url::parse(&target)?;
	let authority = format!(
		"{}:{}",
		target.host_str().unwrap(),
		target.port_or_known_default().unwrap()
	);
	let mut connect =
		format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n");
	if !proxy.username().is_empty() || proxy.password().is_some() {
		use base64::Engine;
		let username = urlencoding::decode(proxy.username()).map_err(|_| {
			crate::ErrorKind::InputError(
				"Invalid HTTP proxy username".to_string(),
			)
		})?;
		let password = urlencoding::decode(
			proxy.password().unwrap_or_default(),
		)
		.map_err(|_| {
			crate::ErrorKind::InputError(
				"Invalid HTTP proxy password".to_string(),
			)
		})?;
		let credentials = base64::engine::general_purpose::STANDARD
			.encode(format!("{username}:{password}"));
		connect
			.push_str(&format!("Proxy-Authorization: Basic {credentials}\r\n"));
	}
	connect.push_str("\r\n");
	let mut stream =
		tokio::net::TcpStream::connect((proxy_host, proxy_port)).await?;
	stream.write_all(connect.as_bytes()).await?;
	let mut response = Vec::new();
	while !response.ends_with(b"\r\n\r\n") {
		if response.len() >= 16 * 1024 {
			return Err(crate::ErrorKind::OtherError(
				"HTTP proxy response headers exceeded the limit".to_string(),
			)
			.into());
		}
		response.push(stream.read_u8().await?);
	}
	let status = std::str::from_utf8(&response)
		.ok()
		.and_then(|response| response.lines().next())
		.and_then(|line| line.split_whitespace().nth(1))
		.and_then(|status| status.parse::<u16>().ok());
	if !status.is_some_and(|status| (200..300).contains(&status)) {
		return Err(crate::ErrorKind::OtherError(format!(
			"HTTP proxy rejected Relay WebSocket CONNECT (status {})",
			status.unwrap_or_default()
		))
		.into());
	}
	Ok(async_tungstenite::tokio::client_async_tls(request, stream).await?)
}

/// Attaches Relay's token only after validating the request destination.
pub fn relay_request(
	client: &reqwest::Client,
	method: reqwest::Method,
	url: &str,
) -> Result<reqwest::RequestBuilder, RelayRoutingError> {
	relay_request_with_base(
		client,
		method,
		url,
		get_relay_base_url(),
		get_relay_token(),
	)
}

pub(crate) fn relay_request_with_base(
	client: &reqwest::Client,
	method: reqwest::Method,
	url: &str,
	relay_base: &str,
	token: Option<&str>,
) -> Result<reqwest::RequestBuilder, RelayRoutingError> {
	let target_url = route_url_with_base(url, relay_base)?;
	let mut request = client.request(method, target_url);
	if let Some(token) = token {
		let mut token = reqwest::header::HeaderValue::from_str(token)
			.map_err(|_| RelayRoutingError::InvalidToken)?;
		token.set_sensitive(true);
		request = request.header("X-Modbridge-Token", token);
	}
	Ok(request)
}

const ROUTE_MAPPINGS: &[(&str, &str)] = &[
	("api.modrinth.com", "/api"),
	("staging-api.modrinth.com", "/staging-api"),
	("cdn.modrinth.com", "/cdn"),
	("staging-cdn.modrinth.com", "/staging-cdn"),
	("launcher-meta.modrinth.com", "/launcher-meta"),
	("launcher-files.modrinth.com", "/launcher-files"),
	("piston-meta.mojang.com", "/piston-meta"),
	("piston-data.mojang.com", "/piston-data"),
	("resources.download.minecraft.net", "/minecraft-resources"),
	("libraries.minecraft.net", "/minecraft-libraries"),
	("api.minecraftservices.com", "/minecraft-services"),
	("sessionserver.mojang.com", "/mojang-session"),
	("textures.minecraft.net", "/minecraft-textures"),
	("launchermeta.mojang.com", "/mojang-meta"),
	("launcher.mojang.com", "/mojang-launcher"),
	("api.azul.com", "/azul-api"),
	("cdn.azul.com", "/azul-cdn"),
	("shared-instances.modrinth.com", "/shared-instances"),
	(
		"staging-shared-instances.modrinth.com",
		"/staging-shared-instances",
	),
	("archon.modrinth.com", "/archon"),
	("staging-archon.modrinth.com", "/staging-archon"),
];

fn parse_relay_base(relay_base: &str) -> Result<Url, RelayRoutingError> {
	let base = Url::parse(relay_base.trim().trim_end_matches('/'))
		.map_err(|_| RelayRoutingError::InvalidBase)?;
	let local_http = base.scheme() == "http"
		&& matches!(base.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
	if (base.scheme() != "https" && !local_http)
		|| base.host_str().is_none()
		|| !base.username().is_empty()
		|| base.password().is_some()
		|| base.query().is_some()
		|| base.fragment().is_some()
	{
		return Err(RelayRoutingError::InvalidBase);
	}
	Ok(base)
}

fn is_relay_destination(url: &Url, base: &Url) -> bool {
	let base_path = base.path().trim_end_matches('/');
	url.origin() == base.origin()
		&& url.username().is_empty()
		&& url.password().is_none()
		&& (url.path() == base_path
			|| url.path().starts_with(&format!("{base_path}/")))
}

/// Pure routing function taking an explicit Relay base URL for testability.
pub fn route_url_with_base(
	url: &str,
	relay_base: &str,
) -> Result<String, RelayRoutingError> {
	let base = parse_relay_base(relay_base)?;
	let mut source =
		Url::parse(url).map_err(|_| RelayRoutingError::InvalidUrl)?;
	source.set_fragment(None);
	if is_relay_destination(&source, &base) {
		return Ok(source.to_string());
	}
	if !matches!(source.scheme(), "http" | "https")
		|| source.port().is_some()
		|| !source.username().is_empty()
		|| source.password().is_some()
	{
		return Err(RelayRoutingError::UnsupportedUrl);
	}
	let host = source.host_str().ok_or(RelayRoutingError::InvalidUrl)?;
	let relay_prefix = ROUTE_MAPPINGS
		.iter()
		.find_map(|(upstream, prefix)| (*upstream == host).then_some(*prefix))
		.map(str::to_owned)
		.or_else(|| {
			is_modrinth_node_host(host).then(|| format!("/nodes/{host}"))
		})
		.ok_or_else(|| RelayRoutingError::UnsupportedHost(host.to_string()))?;
	let mut target = base;
	let base_path = target.path().trim_end_matches('/');
	target.set_path(&format!("{base_path}{relay_prefix}{}", source.path()));
	target.set_query(source.query());
	Ok(target.to_string())
}

fn is_modrinth_node_host(host: &str) -> bool {
	let valid_labels = host.split('.').all(|label| {
		!label.is_empty()
			&& !label.starts_with('-')
			&& !label.ends_with('-')
			&& label
				.bytes()
				.all(|c| c.is_ascii_alphanumeric() || c == b'-')
	});
	valid_labels
		&& (host.ends_with(".nodes.modrinth.com")
			|| host.strip_suffix(".modrinth.com").is_some_and(|label| {
				label.starts_with("node-")
					&& label.len() > 5
					&& !label.contains('.')
			}))
}

/// Restricts redirects to Relay's origin and configured base path.
pub fn relay_redirect_policy() -> reqwest::redirect::Policy {
	relay_redirect_policy_with_base(get_relay_base_url())
}

fn relay_redirect_policy_with_base(
	relay_base: &str,
) -> reqwest::redirect::Policy {
	let base = parse_relay_base(relay_base).ok();
	reqwest::redirect::Policy::custom(move |attempt| {
		if attempt.previous().len() >= 10 {
			attempt.error("Too many Relay redirects")
		} else if base
			.as_ref()
			.is_some_and(|base| is_relay_destination(attempt.url(), base))
		{
			attempt.follow()
		} else {
			attempt
				.error("Relay redirect to an external destination was blocked")
		}
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	const TEST_RELAY: &str = "https://relay.modbridge.internal";

	#[test]
	fn routes_every_supported_host_and_preserves_path_and_query() {
		for (host, prefix) in ROUTE_MAPPINGS {
			for scheme in ["http", "https"] {
				assert_eq!(
					route_url_with_base(
						&format!(
							"{scheme}://{host}/a%20b/file.jar?name=a%2Fb&v=1#ignored"
						),
						TEST_RELAY,
					)
					.unwrap(),
					format!(
						"{TEST_RELAY}{prefix}/a%20b/file.jar?name=a%2Fb&v=1"
					)
				);
			}
		}
	}

	#[test]
	fn recognizes_canonical_hosts_and_default_ports() {
		assert_eq!(
			route_url_with_base("https://API.MODRINTH.COM:443?v=2", TEST_RELAY)
				.unwrap(),
			format!("{TEST_RELAY}/api/?v=2")
		);
	}

	#[test]
	fn routes_staging_api_and_approved_node_requests() {
		assert_eq!(
			route_url_with_base(
				"https://staging-api.modrinth.com/v3/user",
				TEST_RELAY,
			)
			.unwrap(),
			format!("{TEST_RELAY}/staging-api/v3/user")
		);
		for host in ["us1.nodes.modrinth.com", "node-abc.modrinth.com"] {
			assert_eq!(
				route_url_with_base(
					&format!("https://{host}/server/download?token=upstream"),
					TEST_RELAY,
				)
				.unwrap(),
				format!(
					"{TEST_RELAY}/nodes/{host}/server/download?token=upstream"
				)
			);
			assert_eq!(
				route_websocket_url_with_base(
					&format!("wss://{host}/server/socket"),
					TEST_RELAY,
				)
				.unwrap(),
				format!(
					"wss://relay.modbridge.internal/nodes/{host}/server/socket"
				)
			);
		}
	}

	#[test]
	fn rejects_unapproved_node_hosts_and_ports() {
		for url in [
			"https://nodes.modrinth.com/server/download",
			"https://node-.modrinth.com/server/download",
			"https://node-abc.modrinth.com.evil.com/server/download",
			"https://node-abc.extra.modrinth.com/server/download",
			"https://-bad.nodes.modrinth.com/server/download",
			"https://node-abc.modrinth.com:444/server/download",
		] {
			assert!(route_url_with_base(url, TEST_RELAY).is_err(), "{url}");
		}
	}

	#[test]
	fn routes_friends_websocket_to_relay_and_rejects_other_origins() {
		let upstream =
			"wss://api.modrinth.com/_internal/launcher_socket?code=session";
		let expected = "wss://relay.modbridge.internal/api/_internal/launcher_socket?code=session";
		assert_eq!(
			route_websocket_url_with_base(upstream, TEST_RELAY).unwrap(),
			expected
		);
		assert_eq!(
			route_websocket_url_with_base(expected, TEST_RELAY).unwrap(),
			expected
		);
		for url in [
			"wss://api.modrinth.com.evil.com/v3/events",
			"wss://evil.example/socket",
			"wss://cdn.modrinth.com/socket",
			"wss://user:password@api.modrinth.com/v3/events",
			"wss://api.modrinth.com:444/v3/events",
			"https://api.modrinth.com/v3/events",
		] {
			assert!(
				route_websocket_url_with_base(url, TEST_RELAY).is_err(),
				"{url}"
			);
		}
	}

	#[test]
	fn classifies_cached_and_rewritten_modrinth_urls_for_authentication() {
		for url in [
			"https://cdn.modrinth.com/data/file.jar",
			"https://staging-cdn.modrinth.com/data/file.jar",
			"https://relay.modbridge.internal/cdn/data/file.jar",
			"https://relay.modbridge.internal/staging-cdn/data/file.jar",
			"https://relay.modbridge.internal/modrinth/cdn/data/file.jar",
		] {
			assert_eq!(
				modrinth_route_with_base(url, TEST_RELAY),
				Some(ModrinthRoute::Cdn)
			);
		}
		for url in [
			"https://api.modrinth.com/v2/user",
			"https://staging-api.modrinth.com/v3/user",
			"https://relay.modbridge.internal/staging-api/v3/user",
			"https://relay.modbridge.internal/api/v3/user",
			"https://relay.modbridge.internal/modrinth/api/v2/user",
		] {
			assert_eq!(
				modrinth_route_with_base(url, TEST_RELAY),
				Some(ModrinthRoute::Api)
			);
		}
		for url in [
			"https://api.modrinth.com.evil.com/v2/user",
			"https://relay.modbridge.internal/cdn-evil/data/file.jar",
			"https://relay.modbridge.internal/archon/v1/server",
			"https://textures.minecraft.net/texture/123",
		] {
			assert_eq!(modrinth_route_with_base(url, TEST_RELAY), None);
		}
	}

	#[tokio::test]
	async fn friends_websocket_handshake_and_messages_use_mock_relay() {
		use async_tungstenite::tungstenite::{
			Message, client::IntoClientRequest,
		};
		use futures::StreamExt;
		let listener =
			tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
		let base = format!("http://{}", listener.local_addr().unwrap());
		let server = tokio::spawn(async move {
			let (stream, _) = listener.accept().await.unwrap();
			let mut socket = async_tungstenite::tokio::accept_hdr_async(
				stream,
				|request: &async_tungstenite::tungstenite::handshake::server::Request, response| {
					assert_eq!(request.uri().to_string(), "/api/_internal/launcher_socket?code=session");
					assert_eq!(request.headers()["X-Modbridge-Token"], "relay-secret");
					Ok(response)
				},
			).await.unwrap();
			assert_eq!(
				socket.next().await.unwrap().unwrap(),
				Message::Binary(vec![1, 2, 3].into())
			);
			socket
				.send(Message::Binary(vec![4, 5, 6].into()))
				.await
				.unwrap();
		});
		let target = route_websocket_url_with_base(
			"wss://api.modrinth.com/_internal/launcher_socket?code=session",
			&base,
		)
		.unwrap();
		let mut request = target.into_client_request().unwrap();
		request.headers_mut().insert(
			"X-Modbridge-Token",
			reqwest::header::HeaderValue::from_static("relay-secret"),
		);
		let (mut socket, _) = async_tungstenite::tokio::connect_async(request)
			.await
			.unwrap();
		socket
			.send(Message::Binary(vec![1, 2, 3].into()))
			.await
			.unwrap();
		assert_eq!(
			socket.next().await.unwrap().unwrap(),
			Message::Binary(vec![4, 5, 6].into())
		);
		server.await.unwrap();
	}

	#[tokio::test]
	async fn relay_websocket_uses_approved_proxy_connect_and_blocks_other_hosts()
	 {
		use async_tungstenite::tungstenite::{
			Message, client::IntoClientRequest,
		};
		use futures::StreamExt;
		use tokio::io::{AsyncReadExt, AsyncWriteExt};
		let listener =
			tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
		let proxy = format!("http://{}", listener.local_addr().unwrap());
		let base = "http://127.0.0.1:43210";
		let server = tokio::spawn(async move {
			let (mut stream, _) = listener.accept().await.unwrap();
			let mut headers = Vec::new();
			while !headers.ends_with(b"\r\n\r\n") {
				headers.push(stream.read_u8().await.unwrap());
			}
			assert!(
				headers.starts_with(b"CONNECT 127.0.0.1:43210 HTTP/1.1\r\n")
			);
			assert!(
				!String::from_utf8(headers).unwrap().contains("relay-secret")
			);
			stream
				.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
				.await
				.unwrap();
			let mut socket = async_tungstenite::tokio::accept_async(stream)
				.await
				.unwrap();
			assert_eq!(
				socket.next().await.unwrap().unwrap(),
				Message::Text("relay ping".into())
			);
			socket
				.send(Message::Text("relay pong".into()))
				.await
				.unwrap();
			assert!(
				tokio::time::timeout(
					std::time::Duration::from_millis(100),
					listener.accept()
				)
				.await
				.is_err()
			);
		});
		let target = route_websocket_url_with_base(
			"wss://api.modrinth.com/_internal/launcher_socket?code=session",
			base,
		)
		.unwrap();
		let mut request = target.into_client_request().unwrap();
		request.headers_mut().insert(
			"X-Modbridge-Token",
			reqwest::header::HeaderValue::from_static("relay-secret"),
		);
		let (mut socket, _) =
			connect_relay_websocket_with_proxy(request, base, Some(&proxy))
				.await
				.unwrap();
		socket
			.send(Message::Text("relay ping".into()))
			.await
			.unwrap();
		assert_eq!(
			socket.next().await.unwrap().unwrap(),
			Message::Text("relay pong".into())
		);
		let unsupported = "ws://evil.example/_internal/launcher_socket"
			.into_client_request()
			.unwrap();
		let error =
			connect_relay_websocket_with_proxy(unsupported, base, Some(&proxy))
				.await
				.unwrap_err();
		assert!(matches!(*error.raw, crate::ErrorKind::RelayRouting(_)));
		server.await.unwrap();
	}

	#[test]
	fn rejects_unknown_hosts_and_relay_lookalikes() {
		for url in [
			"https://github.com/ethantphillips/ModBridge/releases/latest",
			"https://api.modrinth.com.evil.com/v2/search",
			"https://relay.modbridge.internal.evil.com/api/v2/search",
			"https://relay.modbridge.internal@evil.com/api/v2/search",
			"https://relay.modbridge.internal:444/api/v2/search",
			"http://relay.modbridge.internal/api/v2/search",
		] {
			assert!(route_url_with_base(url, TEST_RELAY).is_err(), "{url}");
		}
	}

	#[test]
	fn rejects_credentials_nonstandard_ports_and_non_http_urls() {
		for url in [
			"https://user:password@api.modrinth.com/v2/search",
			"https://api.modrinth.com:444/v2/search",
			"ftp://api.modrinth.com/file.jar",
			"file:///etc/passwd",
			"data:text/plain,hello",
			"/api/v2/search",
		] {
			assert!(route_url_with_base(url, TEST_RELAY).is_err(), "{url}");
		}
	}

	#[test]
	fn rejects_invalid_base_instead_of_disabling_relay() {
		for base in [
			"",
			"https://",
			"http://relay.modbridge.internal",
			"https://user@relay.modbridge.internal",
			"https://relay.modbridge.internal?other=1",
			"https://relay.modbridge.internal#fragment",
		] {
			assert!(
				route_url_with_base("https://api.modrinth.com/v2/search", base)
					.is_err()
			);
		}
	}

	#[test]
	fn preserves_relay_base_path_and_requires_a_path_boundary() {
		let base = format!("{TEST_RELAY}/relay/");
		assert_eq!(
			route_url_with_base("https://api.modrinth.com/v2/search", &base)
				.unwrap(),
			format!("{TEST_RELAY}/relay/api/v2/search")
		);
		let already = format!("{TEST_RELAY}/relay/api/v2/search");
		assert_eq!(route_url_with_base(&already, &base).unwrap(), already);
		assert!(
			route_url_with_base(&format!("{TEST_RELAY}/relay-evil/api"), &base)
				.is_err()
		);
	}

	#[tokio::test]
	async fn sends_authenticated_json_request_only_to_mock_relay() {
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
				if let Some(header_end) =
					received.windows(4).position(|chunk| chunk == b"\r\n\r\n")
				{
					let headers =
						String::from_utf8_lossy(&received[..header_end]);
					let content_length: usize = headers
						.lines()
						.find_map(|line| {
							line.to_ascii_lowercase()
								.strip_prefix("content-length: ")
								.map(str::to_owned)
						})
						.unwrap()
						.parse()
						.unwrap();
					if received.len() >= header_end + 4 + content_length {
						break;
					}
				}
			}
			let received = String::from_utf8(received).unwrap();
			assert!(
				received.starts_with(
					"POST /api/v2/example?name=a%2Fb HTTP/1.1\r\n"
				)
			);
			let lowercase = received.to_ascii_lowercase();
			assert!(lowercase.contains("x-modbridge-token: relay-secret\r\n"));
			assert!(lowercase.contains("authorization: upstream-session\r\n"));
			assert!(received.ends_with("{\"name\":\"test\"}"));
			stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}").await.unwrap();
		});
		let client = reqwest::Client::builder()
			.no_proxy()
			.timeout(std::time::Duration::from_secs(2))
			.redirect(relay_redirect_policy_with_base(&base))
			.build()
			.unwrap();
		let request = relay_request_with_base(
			&client,
			reqwest::Method::POST,
			"https://api.modrinth.com/v2/example?name=a%2Fb",
			&base,
			Some("relay-secret"),
		)
		.unwrap()
		.header("Authorization", "upstream-session")
		.json(&serde_json::json!({ "name": "test" }))
		.build()
		.unwrap();
		assert!(request.headers()["X-Modbridge-Token"].is_sensitive());
		let response = client
			.execute(request)
			.await
			.unwrap()
			.error_for_status()
			.unwrap();
		assert_eq!(
			response.json::<serde_json::Value>().await.unwrap(),
			serde_json::json!({ "ok": true })
		);
		server.await.unwrap();
		assert!(
			relay_request_with_base(
				&client,
				reqwest::Method::GET,
				"https://api.modrinth.com.evil.com/v2/search",
				&base,
				Some("relay-secret")
			)
			.is_err()
		);
		assert!(
			relay_request_with_base(
				&client,
				reqwest::Method::GET,
				"https://api.modrinth.com/v2/search",
				&base,
				Some("bad\ntoken")
			)
			.is_err()
		);
	}

	#[tokio::test]
	async fn blocks_external_redirect_before_connecting() {
		use tokio::io::{AsyncReadExt, AsyncWriteExt};
		let listener =
			tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
		let base = format!("http://{}", listener.local_addr().unwrap());
		let server = tokio::spawn(async move {
			let (mut stream, _) = listener.accept().await.unwrap();
			let mut buffer = [0; 4096];
			stream.read(&mut buffer).await.unwrap();
			stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: https://api.modrinth.com/v2/search\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
		});
		let client = reqwest::Client::builder()
			.no_proxy()
			.redirect(relay_redirect_policy_with_base(&base))
			.build()
			.unwrap();
		let error = client
			.get(format!("{base}/api/v2/search"))
			.send()
			.await
			.unwrap_err();
		assert!(error.is_redirect());
		server.await.unwrap();
	}
}
