use crate::api::Result;
use async_zip::base::read::seek::ZipFileReader;
use serde::Serialize;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Runtime;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_http::reqwest;
use tokio::io::AsyncWriteExt;

pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
	tauri::plugin::Builder::new("files")
		.invoke_handler(tauri::generate_handler![
			file_extract_zip,
			file_save_as,
			file_read_dragged_file,
			file_list,
			file_read,
			file_write,
			file_create_directory,
			file_rename,
			file_delete,
			download_file_to_user_destination,
			save_blob_to_user_destination,
		])
		.build()
}

fn suggested_filename(name: &str) -> String {
	let basename = name.rsplit(['/', '\\']).next().unwrap_or_default();
	let mut sanitized = String::new();
	for character in basename.chars() {
		let character = if character.is_control()
			|| matches!(character, '<' | '>' | ':' | '"' | '|' | '?' | '*')
		{
			'_'
		} else {
			character
		};
		if sanitized.len() + character.len_utf8() > 200 {
			break;
		}
		sanitized.push(character);
	}
	let sanitized = sanitized.trim().trim_end_matches(['.', ' ']);
	if sanitized.is_empty() {
		return "download".to_string();
	}
	let stem = sanitized.split('.').next().unwrap_or_default();
	let upper = stem.to_ascii_uppercase();
	let numbered_device = upper
		.strip_prefix("COM")
		.or_else(|| upper.strip_prefix("LPT"))
		.is_some_and(|suffix| {
			suffix.len() == 1 && matches!(suffix.as_bytes()[0], b'1'..=b'9')
		});
	let reserved = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
		|| numbered_device;
	if reserved {
		format!("_{sanitized}")
	} else {
		sanitized.to_string()
	}
}

async fn choose_destination<R: Runtime>(
	app: &tauri::AppHandle<R>,
	name: &str,
) -> Result<Option<PathBuf>> {
	let (sender, receiver) = tokio::sync::oneshot::channel();
	app.dialog()
		.file()
		.set_file_name(suggested_filename(name))
		.save_file(|path| {
			let _ = sender.send(path);
		});
	let destination = receiver.await.map_err(|_| {
		theseus::Error::from(theseus::ErrorKind::OtherError(
			"Save dialog closed unexpectedly".to_string(),
		))
	})?;
	destination
		.map(|path| {
			PathBuf::try_from(path).map_err(|error| {
				theseus::Error::from(theseus::ErrorKind::OtherError(format!(
					"Invalid save path: {error}"
				)))
				.into()
			})
		})
		.transpose()
}

fn fetch_error(error: reqwest::Error) -> theseus::Error {
	theseus::Error::from(theseus::ErrorKind::FetchError(error.without_url()))
}

fn relay_download_client(relay_base: &str) -> Result<reqwest::Client> {
	let relay_base = url::Url::parse(relay_base).map_err(|_| {
		theseus::Error::from(theseus::ErrorKind::InputError(
			"Invalid Relay URL".to_string(),
		))
	})?;
	let relay_path = relay_base.path().trim_end_matches('/').to_string();
	let loopback = relay_base.host_str().is_some_and(|host| {
		host == "localhost"
			|| host
				.parse::<std::net::IpAddr>()
				.is_ok_and(|ip| ip.is_loopback())
	});
	let redirect = reqwest::redirect::Policy::custom(move |attempt| {
		let path = attempt.url().path();
		if attempt.previous().len() >= 10 {
			attempt.error("Too many Relay download redirects")
		} else if attempt.url().origin() == relay_base.origin()
			&& (relay_path.is_empty()
				|| path == relay_path
				|| path.starts_with(&format!("{relay_path}/")))
			&& attempt.url().username().is_empty()
			&& attempt.url().password().is_none()
		{
			attempt.follow()
		} else {
			attempt.error("Download redirected outside Relay")
		}
	});
	let mut builder = reqwest::Client::builder()
		.user_agent(theseus::launcher_user_agent())
		.connect_timeout(Duration::from_secs(15))
		.read_timeout(Duration::from_secs(30))
		.redirect(redirect);
	if loopback {
		builder = builder.no_proxy();
	}
	Ok(builder.build().map_err(fetch_error)?)
}

struct StagedFile {
	file: tokio::fs::File,
	path: tempfile::TempPath,
}

fn create_staging_file(destination: &Path) -> Result<StagedFile> {
	let parent = destination.parent().ok_or_else(|| {
		theseus::Error::from(theseus::ErrorKind::InputError(
			"Save destination has no parent directory".to_string(),
		))
	})?;
	let staged = tempfile::Builder::new()
		.prefix(".modbridge-download-")
		.tempfile_in(parent)?;
	let (file, path) = staged.into_parts();
	Ok(StagedFile {
		file: tokio::fs::File::from_std(file),
		path,
	})
}

