//! Modbridge Relay client-side request routing and URL rewriting.

use std::sync::LazyLock;

pub static RELAY_BASE_URL: LazyLock<Option<String>> = LazyLock::new(|| {
	if let Ok(url) = std::env::var("MODBRIDGE_RELAY_BASE_URL") {
		let trimmed = url.trim().trim_end_matches('/');
		if !trimmed.is_empty() {
			return Some(trimmed.to_string());
		}
	}
	if let Some(url) = option_env!("MODBRIDGE_RELAY_BASE_URL") {
		let trimmed = url.trim().trim_end_matches('/');
		if !trimmed.is_empty() {
			return Some(trimmed.to_string());
		}
	}
	None
});

pub static RELAY_AUTH_TOKEN: LazyLock<Option<String>> = LazyLock::new(|| {
	if let Ok(token) = std::env::var("MODBRIDGE_RELAY_AUTH_TOKEN") {
		let trimmed = token.trim();
		if !trimmed.is_empty() {
			return Some(trimmed.to_string());
		}
	}
	if let Some(token) = option_env!("MODBRIDGE_RELAY_AUTH_TOKEN") {
		let trimmed = token.trim();
		if !trimmed.is_empty() {
			return Some(trimmed.to_string());
		}
	}
	None
});

pub fn get_relay_base_url() -> Option<&'static str> {
	RELAY_BASE_URL.as_deref()
}

pub fn get_relay_token() -> Option<&'static str> {
	RELAY_AUTH_TOKEN.as_deref()
}

pub fn is_relay_enabled() -> bool {
	get_relay_base_url().is_some()
}

/// Rewrites an upstream URL to go through the Modbridge Relay if one is configured.
/// Returns the original URL unchanged if no relay is configured, if the URL is already
/// routed through the relay, or if the host is not in the allowlist.
pub fn route_url_through_relay(url: &str) -> String {
	let Some(relay_base) = get_relay_base_url() else {
		return url.to_string();
	};

	route_url_with_base(url, relay_base)
}

/// Prepares a request via the given reqwest client, routing the URL through
/// the Modbridge Relay and attaching the X-Modbridge-Token header if configured.
pub fn relay_request(
	client: &reqwest::Client,
	method: reqwest::Method,
	url: &str,
) -> reqwest::RequestBuilder {
	let target_url = route_url_through_relay(url);
	let mut req = client.request(method, &target_url);
	if let Some(token) = get_relay_token() {
		if target_url != url || (get_relay_base_url().is_some() && target_url.starts_with(get_relay_base_url().unwrap())) {
			req = req.header("X-Modbridge-Token", token);
		}
	}
	req
}

/// Pure routing function taking an explicit relay base URL for testability.
pub fn route_url_with_base(url: &str, relay_base: &str) -> String {
	let trimmed_base = relay_base.trim().trim_end_matches('/');
	if trimmed_base.is_empty() {
		return url.to_string();
	}

	// If already routed through the relay, do not re-route
	if url.starts_with(trimmed_base) {
		return url.to_string();
	}

	const REWRITE_MAP: &[(&str, &str)] = &[
		("https://api.modrinth.com", "/api"),
		("http://api.modrinth.com", "/api"),
		("https://cdn.modrinth.com", "/cdn"),
		("http://cdn.modrinth.com", "/cdn"),
		("https://launcher-meta.modrinth.com", "/launcher-meta"),
		("http://launcher-meta.modrinth.com", "/launcher-meta"),
		("https://piston-meta.mojang.com", "/piston-meta"),
		("http://piston-meta.mojang.com", "/piston-meta"),
		("https://piston-data.mojang.com", "/piston-data"),
		("http://piston-data.mojang.com", "/piston-data"),
		("https://resources.download.minecraft.net", "/minecraft-resources"),
		("http://resources.download.minecraft.net", "/minecraft-resources"),
		("https://libraries.minecraft.net", "/minecraft-libraries"),
		("http://libraries.minecraft.net", "/minecraft-libraries"),
		("https://api.minecraftservices.com", "/minecraft-services"),
		("http://api.minecraftservices.com", "/minecraft-services"),
		("https://sessionserver.mojang.com", "/mojang-session"),
		("http://sessionserver.mojang.com", "/mojang-session"),
		("https://textures.minecraft.net", "/minecraft-textures"),
		("http://textures.minecraft.net", "/minecraft-textures"),
		("https://launchermeta.mojang.com", "/mojang-meta"),
		("http://launchermeta.mojang.com", "/mojang-meta"),
		("https://launcher.mojang.com", "/mojang-launcher"),
		("http://launcher.mojang.com", "/mojang-launcher"),
	];

	for &(prefix, relay_prefix) in REWRITE_MAP {
		if let Some(suffix) = url.strip_prefix(prefix) {
			let path = if suffix.starts_with('/') {
				suffix
			} else if suffix.is_empty() {
				""
			} else {
				// Prevent substring domain matches like api.modrinth.com.evil.com
				return url.to_string();
			};
			return format!("{trimmed_base}{relay_prefix}{path}");
		}
	}

	url.to_string()
}

