#!/usr/bin/env python3
"""Run a command with external networking confined to the two ModBridge services.

Uses a Linux user/network namespace with only loopback. A Unix socket bridge
forwards approved CONNECT requests through the inherited platform HTTP proxy.
Package-manager presets on the outer environment cannot be reached by the child.
Usage: python3 scripts/relay-only.py -- COMMAND [ARGS...]
"""

import argparse
import os
import select
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
from urllib.parse import urlsplit


RELAY_HOSTS = {
	"br-divine-snow-ahjav8i1-relay.compute.c-3.us-east-1.aws.neon.tech",
	"br-divine-snow-ahjav8i1-updates.compute.c-3.us-east-1.aws.neon.tech",
}


def copy_streams(left, right):
	while True:
		readable, _, _ = select.select([left, right], [], [], 60)
		if not readable:
			continue
		for source in readable:
			data = source.recv(65536)
			if not data:
				return
			(right if source is left else left).sendall(data)


def read_headers(connection):
	data = b""
	while b"\r\n\r\n" not in data:
		chunk = connection.recv(4096)
		if not chunk or len(data) + len(chunk) > 65536:
			raise ValueError("Invalid proxy headers")
		data += chunk
	return data


class ThreadedUnixServer(socketserver.ThreadingUnixStreamServer):
	daemon_threads = True


class ThreadedTCPServer(socketserver.ThreadingTCPServer):
	daemon_threads = True


class Gate(socketserver.BaseRequestHandler):
	def handle(self):
		try:
			self.request.settimeout(30)
			headers = read_headers(self.request)
			method, authority, _version = headers.split(b"\r\n", 1)[0].decode("ascii").split()
			target = urlsplit("https://" + authority)
			if (method != "CONNECT" or target.hostname not in RELAY_HOSTS
				or target.port != 443 or target.username or target.password
				or target.path or target.query or target.fragment):
				print(f"Relay-only proxy blocked: {target.hostname or 'invalid destination'}", file=sys.stderr, flush=True)
				self.request.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
				return
			print(f"Relay-only proxy permitted: {target.hostname}", file=sys.stderr, flush=True)
			with socket.create_connection(self.server.upstream, timeout=30) as upstream:
				upstream.sendall(f"CONNECT {target.hostname}:443 HTTP/1.1\r\nHost: {target.hostname}:443\r\n\r\n".encode("ascii"))
				self.request.settimeout(None)
				upstream.settimeout(None)
				copy_streams(self.request, upstream)
		except (OSError, ValueError, UnicodeError) as error:
			print(f"Relay-only proxy error: {type(error).__name__}", file=sys.stderr, flush=True)


class Bridge(socketserver.BaseRequestHandler):
	def handle(self):
		try:
			with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as outer:
				outer.connect(self.server.socket_path)
				copy_streams(self.request, outer)
		except OSError:
			return


def inner(socket_path, command):
	subprocess.run(["ip", "link", "set", "lo", "up"], check=True)
	interfaces = {name for _, name in socket.if_nameindex()}
	if interfaces != {"lo"}:
		raise RuntimeError(f"Network isolation failed: {interfaces}")
	with ThreadedTCPServer(("127.0.0.1", 0), Bridge) as bridge:
		bridge.socket_path = socket_path
		threading.Thread(target=bridge.serve_forever, daemon=True).start()
		proxy = f"http://127.0.0.1:{bridge.server_address[1]}"
		env = os.environ.copy()
		for variable in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
			env[variable] = proxy
		for variable in ("NO_PROXY", "no_proxy"):
			env[variable] = "localhost,127.0.0.1,::1"
		print("Relay-only isolation active: loopback plus the two approved service hosts", file=sys.stderr, flush=True)
		try:
			return subprocess.call(command, env=env)
		finally:
			bridge.shutdown()


def main():
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("--inner", metavar="SOCKET")
	parser.add_argument("command", nargs=argparse.REMAINDER)
	args = parser.parse_args()
	command = args.command[1:] if args.command[:1] == ["--"] else args.command
	if not command:
		parser.error("A command is required after --")
	if args.inner:
		return inner(args.inner, command)
	proxy = urlsplit(os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY") or "")
	if proxy.scheme != "http" or not proxy.hostname or proxy.username or proxy.password:
		parser.error("An inherited HTTP platform proxy without URL credentials is required")
	with tempfile.TemporaryDirectory(prefix="modbridge-relay-only-") as directory:
		socket_path = os.path.join(directory, "proxy.sock")
		with ThreadedUnixServer(socket_path, Gate) as gate:
			gate.upstream = (proxy.hostname, proxy.port or 80)
			threading.Thread(target=gate.serve_forever, daemon=True).start()
			try:
				return subprocess.call([
					"unshare", "--user", "--map-root-user", "--net", "--fork",
					sys.executable, os.path.abspath(__file__), "--inner", socket_path,
					"--", *command,
				])
			finally:
				gate.shutdown()


if __name__ == "__main__":
	sys.exit(main())