async fn finish_staged_file(
	mut staged: StagedFile,
	destination: &Path,
) -> Result<()> {
	staged.file.flush().await?;
	staged.file.sync_all().await?;
	let StagedFile { file, path } = staged;
	drop(file);
	path.persist(destination).map_err(|error| error.error)?;
	Ok(())
}

async fn download_to_destination(
	request: reqwest::RequestBuilder,
	destination: &Path,
) -> Result<()> {
	let mut response = request.send().await.map_err(fetch_error)?;
	if !response.status().is_success() {
		return Err(theseus::Error::from(theseus::ErrorKind::OtherError(
			format!("Relay download failed with HTTP {}", response.status()),
		))
		.into());
	}
	let mut staged = create_staging_file(destination)?;
	while let Some(chunk) = response.chunk().await.map_err(fetch_error)? {
		staged.file.write_all(&chunk).await?;
	}
	finish_staged_file(staged, destination).await
}

async fn save_bytes_to_destination(
	data: &[u8],
	destination: &Path,
) -> Result<()> {
	let mut staged = create_staging_file(destination)?;
	staged.file.write_all(data).await?;
	finish_staged_file(staged, destination).await
}

fn download_request(
	client: &reqwest::Client,
	url: &str,
	token: Option<&str>,
) -> Result<reqwest::RequestBuilder> {
	let mut request = client.get(url);
	if let Some(token) = token {
		let mut header = reqwest::header::HeaderValue::from_str(token)
			.map_err(|_| {
				theseus::Error::from(theseus::ErrorKind::InputError(
					"Invalid Relay token".to_string(),
				))
			})?;
		header.set_sensitive(true);
		request = request.header("X-Modbridge-Token", header);
	}
	Ok(request)
}

#[tauri::command]
pub async fn download_file_to_user_destination<R: Runtime>(
	app: tauri::AppHandle<R>,
	url: &str,
	name: &str,
) -> Result<bool> {
	let url = theseus::route_url_through_relay(url).map_err(|error| {
		theseus::Error::from(theseus::ErrorKind::RelayRouting(error))
	})?;
	let Some(destination) = choose_destination(&app, name).await? else {
		return Ok(false);
	};
	let client = relay_download_client(theseus::get_relay_base_url())?;
	let request = download_request(&client, &url, theseus::get_relay_token())?;
	download_to_destination(request, &destination).await?;
	Ok(true)
}

#[tauri::command]
pub async fn save_blob_to_user_destination<R: Runtime>(
	app: tauri::AppHandle<R>,
	data: Vec<u8>,
	name: &str,
) -> Result<bool> {
	let Some(destination) = choose_destination(&app, name).await? else {
		return Ok(false);
	};
	save_bytes_to_destination(&data, &destination).await?;
	Ok(true)
}

#[derive(Serialize)]
pub struct ExtractDryRunResult {
    modpack_name: Option<String>,
    conflicting_files: Vec<String>,
}

#[tauri::command]
pub async fn file_read_dragged_file(path: String) -> Result<Vec<u8>> {
    let metadata = tokio::fs::metadata(&path).await?;
    if !metadata.is_file() {
        return Err(theseus::Error::from(theseus::ErrorKind::OtherError(
            "Dropped path is not a file".to_string(),
        ))
        .into());
    }

    Ok(tokio::fs::read(path).await?)
}