#[cfg(test)]
mod tests {
	use super::*;

	const TEST_RELAY: &str = "https://relay.modbridge.internal";

	#[test]
	fn test_route_modrinth_api() {
		assert_eq!(
			route_url_with_base("https://api.modrinth.com/v2/search?q=sodium", TEST_RELAY),
			"https://relay.modbridge.internal/api/v2/search?q=sodium"
		);
	}

	#[test]
	fn test_route_modrinth_cdn() {
		assert_eq!(
			route_url_with_base("https://cdn.modrinth.com/data/P7dR8mSH/versions/1.0.0/file.jar", TEST_RELAY),
			"https://relay.modbridge.internal/cdn/data/P7dR8mSH/versions/1.0.0/file.jar"
		);
	}

	#[test]
	fn test_route_launcher_meta() {
		assert_eq!(
			route_url_with_base("https://launcher-meta.modrinth.com/minecraft/v1/manifest.json", TEST_RELAY),
			"https://relay.modbridge.internal/launcher-meta/minecraft/v1/manifest.json"
		);
	}

	#[test]
	fn test_route_mojang_piston_meta() {
		assert_eq!(
			route_url_with_base("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json", TEST_RELAY),
			"https://relay.modbridge.internal/piston-meta/mc/game/version_manifest_v2.json"
		);
	}

	#[test]
	fn test_route_minecraft_resources() {
		assert_eq!(
			route_url_with_base("https://resources.download.minecraft.net/37/37a6b8296d66e", TEST_RELAY),
			"https://relay.modbridge.internal/minecraft-resources/37/37a6b8296d66e"
		);
	}

	#[test]
	fn test_route_minecraft_libraries() {
		assert_eq!(
			route_url_with_base("https://libraries.minecraft.net/net/sf/jopt-simple/jopt-simple/5.0.4/jopt-simple-5.0.4.jar", TEST_RELAY),
			"https://relay.modbridge.internal/minecraft-libraries/net/sf/jopt-simple/jopt-simple/5.0.4/jopt-simple-5.0.4.jar"
		);
	}

	#[test]
	fn test_route_minecraft_services() {
		assert_eq!(
			route_url_with_base("https://api.minecraftservices.com/launcher/login", TEST_RELAY),
			"https://relay.modbridge.internal/minecraft-services/launcher/login"
		);
	}

	#[test]
	fn test_route_mojang_session() {
		assert_eq!(
			route_url_with_base("https://sessionserver.mojang.com/session/minecraft/hasJoined", TEST_RELAY),
			"https://relay.modbridge.internal/mojang-session/session/minecraft/hasJoined"
		);
	}

	#[test]
	fn test_route_external_url_untouched() {
		let external = "https://github.com/ethantphillips/ModBridge/releases/latest";
		assert_eq!(route_url_with_base(external, TEST_RELAY), external);
	}

	#[test]
	fn test_route_spoofed_domain_untouched() {
		let spoof = "https://api.modrinth.com.evil.com/v2/search";
		assert_eq!(route_url_with_base(spoof, TEST_RELAY), spoof);
	}

	#[test]
	fn test_route_already_relayed_untouched() {
		let already = "https://relay.modbridge.internal/api/v2/search";
		assert_eq!(route_url_with_base(already, TEST_RELAY), already);
	}
}
