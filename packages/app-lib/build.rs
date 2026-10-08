use std::ffi::OsString;
use std::path::PathBuf;
use std::process::{Command, exit};
use std::{env, fs};

fn main() {
    println!("cargo::rerun-if-changed=.env");
    println!("cargo::rerun-if-changed=java/gradle");
    println!("cargo::rerun-if-changed=java/src");
    println!("cargo::rerun-if-changed=java/build.gradle.kts");
    println!("cargo::rerun-if-changed=java/settings.gradle.kts");
    println!("cargo::rerun-if-changed=java/gradle.properties");

    set_env();
    build_java_jars();
}

fn set_env() {
	let mut env_map = std::collections::HashMap::new();

	// Default Modrinth / Modbridge environment variables
	env_map.insert(
		"MODRINTH_API_URL".to_string(),
		"https://api.modrinth.com/v2/".to_string(),
	);
	env_map.insert(
		"MODRINTH_API_URL_V3".to_string(),
		"https://api.modrinth.com/v3/".to_string(),
	);
	env_map.insert(
		"MODRINTH_API_BASE_URL".to_string(),
		"https://api.modrinth.com/".to_string(),
	);
	env_map.insert(
		"MODRINTH_LAUNCHER_META_URL".to_string(),
		"https://launcher-meta.modrinth.com/".to_string(),
	);
	env_map.insert(
		"MODRINTH_SOCKET_URL".to_string(),
		"wss://api.modrinth.com/".to_string(),
	);
	env_map.insert(
		"SHARED_INSTANCES_API_BASE_URL".to_string(),
		"https://shared-instances.modrinth.com/".to_string(),
	);
	env_map.insert(
		"MODRINTH_ARCHON_BASE_URL".to_string(),
		"https://archon.modrinth.com/".to_string(),
	);
	env_map.insert(
		"MODRINTH_URL".to_string(),
		"https://modrinth.com/".to_string(),
	);

	// Allow dotenv to override
	for (var_name, var_value) in
		dotenvy::dotenv_iter().into_iter().flatten().flatten()
	{
		if var_name == "DATABASE_URL" {
			continue;
		}
		env_map.insert(var_name, var_value);
	}

	// Also check current process environment for overrides
	for key in [
		"MODRINTH_API_URL",
		"MODRINTH_API_URL_V3",
		"MODRINTH_API_BASE_URL",
		"MODRINTH_LAUNCHER_META_URL",
		"MODRINTH_SOCKET_URL",
		"SHARED_INSTANCES_API_BASE_URL",
		"MODRINTH_ARCHON_BASE_URL",
		"MODRINTH_URL",
		"MODBRIDGE_RELAY_BASE_URL",
		"MODBRIDGE_RELAY_AUTH_TOKEN",
		"MODBRIDGE_UPDATE_BASE_URL",
	] {
		println!("cargo::rerun-if-env-changed={key}");
		if let Ok(val) = env::var(key) {
			env_map.insert(key.to_string(), val);
		}
	}

	let relay_base = env_map
		.get("MODBRIDGE_RELAY_BASE_URL")
		.map(String::as_str)
		.filter(|value| !value.trim().is_empty())
		.unwrap_or(
			"https://br-divine-snow-ahjav8i1-relay.compute.c-3.us-east-1.aws.neon.tech",
		);
	let relay = url::Url::parse(relay_base)
		.expect("MODBRIDGE_RELAY_BASE_URL must be a valid URL");
	for (key, fallback, hosts) in [
		(
			"MODRINTH_API_URL",
			"https://api.modrinth.com/v2/",
			&["api.modrinth.com"][..],
		),
		(
			"MODRINTH_API_URL_V3",
			"https://api.modrinth.com/v3/",
			&["api.modrinth.com"][..],
		),
		(
			"MODRINTH_API_BASE_URL",
			"https://api.modrinth.com/",
			&["api.modrinth.com"][..],
		),
		(
			"MODRINTH_LAUNCHER_META_URL",
			"https://launcher-meta.modrinth.com/",
			&["launcher-meta.modrinth.com"][..],
		),
		(
			"SHARED_INSTANCES_API_BASE_URL",
			"https://shared-instances.modrinth.com/",
			&[
				"shared-instances.modrinth.com",
				"staging-shared-instances.modrinth.com",
			][..],
		),
		(
			"MODRINTH_ARCHON_BASE_URL",
			"https://archon.modrinth.com/",
			&["archon.modrinth.com", "staging-archon.modrinth.com"][..],
		),
	] {
		let supported = env_map
			.get(key)
			.and_then(|value| url::Url::parse(value).ok())
			.is_some_and(|value| {
				value.username().is_empty()
					&& value.password().is_none()
					&& value.query().is_none()
					&& value.fragment().is_none()
					&& ((value.origin() == relay.origin()
						&& value
							.path()
							.starts_with(relay.path().trim_end_matches('/')))
						|| (matches!(value.scheme(), "http" | "https")
							&& value.port().is_none()
							&& value
								.host_str()
								.is_some_and(|host| hosts.contains(&host))))
			});
		if !supported {
			println!(
				"cargo::warning=Replacing unsupported {key} with its canonical service URL; all requests use Relay"
			);
			env_map.insert(key.to_string(), fallback.to_string());
		}
	}
	let mut socket_base = relay.clone();
	let socket_scheme = if socket_base.scheme() == "https" {
		"wss"
	} else {
		"ws"
	};
	socket_base
		.set_scheme(socket_scheme)
		.expect("Relay URL must use HTTP or HTTPS");
	socket_base
		.set_path(&format!("{}/api/", relay.path().trim_end_matches('/')));
	env_map.insert("MODRINTH_SOCKET_URL".to_string(), socket_base.to_string());

	for (var_name, var_value) in env_map {
		println!("cargo::rustc-env={var_name}={var_value}");
	}
}

fn build_java_jars() {
    let out_dir =
        dunce::canonicalize(PathBuf::from(env::var_os("OUT_DIR").unwrap()))
            .unwrap();

    println!(
        "cargo::rustc-env=JAVA_JARS_DIR={}",
        out_dir.join("java/libs").display()
    );

    let gradle_path = fs::canonicalize(
        #[cfg(target_os = "windows")]
        "java\\gradlew.bat",
        #[cfg(not(target_os = "windows"))]
        "java/gradlew",
    )
    .unwrap();

    let mut build_dir_str = OsString::from("-Dorg.gradle.project.buildDir=");
    build_dir_str.push(out_dir.join("java"));
    let exit_status = Command::new(gradle_path)
        .arg(build_dir_str)
        .arg("build")
        .arg("--no-daemon")
        .arg("--console=rich")
        .current_dir(dunce::canonicalize("java").unwrap())
        .status()
        .expect("Failed to wait on Gradle build");

    if !exit_status.success() {
        println!("cargo::error=Gradle build failed with {exit_status}");
        exit(exit_status.code().unwrap_or(1));
    }
}