#[tauri::command]
pub async fn file_extract_zip(
    instance_id: &str,
    file_path: &str,
    override_conflicts: bool,
    dry_run: bool,
) -> Result<Option<ExtractDryRunResult>> {
    theseus::instance::validate_instance_file_write(instance_id, file_path)
        .await?;
    let parent = file_path
        .trim_start_matches('/')
        .rsplit_once('/')
        .map_or("", |(parent, _)| parent);
    let file_bytes =
        theseus::instance::read_instance_file(instance_id, file_path).await?;
    let zip_reader = ZipFileReader::with_tokio(Cursor::new(file_bytes))
        .await
        .map_err(|error| {
        theseus::Error::from(theseus::ErrorKind::OtherError(format!(
            "Failed to read zip file: {error}"
        )))
    })?;
    let mut entries = Vec::new();
    for (index, entry) in zip_reader.file().entries().iter().enumerate() {
        let name = entry.filename().as_str().map_err(|error| {
            theseus::Error::from(theseus::ErrorKind::InputError(
                error.to_string(),
            ))
        })?;
        if name.ends_with('/') {
            continue;
        }
        if name.starts_with('/') || name.contains('\\') {
            return Err(theseus::Error::from(theseus::ErrorKind::InputError(
                "Invalid archive path".to_string(),
            ))
            .into());
        }
        let target = if parent.is_empty() {
            name.to_string()
        } else {
            format!("{parent}/{name}")
        };
        let resolved = theseus::instance::validate_instance_file_write(
            instance_id,
            &target,
        )
        .await?;
        entries.push((index, target, resolved));
    }
    if dry_run {
        let conflicting_files = entries
            .iter()
            .filter(|(_, _, path)| path.exists())
            .map(|(_, name, _)| name.clone())
            .collect();
        return Ok(Some(ExtractDryRunResult {
            modpack_name: None,
            conflicting_files,
        }));
    }
    let mut zip_reader = zip_reader;
    for (index, path, resolved) in entries {
        if !override_conflicts && resolved.exists() {
            continue;
        }
        let mut bytes = Vec::new();
        let mut reader =
            zip_reader.reader_with_entry(index).await.map_err(|error| {
                theseus::Error::from(theseus::ErrorKind::OtherError(
                    error.to_string(),
                ))
            })?;
        reader
            .read_to_end_checked(&mut bytes)
            .await
            .map_err(|error| {
                theseus::Error::from(theseus::ErrorKind::OtherError(
                    error.to_string(),
                ))
            })?;
        theseus::instance::write_instance_file(
            instance_id,
            &path,
            &bytes,
            !override_conflicts,
        )
        .await?;
    }
    Ok(None)
}

#[tauri::command]
pub async fn file_list(
    instance_id: &str,
    path: &str,
) -> Result<Vec<theseus::instance::InstanceFileItem>> {
    Ok(theseus::instance::list_instance_files(instance_id, path).await?)
}

#[tauri::command]
pub async fn file_read(instance_id: &str, path: &str) -> Result<Vec<u8>> {
    Ok(theseus::instance::read_instance_file(instance_id, path).await?)
}

#[tauri::command]
pub async fn file_write(
    instance_id: &str,
    path: &str,
    bytes: Vec<u8>,
    create_only: bool,
) -> Result<()> {
    Ok(theseus::instance::write_instance_file(
        instance_id,
        path,
        &bytes,
        create_only,
    )
    .await?)
}

#[tauri::command]
pub async fn file_create_directory(
    instance_id: &str,
    path: &str,
) -> Result<()> {
    Ok(theseus::instance::create_instance_directory(instance_id, path).await?)
}

#[tauri::command]
pub async fn file_rename(
    instance_id: &str,
    source: &str,
    destination: &str,
) -> Result<()> {
    Ok(theseus::instance::rename_instance_file(
        instance_id,
        source,
        destination,
    )
    .await?)
}

#[tauri::command]
pub async fn file_delete(
    instance_id: &str,
    path: &str,
    recursive: bool,
) -> Result<()> {
    Ok(
        theseus::instance::delete_instance_file(instance_id, path, recursive)
            .await?,
    )
}

#[tauri::command]
pub async fn file_save_as<R: Runtime>(
    app: tauri::AppHandle<R>,
    instance_id: &str,
    file_path: &str,
) -> Result<()> {
    let source = std::path::Path::new(file_path);
    let file_name = source
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(&file_name)
        .save_file(|path| {
            let _ = tx.send(path);
        });

    if let Some(dest) = rx.await.unwrap_or(None) {
        let dest_path = std::path::PathBuf::try_from(dest).map_err(|e| {
            theseus::Error::from(theseus::ErrorKind::OtherError(format!(
                "Invalid save path: {e}"
            )))
        })?;
        theseus::instance::save_instance_file_as(
            instance_id,
            file_path,
            &dest_path,
        )
        .await?;
    }

    Ok(())
}

#[cfg(test)]
mod file_download_tests {
	use super::*;
	use tokio::io::AsyncReadExt;
	use tokio::net::TcpListener;

	async fn mock_response(
		response: Vec<u8>,
	) -> (String, tokio::task::JoinHandle<String>) {
		let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
		let base = format!("http://{}/relay", listener.local_addr().unwrap());
		let server = tokio::spawn(async move {
			let (mut stream, _) = listener.accept().await.unwrap();
			let mut request = Vec::new();
			while !request.ends_with(b"\r\n\r\n") {
				request.push(stream.read_u8().await.unwrap());
				assert!(request.len() <= 16_384);
			}
			for chunk in response.chunks(13) {
				stream.write_all(chunk).await.unwrap();
				tokio::task::yield_now().await;
			}
			String::from_utf8(request).unwrap()
		});
		(base, server)
	}

