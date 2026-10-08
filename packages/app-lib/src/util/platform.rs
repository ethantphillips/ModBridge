//! Platform-related code
use daedalus::minecraft::{Os, OsRule};

// Bit width
#[cfg(target_pointer_width = "64")]
pub const ARCH_WIDTH: &str = "64";

#[cfg(target_pointer_width = "32")]
pub const ARCH_WIDTH: &str = "32";

// Platform rule handling
pub fn os_rule(
	rule: &OsRule,
	java_arch: &str,
	// Minecraft updated over 1.18.2 (supports MacOS Natively)
	minecraft_updated: bool,
) -> bool {
	let mut rule_match = true;

	if let Some(ref arch) = rule.arch {
		rule_match &= !matches!(arch.as_str(), "x86" | "arm");
	}

	if let Some(name) = &rule.name {
		if minecraft_updated
			&& (name != &Os::LinuxArm64 && name != &Os::LinuxArm32)
		{
			rule_match &= Os::native() == name.get_os()
				|| &Os::native_arch(java_arch) == name;
		} else {
			rule_match &= &Os::native_arch(java_arch) == name;
		}
	}

	// `rule.version` is ignored because it's not usually seen on real recent
	// Minecraft version manifests, its alleged regex syntax is undefined and is
	// likely to not match `Regex`'s, and the way to get the value to match it
	// against is allegedly calling `System.getProperty("os.version")`, which
	// on Windows the OpenJDK implements by fetching the kernel32.dll version,
	// an approach that no public Rust library implements. Moreover, launchers
	// such as PrismLauncher also ignore this field. Code references:
	// - https://github.com/openjdk/jdk/blob/948ade8e7003a41683600428c8e3155c7ed798db/src/java.base/windows/native/libjava/java_props_md.c#L556
	// - https://github.com/PrismLauncher/PrismLauncher/blob/1c20faccf88999474af70db098a4c10e7a03af33/launcher/minecraft/Rule.h#L77
	// - https://github.com/FillZpp/sys-info-rs/blob/60ecf1470a5b7c90242f429934a3bacb6023ec4d/c/windows.c#L23-L38

	rule_match
}

pub fn classpath_separator(java_arch: &str) -> &'static str {
	match Os::native_arch(java_arch) {
		Os::Osx
		| Os::OsxArm64
		| Os::Linux
		| Os::LinuxArm32
		| Os::LinuxArm64
		| Os::Unknown => ":",
		Os::Windows | Os::WindowsArm64 => ";",
	}
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
	use super::*;

	fn rule(os: Os) -> OsRule {
		OsRule {
			name: Some(os),
			arch: None,
			version: None,
		}
	}

	#[test]
	fn excludes_linux_arm_libraries_from_x64_runtimes() {
		for modern in [false, true] {
			for architecture in ["amd64", "x86_64"] {
				assert!(!os_rule(&rule(Os::LinuxArm64), architecture, modern));
				assert!(!os_rule(&rule(Os::LinuxArm32), architecture, modern));
			}
		}
	}

	#[test]
	fn linux_arm_libraries_require_the_matching_runtime_architecture() {
		for modern in [false, true] {
			assert!(os_rule(&rule(Os::LinuxArm64), "aarch64", modern));
			assert!(!os_rule(&rule(Os::LinuxArm64), "arm", modern));
			assert!(os_rule(&rule(Os::LinuxArm32), "arm", modern));
			assert!(!os_rule(&rule(Os::LinuxArm32), "aarch64", modern));
		}
	}

	#[test]
	fn generic_linux_libraries_keep_the_modern_runtime_behavior() {
		for architecture in ["amd64", "x86_64", "aarch64", "arm"] {
			assert!(os_rule(&rule(Os::Linux), architecture, true));
		}
		assert!(!os_rule(&rule(Os::Linux), "aarch64", false));
		assert!(!os_rule(&rule(Os::Linux), "arm", false));
	}
}
