use crate::{Error, ErrorKind, Result};
use serde::Deserialize;
use std::fmt::Display;
use std::mem;

#[derive(Debug, Clone)]
pub enum ServerAddress {
    Unresolved(String),
    Resolved {
        original_host: String,
        original_port: u16,
        resolved_host: String,
        resolved_port: u16,
    },
}

impl ServerAddress {
    pub async fn resolve(&mut self) -> Result<()> {
        match self {
            Self::Unresolved(address) => {
                let (host, port) = parse_server_address(address)?;
                let (resolved_host, resolved_port) =
                    resolve_server_address(host, port).await?;
                *self = Self::Resolved {
                    original_host: if host.len() == address.len() {
                        mem::take(address)
                    } else {
                        host.to_owned()
                    },
                    original_port: port,
                    resolved_host,
                    resolved_port,
                }
            }
            Self::Resolved { .. } => {}
        }
        Ok(())
    }

    pub fn require_resolved(&self) -> Result<(&str, u16)> {
        match self {
            Self::Resolved {
                resolved_host,
                resolved_port,
                ..
            } => Ok((resolved_host, *resolved_port)),
            Self::Unresolved(address) => Err(ErrorKind::InputError(format!(
                "Unexpected unresolved server address: {address}"
            ))
            .into()),
        }
    }
}

impl Display for ServerAddress {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unresolved(address) => write!(f, "{address}"),
            Self::Resolved {
                resolved_host,
                resolved_port,
                ..
            } => {
                if resolved_host.contains(':') {
                    write!(f, "[{resolved_host}]:{resolved_port}")
                } else {
                    write!(f, "{resolved_host}:{resolved_port}")
                }
            }
        }
    }
}

pub fn parse_server_address(address: &str) -> Result<(&str, u16)> {
    parse_server_address_inner(address)
        .map_err(|e| Error::from(ErrorKind::InputError(e)))
}

// Reimplementation of Guava's HostAndPort#fromString with a default port of 25565
fn parse_server_address_inner(
    address: &str,
) -> std::result::Result<(&str, u16), String> {
    let (host, port_str) = if address.starts_with("[") {
        let (Some(colon_index), Some(close_bracket_index)) =
            (address.find(':'), address.rfind(']'))
        else {
            return Err(format!("Invalid bracketed host/port: {address}"));
        };
        if close_bracket_index <= colon_index {
            return Err(format!("Invalid bracketed host/port: {address}"));
        }

        let host = &address[1..close_bracket_index];
        if close_bracket_index + 1 == address.len() {
            (host, "")
        } else {
            if address.as_bytes().get(close_bracket_index + 1).copied()
                != Some(b':')
            {
                return Err(format!(
                    "Only a colon may follow a close bracket: {address}"
                ));
            }
            let port_str = &address[close_bracket_index + 2..];
            for c in port_str.chars() {
                if !c.is_ascii_digit() {
                    return Err(format!("Port must be numeric: {address}"));
                }
            }
            (host, port_str)
        }
    } else {
        if let Some((host, port)) = address.split_once(':')
            && !port.contains(':')
        {
            (host, port)
        } else {
            (address, "")
        }
    };

    let mut port = None;
    if !port_str.is_empty() {
        if port_str.starts_with('+') {
            return Err(format!("Unparsable port number: {port_str}"));
        }
        port = port_str.parse::<u16>().ok();
        if port.is_none() {
            return Err(format!("Unparsable port number: {port_str}"));
        }
    }

    Ok((host, port.unwrap_or(25565)))
}

pub async fn resolve_server_address(
    host: &str,
    port: u16,
) -> Result<(String, u16)> {
	resolve_server_address_with_base(
		host,
		port,
		crate::util::relay::get_relay_base_url(),
		&crate::util::fetch::INSECURE_REQWEST_CLIENT,
	)
	.await
}

#[derive(Deserialize)]
struct RelayResolvedServer {
	resolved_host: String,
	resolved_port: u16,
}

async fn resolve_server_address_with_base(
	host: &str,
	port: u16,
	relay_base: &str,
	client: &reqwest::Client,
) -> Result<(String, u16)> {
	let response = crate::util::relay::relay_request_with_base(
		client,
		reqwest::Method::POST,
		&format!("{}/server/resolve", relay_base.trim_end_matches('/')),
		relay_base,
		crate::util::relay::get_relay_token(),
	)?
	.json(&serde_json::json!({ "host": host, "port": port }))
	.timeout(std::time::Duration::from_secs(10))
	.send()
	.await?
	.error_for_status()?;
	let resolved: RelayResolvedServer = response.json().await?;
	Ok((resolved.resolved_host, resolved.resolved_port))
}

#[cfg(test)]
mod tests {
    use super::parse_server_address_inner;

    #[test]
    fn parses_ipv4_server_addresses() {
        for (address, expected) in [
            ("192.0.2.1", ("192.0.2.1", 25565)),
            ("192.0.2.1:25566", ("192.0.2.1", 25566)),
        ] {
            assert_eq!(parse_server_address_inner(address), Ok(expected));
        }
    }

    #[test]
    fn parses_ipv6_server_addresses() {
        for (address, expected) in [
            ("2001:db8::1", ("2001:db8::1", 25565)),
            ("[2001:db8::1]", ("2001:db8::1", 25565)),
            ("[2001:db8::1]:25566", ("2001:db8::1", 25566)),
        ] {
            assert_eq!(parse_server_address_inner(address), Ok(expected));
        }
    }

	#[tokio::test]
	async fn resolves_remote_server_only_through_relay() {
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
								b"POST /server/resolve HTTP/1.1\r\n"
							)
						);
						assert_eq!(
							body,
							serde_json::json!({"host": "minecraft.example", "port": 25565})
						);
						break;
}
				}
			}
			let body = serde_json::json!({"resolved_host": "203.0.113.10", "resolved_port": 25570}).to_string();
			stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
		});
		let client = reqwest::Client::builder().no_proxy().build().unwrap();
		assert_eq!(
			super::resolve_server_address_with_base(
				"minecraft.example",
				25565,
				&base,
				&client
			)
			.await
			.unwrap(),
			("203.0.113.10".to_string(), 25570)
		);
		server.await.unwrap();
	}
}