	fn assert_no_staged_files(directory: &Path) {
		assert!(std::fs::read_dir(directory).unwrap().all(|entry| {
			!entry
				.unwrap()
				.file_name()
				.to_string_lossy()
				.starts_with(".modbridge-download-")
		}));
	}

	#[test]
	fn suggested_filename_uses_safe_basename() {
		assert_eq!(suggested_filename("../../world.zip"), "world.zip");
		assert_eq!(suggested_filename("C:\\temp\\backup.zip"), "backup.zip");
		assert_eq!(suggested_filename("bad:?*\n.zip"), "bad____.zip");
		assert_eq!(suggested_filename(".."), "download");
		assert_eq!(suggested_filename("COM1.zip"), "_COM1.zip");
		assert_eq!(suggested_filename("lpt9"), "_lpt9");
		assert!(suggested_filename(&"界".repeat(200)).len() <= 200);
	}

	#[tokio::test]
	async fn streamed_download_atomically_replaces_selected_file() {
		let (base, server) = mock_response(
			b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nworld\r\n6\r\n-bytes\r\n0\r\n\r\n".to_vec(),
		)
		.await;
		let directory = tempfile::tempdir().unwrap();
		let destination = directory.path().join("world.zip");
		std::fs::write(&destination, b"previous").unwrap();
		let client = relay_download_client(&base).unwrap();
		let request = download_request(
			&client,
			&format!("{base}/backup?token=node-secret"),
			Some("relay-secret"),
		)
		.unwrap();
		assert!(request.try_clone().unwrap().build().unwrap().headers()
			["X-Modbridge-Token"]
			.is_sensitive());
		download_to_destination(request, &destination)
			.await
			.unwrap();
		assert_eq!(std::fs::read(&destination).unwrap(), b"world-bytes");
		assert_no_staged_files(directory.path());
		let request = server.await.unwrap();
		assert!(
			request.starts_with("GET /relay/backup?token=node-secret HTTP/1.1")
		);
		assert!(
			request
				.to_ascii_lowercase()
				.contains("x-modbridge-token: relay-secret")
		);
	}

	#[tokio::test]
	async fn incomplete_download_keeps_original_and_removes_staged_file() {
		let (base, server) = mock_response(
			b"HTTP/1.1 200 OK\r\nContent-Length: 30\r\nConnection: close\r\n\r\npartial".to_vec(),
		)
		.await;
		let directory = tempfile::tempdir().unwrap();
		let destination = directory.path().join("backup.zip");
		std::fs::write(&destination, b"previous").unwrap();
		let request = relay_download_client(&base)
			.unwrap()
			.get(format!("{base}/download?token=private-node-token"));
		let error = download_to_destination(request, &destination)
			.await
			.unwrap_err();
		assert!(!error.to_string().contains("private-node-token"));
		assert_eq!(std::fs::read(&destination).unwrap(), b"previous");
		assert_no_staged_files(directory.path());
		server.await.unwrap();
	}

	#[tokio::test]
	async fn failed_http_status_keeps_original_without_staging() {
		for status in
			["404 Not Found", "500 Internal Server Error", "302 Found"]
		{
			let (base, server) = mock_response(
				format!(
					"HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
				)
				.into_bytes(),
			)
			.await;
			let directory = tempfile::tempdir().unwrap();
			let destination = directory.path().join("backup.zip");
			std::fs::write(&destination, b"previous").unwrap();
			let request = relay_download_client(&base)
				.unwrap()
				.get(format!("{base}/download"));
			assert!(
				download_to_destination(request, &destination)
					.await
					.is_err()
			);
			assert_eq!(std::fs::read(&destination).unwrap(), b"previous");
			assert_no_staged_files(directory.path());
			server.await.unwrap();
		}
	}

