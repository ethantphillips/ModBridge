#!/usr/bin/env python3
"""Prepare a cached Java client for the isolated desktop launch smoke test.

The synthetic client verifies the real launch arguments and RPC-injected
instance properties, emits stdout and stderr, then stays alive until stopped.
No Minecraft files or Java runtimes are downloaded.
"""

import argparse
import hashlib
import json
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import time
from pathlib import Path


FIXTURE_VERSION = 'modbridge-smoke-fixture'
FIXTURE_CLASS = 'com.modbridge.fixture.LaunchSmoke'
FIXTURE_NAME = 'ModBridge launch smoke fixture'
FIXTURE_SOURCE = r'''
package com.modbridge.fixture;

public final class LaunchSmoke {
	private static String argument(String[] args, String name) {
		for (int index = 0; index + 1 < args.length; index++) {
			if (args[index].equals(name)) return args[index + 1];
		}
		throw new IllegalArgumentException("Missing " + name);
	}

	private static void require(boolean condition, String message) {
		if (!condition) throw new IllegalStateException(message);
	}

	public static void main(String[] args) throws InterruptedException {
		require(argument(args, "--username").equals(System.getProperty("modbridge.fixture.username")), "Username mismatch");
		require(argument(args, "--uuid").equals(System.getProperty("modbridge.fixture.uuid")), "UUID mismatch");
		require(argument(args, "--accessToken").equals("0"), "Offline token mismatch");
		require(argument(args, "--userType").equals("legacy"), "Offline user type mismatch");
		require(argument(args, "--version").equals("modbridge-smoke-fixture"), "Version mismatch");
		require(System.getProperty("modrinth.profile.name").equals("ModBridge launch smoke fixture"), "Instance RPC property mismatch");
		require(System.getProperty("modrinth.process.startTime") != null, "Process RPC property missing");
		System.out.println("MODBRIDGE_FIXTURE_IDENTITY_OK");
		System.out.println("MODBRIDGE_FIXTURE_RPC_OK");
		System.err.println("MODBRIDGE_FIXTURE_STDERR_OK");
		System.out.flush();
		System.err.flush();
		for (;;) Thread.sleep(1000);
	}
}
'''


def require_isolated_network():
	if {name for _, name in socket.if_nameindex()} != {'lo'}:
		raise RuntimeError('Run launcher fixtures inside the Relay-only or loopback-only namespace')


def prepare_runtime_fixture(data_dir, java_path=None):
	require_isolated_network()
	data_dir = Path(data_dir)
	java_path = Path(java_path or shutil.which('java') or '')
	if not java_path.is_file():
		raise RuntimeError('Activate the cached JDK before preparing the launcher fixture')
	java_path = java_path.resolve()
	compiler = java_path.parent / 'javac'
	if not compiler.is_file():
		raise RuntimeError('The launcher fixture requires a cached JDK with javac')
	version_dir = data_dir / 'meta' / 'versions' / FIXTURE_VERSION
	version_dir.mkdir(parents=True, exist_ok=True)
	client_path = version_dir / f'{FIXTURE_VERSION}.jar'
	with tempfile.TemporaryDirectory(prefix='modbridge-launcher-java-') as temporary:
		compile_dir = Path(temporary)
		source = compile_dir / 'LaunchSmoke.java'
		source.write_text(FIXTURE_SOURCE)
		classes = compile_dir / 'classes'
		classes.mkdir()
		subprocess.run([str(compiler), '--release', '17', '-d', str(classes), str(source)], check=True, timeout=30)
		subprocess.run([str(java_path.parent / 'jar'), '--create', '--file', str(client_path), '-C', str(classes), '.'], check=True, timeout=30)
	assets = b'{"objects":{}}'
	asset_path = data_dir / 'meta' / 'assets' / 'indexes' / f'{FIXTURE_VERSION}.json'
	asset_path.parent.mkdir(parents=True, exist_ok=True)
	asset_path.write_bytes(assets)
	timestamp = '2013-01-01T00:00:00Z'
	url = 'https://launcher.mojang.com/modbridge-fixture-not-downloaded'
	version_info = {
		'arguments': {
			'jvm': ['-cp', '${classpath}'],
			'game': ['--username', '${auth_player_name}', '--uuid', '${auth_uuid}', '--accessToken', '${auth_access_token}', '--userType', '${user_type}', '--version', '${version_name}'],
		},
		'assetIndex': {'id': FIXTURE_VERSION, 'sha1': hashlib.sha1(assets).hexdigest(), 'size': len(assets), 'totalSize': 0, 'url': url},
		'assets': FIXTURE_VERSION,
		'downloads': {'client': {'sha1': hashlib.sha1(client_path.read_bytes()).hexdigest(), 'size': client_path.stat().st_size, 'url': url}},
		'id': FIXTURE_VERSION,
		'javaVersion': {'component': 'jre-legacy', 'majorVersion': 17},
		'libraries': [],
		'mainClass': FIXTURE_CLASS,
		'minimumLauncherVersion': 0,
		'releaseTime': timestamp,
		'time': timestamp,
		'type': 'release',
	}
	version_bytes = json.dumps(version_info).encode()
	(version_dir / f'{FIXTURE_VERSION}.json').write_bytes(version_bytes)
	def manifest_version(version):
		return {'id': version, 'type': 'release', 'url': url, 'time': timestamp, 'releaseTime': timestamp, 'sha1': hashlib.sha1(version_bytes).hexdigest(), 'complianceLevel': 0}
	manifest = {
		'latest': {'release': FIXTURE_VERSION, 'snapshot': FIXTURE_VERSION},
		'versions': [manifest_version(version) for version in ['22w16a', '13w39a', FIXTURE_VERSION]],
	}
	return {'game_version': FIXTURE_VERSION, 'instance_name': FIXTURE_NAME, 'java_path': str(java_path), 'manifest': manifest}


def seed_runtime_cache(data_dir, fixture):
	require_isolated_network()
	database = Path(data_dir) / 'app.db'
	if not database.is_file():
		raise RuntimeError('Initialize desktop app state before seeding the launcher cache')
	with sqlite3.connect(database, timeout=15) as connection:
		connection.execute(
			'INSERT INTO cache (id,data_type,alias,data,expires) VALUES (?,?,NULL,?,?) '
			'ON CONFLICT(id,data_type) DO UPDATE SET data=excluded.data,expires=excluded.expires',
			('0', 'minecraft_manifest', json.dumps(fixture['manifest']), int(time.time()) + 3600),
		)


def main():
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument('--data-dir', type=Path, required=True)
	parser.add_argument('--java', type=Path)
	parser.add_argument('--seed-cache', action='store_true')
	args = parser.parse_args()
	fixture = prepare_runtime_fixture(args.data_dir, args.java)
	if args.seed_cache:
		seed_runtime_cache(args.data_dir, fixture)
	print(json.dumps(fixture))


if __name__ == '__main__':
	main()
