//! Deterministic offline player identity derivation for Modbridge.
//!
//! Generates reproducible, RFC 4122 v4 compliant UUIDs from a Minecraft
//! username and user-provided Identity PIN using SHA-256.

use sha2::{Digest, Sha256};
use uuid::Uuid;

/// Error type for offline identity derivation
#[derive(Debug, thiserror::Error)]
pub enum OfflineIdentityError {
	#[error("Username cannot be empty")]
	EmptyUsername,
	#[error("Username contains invalid characters (allowed: a-z, A-Z, 0-9, _)")]
	InvalidUsername,
	#[error("Identity PIN cannot be empty")]
	EmptyPin,
}

/// Normalizes a Minecraft username for deterministic UUID derivation.
/// Trims whitespace and lowercases to avoid splitting inventories/state
/// due to inconsistent casing across servers or launchers.
pub fn normalize_username(username: &str) -> String {
	username.trim().to_lowercase()
}

/// Derives a deterministic UUID from a Minecraft username and Identity PIN.
///
/// Formulation:
/// 1. `normalized_username = username.trim().to_lowercase()`
/// 2. `input = "modbridge:offline-player:v1:" + normalized_username + ":" + pin.trim()`
/// 3. `digest = SHA-256(UTF8(input))`
/// 4. `uuid_bytes = first 16 bytes of digest`
/// 5. Set RFC 4122 Variant (bits 6-7 of octet 8 to `10`)
/// 6. Set RFC 4122 Version 4 (bits 4-7 of octet 6 to `0100`)
pub fn derive_offline_uuid(
	username: &str,
	pin: &str,
) -> Result<Uuid, OfflineIdentityError> {
	let trimmed_username = username.trim();
	if trimmed_username.is_empty() {
		return Err(OfflineIdentityError::EmptyUsername);
	}

	if !trimmed_username
		.chars()
		.all(|c| c.is_ascii_alphanumeric() || c == '_')
	{
		return Err(OfflineIdentityError::InvalidUsername);
	}

	let trimmed_pin = pin.trim();
	if trimmed_pin.is_empty() {
		return Err(OfflineIdentityError::EmptyPin);
	}

	let normalized_name = normalize_username(trimmed_username);
	let input = format!("modbridge:offline-player:v1:{normalized_name}:{trimmed_pin}");

	let mut hasher = Sha256::new();
	hasher.update(input.as_bytes());
	let digest = hasher.finalize();

	let mut uuid_bytes = [0u8; 16];
	uuid_bytes.copy_from_slice(&digest[0..16]);

	// Set RFC 4122 variant (bits 6-7 of octet 8 to 10)
	uuid_bytes[8] = (uuid_bytes[8] & 0x3f) | 0x80;

	// Set RFC 4122 version 4 (bits 4-7 of octet 6 to 0100)
	uuid_bytes[6] = (uuid_bytes[6] & 0x0f) | 0x40;

	Ok(Uuid::from_bytes(uuid_bytes))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn test_deterministic_uuid_derivation() {
		let uuid_steve_1234 = derive_offline_uuid("Steve", "1234").unwrap();
		let uuid_steve_1234_repeat =
			derive_offline_uuid("Steve", "1234").unwrap();
		assert_eq!(
			uuid_steve_1234, uuid_steve_1234_repeat,
			"Same username + same PIN must yield identical UUID"
		);

		let uuid_steve_5678 = derive_offline_uuid("Steve", "5678").unwrap();
		assert_ne!(
			uuid_steve_1234, uuid_steve_5678,
			"Same username + different PIN must yield different UUID"
		);

		let uuid_alex_1234 = derive_offline_uuid("Alex", "1234").unwrap();
		assert_ne!(
			uuid_steve_1234, uuid_alex_1234,
			"Different username + same PIN must yield different UUID"
		);

		// Case normalization
		let uuid_steve_lower = derive_offline_uuid("steve", "1234").unwrap();
		assert_eq!(
			uuid_steve_1234, uuid_steve_lower,
			"Casing differences must produce identical UUIDs"
		);

		// Verify RFC 4122 Variant and Version
		let bytes = uuid_steve_1234.as_bytes();
		assert_eq!(bytes[6] >> 4, 4, "Must be UUID version 4");
		assert_eq!(bytes[8] >> 6, 2, "Must be RFC 4122 variant (10xx_xxxx)");

		// Lock in fixed test vectors
		assert_eq!(
			uuid_steve_1234.to_string(),
			"e199b16b-7efd-4584-a964-04038430f6cf"
		);
		assert_eq!(
			uuid_steve_5678.to_string(),
			"dbb6aacc-f85b-478e-8219-147c5d195790"
		);
		assert_eq!(
			uuid_alex_1234.to_string(),
			"4faf5a1e-ab98-473c-81c9-e452cf027e50"
		);
	}

	#[test]
	fn test_validation() {
		assert!(derive_offline_uuid("", "1234").is_err());
		assert!(derive_offline_uuid("Steve", "").is_err());
		assert!(derive_offline_uuid("Invalid Name!", "1234").is_err());
	}
}