	#[tokio::test]
	async fn external_redirect_is_rejected_before_connecting() {
		let external = TcpListener::bind("127.0.0.1:0").await.unwrap();
		let target = format!("http://{}/file", external.local_addr().unwrap());
		let attempted_connection = tokio::spawn(async move {
			match tokio::time::timeout(
				Duration::from_millis(300),
				external.accept(),
			)
			.await
			{
				Ok(Ok((mut stream, _))) => {
					let _ = stream
						.write_all(
							b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",
						)
						.await;
					true
				}
				_ => false,
			}
		});
		let (base, server) = mock_response(
			format!("HTTP/1.1 302 Found\r\nLocation: {target}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes(),
		)
		.await;
		let directory = tempfile::tempdir().unwrap();
		let destination = directory.path().join("backup.zip");
		let request = relay_download_client(&base)
			.unwrap()
			.get(format!("{base}/download"));
		assert!(
			download_to_destination(request, &destination)
				.await
				.is_err()
		);
		assert!(!destination.exists());
		assert_no_staged_files(directory.path());
		assert!(!attempted_connection.await.unwrap());
		server.await.unwrap();
	}

	#[tokio::test]
	async fn same_origin_redirect_cannot_escape_relay_base_path() {
		let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
		let base = format!("http://{}/relay", listener.local_addr().unwrap());
		let server = tokio::spawn(async move {
			let (mut stream, _) = listener.accept().await.unwrap();
			let mut request = Vec::new();
			while !request.ends_with(b"\r\n\r\n") {
				request.push(stream.read_u8().await.unwrap());
			}
			stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: /outside-relay/file\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
			drop(stream);
			tokio::time::timeout(Duration::from_millis(300), listener.accept())
				.await
				.is_ok()
		});
		let directory = tempfile::tempdir().unwrap();
		let destination = directory.path().join("backup.zip");
		let request = relay_download_client(&base)
			.unwrap()
			.get(format!("{base}/download"));
		assert!(
			download_to_destination(request, &destination)
				.await
				.is_err()
		);
		assert!(!destination.exists());
		assert_no_staged_files(directory.path());
		assert!(!server.await.unwrap());
	}

	#[tokio::test]
	async fn allowed_relay_redirect_preserves_token_and_downloads() {
		let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
		let base = format!("http://{}/relay", listener.local_addr().unwrap());
		let server = tokio::spawn(async move {
			for response in [
				b"HTTP/1.1 302 Found\r\nLocation: /relay/file\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".as_slice(),
				b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nbackup".as_slice(),
			] {
				let (mut stream, _) = listener.accept().await.unwrap();
				let mut request = Vec::new();
				while !request.ends_with(b"\r\n\r\n") {
					request.push(stream.read_u8().await.unwrap());
				}
				assert!(String::from_utf8(request).unwrap().to_ascii_lowercase().contains("x-modbridge-token: relay-secret"));
				stream.write_all(response).await.unwrap();
			}
		});
		let directory = tempfile::tempdir().unwrap();
		let destination = directory.path().join("backup.zip");
		let client = relay_download_client(&base).unwrap();
		let request = download_request(
			&client,
			&format!("{base}/download"),
			Some("relay-secret"),
		)
		.unwrap();
		download_to_destination(request, &destination)
			.await
			.unwrap();
		assert_eq!(std::fs::read(&destination).unwrap(), b"backup");
		assert_no_staged_files(directory.path());
		server.await.unwrap();
	}

	#[tokio::test]
	async fn cancelled_download_keeps_original_and_removes_staged_file() {
		let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
		let base = format!("http://{}/relay", listener.local_addr().unwrap());
		let server = tokio::spawn(async move {
			let (mut stream, _) = listener.accept().await.unwrap();
			let mut request = Vec::new();
			while !request.ends_with(b"\r\n\r\n") {
				request.push(stream.read_u8().await.unwrap());
			}
			stream
				.write_all(
					b"HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\npartial",
				)
				.await
				.unwrap();
			std::future::pending::<()>().await;
		});
		let directory = tempfile::tempdir().unwrap();
		let destination = directory.path().join("backup.zip");
		std::fs::write(&destination, b"previous").unwrap();
		let request = relay_download_client(&base)
			.unwrap()
			.get(format!("{base}/download"));
		let task_destination = destination.clone();
		let download = tokio::spawn(async move {
			download_to_destination(request, &task_destination).await
		});
		tokio::time::timeout(Duration::from_secs(2), async {
			loop {
				if std::fs::read_dir(directory.path()).unwrap().count() == 2 {
					break;
				}
				tokio::time::sleep(Duration::from_millis(10)).await;
			}
		})
		.await
		.unwrap();
		download.abort();
		assert!(download.await.unwrap_err().is_cancelled());
		server.abort();
		let _ = server.await;
		assert_eq!(std::fs::read(&destination).unwrap(), b"previous");
		assert_no_staged_files(directory.path());
	}

	#[tokio::test]
	async fn blob_save_atomically_replaces_selected_file() {
		let directory = tempfile::tempdir().unwrap();
		let destination = directory.path().join("debug.json");
		std::fs::write(&destination, b"previous").unwrap();
		save_bytes_to_destination(b"new-debug-export", &destination)
			.await
			.unwrap();
		assert_eq!(std::fs::read(&destination).unwrap(), b"new-debug-export");
		assert_no_staged_files(directory.path());
	}
}
