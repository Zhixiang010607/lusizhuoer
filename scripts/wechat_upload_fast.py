#!/usr/bin/env python3
"""Run WeChat DevTools uploads through the fastest reachable Tencent COS route.

The IDE's upload backend uses cos-nodejs-sdk-v5. That SDK bypasses the visible
IDE proxy setting but honors HTTPS_PROXY. This launcher starts a local TCP
forward proxy, probes the current COS IPv4 routes, and restarts the IDE with
the proxy environment inherited by the Node upload backend.

TLS remains end-to-end between WeChat DevTools and Tencent COS. The local
proxy cannot decrypt or modify the uploaded package.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import pathlib
import select
import signal
import socket
import socketserver
import ssl
import subprocess
import sys
import threading
import time
from dataclasses import asdict, dataclass


DEFAULT_HOST = "mmbizwxadevlogiccos-1258344707.cos.ap-shanghai.myqcloud.com"
DEFAULT_ROUTE_HINTS = {DEFAULT_HOST: "117.68.20.85"}
DEFAULT_PROJECT = pathlib.Path(__file__).resolve().parents[1] / "miniprogram-app"
DEVTOOLS_CLI = pathlib.Path("/Applications/wechatwebdevtools.app/Contents/MacOS/cli")
DEVTOOLS_PROCESS_PATTERN = "/Applications/wechatwebdevtools.app/Contents/MacOS/Electron"
COS_SUFFIXES = (".cos.ap-shanghai.myqcloud.com", ".cos.ap-shanghai.myqcloud.com.cn")
PROBE_TIMEOUT_SECONDS = 3.0
PROXY_HOST = "127.0.0.1"
PROXY_PORT = 18989
PROXY_PID_FILE = pathlib.Path("/tmp/lusizhuoer-wechat-upload-proxy.pid")
PROXY_READY_TIMEOUT_SECONDS = 12
HEADER_LIMIT = 64 * 1024
ROUTE_CACHE_SECONDS = 60


@dataclass(frozen=True)
class ProbeResult:
    ip: str
    reachable: bool
    tls_ms: int | None
    error: str | None


def is_cos_host(host: str) -> bool:
    normalized = host.rstrip(".").lower()
    return any(normalized.endswith(suffix) for suffix in COS_SUFFIXES)


def resolve_ipv4(host: str) -> list[str]:
    addresses: list[str] = []
    for item in socket.getaddrinfo(host, 443, socket.AF_INET, socket.SOCK_STREAM):
        address = item[4][0]
        if address not in addresses:
            addresses.append(address)
    return addresses


def probe_tls(host: str, ip: str) -> ProbeResult:
    started = time.monotonic()
    try:
        with socket.create_connection((ip, 443), timeout=PROBE_TIMEOUT_SECONDS) as raw:
            raw.settimeout(PROBE_TIMEOUT_SECONDS)
            context = ssl.create_default_context()
            with context.wrap_socket(raw, server_hostname=host):
                pass
        return ProbeResult(ip, True, round((time.monotonic() - started) * 1000), None)
    except (OSError, ssl.SSLError) as error:
        message = error.__class__.__name__
        if str(error):
            message = f"{message}: {str(error)[:120]}"
        return ProbeResult(ip, False, None, message)


def probe_routes(host: str) -> list[ProbeResult]:
    addresses = resolve_ipv4(host)
    if not addresses:
        return []
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(addresses)) as pool:
        futures = [pool.submit(probe_tls, host, address) for address in addresses]
        return [future.result() for future in futures]


def choose_route(host: str, preferred_ip: str | None = None) -> tuple[str, list[ProbeResult]]:
    results = probe_routes(host)
    healthy = [result for result in results if result.reachable and result.tls_ms is not None]
    if not healthy:
        raise RuntimeError(f"No reachable Tencent COS route for {host}")
    if preferred_ip:
        selected = next((result for result in healthy if result.ip == preferred_ip), None)
        if selected is None:
            raise RuntimeError(f"Preferred COS route is unavailable: {preferred_ip}")
        return selected.ip, results
    route_hint = DEFAULT_ROUTE_HINTS.get(host.rstrip(".").lower())
    hinted = next((result for result in healthy if result.ip == route_hint), None)
    if hinted is not None:
        return hinted.ip, results
    fastest = min(healthy, key=lambda result: result.tls_ms or 10**9)
    return fastest.ip, results


def print_results(host: str, selected: str | None, results: list[ProbeResult]) -> None:
    payload = {
        "host": host,
        "selected": selected,
        "routes": [asdict(result) for result in results],
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2), flush=True)


class RouteSelector:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cache: dict[str, tuple[float, str]] = {}

    def selected_ip(self, host: str) -> str:
        normalized = host.rstrip(".").lower()
        now = time.monotonic()
        with self._lock:
            cached = self._cache.get(normalized)
            if cached and now - cached[0] < ROUTE_CACHE_SECONDS:
                return cached[1]
        selected, _ = choose_route(normalized)
        with self._lock:
            self._cache[normalized] = (now, selected)
        return selected

    def connect(self, host: str, port: int, timeout: float = 10.0) -> socket.socket:
        target = self.selected_ip(host) if is_cos_host(host) and port == 443 else host
        return socket.create_connection((target, port), timeout=timeout)


ROUTES = RouteSelector()


def relay(left: socket.socket, right: socket.socket) -> None:
    sockets = [left, right]
    while sockets:
        readable, _, exceptional = select.select(sockets, [], sockets, 60)
        if exceptional or not readable:
            return
        for source in readable:
            destination = right if source is left else left
            data = source.recv(64 * 1024)
            if not data:
                return
            destination.sendall(data)


class ProxyHandler(socketserver.StreamRequestHandler):
    timeout = 30

    def read_request_head(self) -> bytes:
        data = bytearray()
        while b"\r\n\r\n" not in data:
            chunk = self.connection.recv(4096)
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > HEADER_LIMIT:
                raise ValueError("Proxy request header is too large")
        return bytes(data)

    def handle(self) -> None:
        try:
            request = self.read_request_head()
            if not request:
                return
            first_line = request.partition(b"\r\n")[0]
            parts = first_line.decode("iso-8859-1").split(" ", 2)
            if len(parts) != 3 or parts[0].upper() != "CONNECT":
                raise ValueError("Only HTTPS CONNECT is supported")
            self.handle_connect(parts[1])
        except (OSError, ValueError):
            try:
                self.connection.sendall(
                    b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
                )
            except OSError:
                pass

    def handle_connect(self, target: str) -> None:
        host, separator, port_text = target.rpartition(":")
        if not separator or not host:
            raise ValueError("CONNECT target must include host and port")
        upstream = ROUTES.connect(host, int(port_text))
        try:
            self.connection.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            relay(self.connection, upstream)
        finally:
            upstream.close()


class ThreadingProxyServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def serve_proxy(probe_host: str, preferred_ip: str | None = None) -> int:
    selected, results = choose_route(probe_host, preferred_ip)
    with ROUTES._lock:
        cache_time = float("inf") if preferred_ip else time.monotonic()
        ROUTES._cache[probe_host.rstrip(".").lower()] = (cache_time, selected)
    print_results(probe_host, selected, results)
    with ThreadingProxyServer((PROXY_HOST, PROXY_PORT), ProxyHandler) as server:
        server.serve_forever()
    return 0


def process_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False


def read_proxy_pid() -> int | None:
    try:
        return int(PROXY_PID_FILE.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None


def stop_proxy() -> None:
    pid = read_proxy_pid()
    if not pid or not process_exists(pid):
        return
    try:
        command = subprocess.check_output(
            ["ps", "-p", str(pid), "-o", "command="], text=True
        ).strip()
    except subprocess.CalledProcessError:
        return
    if pathlib.Path(__file__).name not in command or "proxy-server" not in command:
        raise RuntimeError(f"Refusing to stop unrelated process {pid}")
    os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + 5
    while process_exists(pid) and time.monotonic() < deadline:
        time.sleep(0.1)


def wait_for_proxy() -> None:
    deadline = time.monotonic() + PROXY_READY_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((PROXY_HOST, PROXY_PORT), timeout=0.5):
                return
        except OSError:
            time.sleep(0.2)
    raise RuntimeError("Local upload proxy did not become ready")


def start_proxy(probe_host: str, preferred_ip: str | None = None) -> None:
    stop_proxy()
    command = [sys.executable, str(pathlib.Path(__file__).resolve()), "--host", probe_host]
    if preferred_ip:
        command.extend(["--ip", preferred_ip])
    command.append("proxy-server")
    process = subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    PROXY_PID_FILE.write_text(str(process.pid), encoding="utf-8")
    wait_for_proxy()


def run_cli(arguments: list[str], env: dict[str, str] | None = None) -> int:
    completed = subprocess.run([str(DEVTOOLS_CLI), *arguments], env=env, check=False)
    return completed.returncode


def devtools_running() -> bool:
    completed = subprocess.run(
        ["pgrep", "-f", DEVTOOLS_PROCESS_PATTERN],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return completed.returncode == 0


def restart_devtools(
    project: pathlib.Path, probe_host: str, preferred_ip: str | None = None
) -> None:
    start_proxy(probe_host, preferred_ip)
    if devtools_running():
        run_cli(["quit", "--lang", "zh"])
        deadline = time.monotonic() + 20
        while devtools_running() and time.monotonic() < deadline:
            time.sleep(0.25)
        if devtools_running():
            raise RuntimeError("WeChat DevTools did not quit within 20 seconds")

    proxy_url = f"http://{PROXY_HOST}:{PROXY_PORT}"
    env = os.environ.copy()
    env["HTTPS_PROXY"] = proxy_url
    env["https_proxy"] = proxy_url
    env["NO_PROXY"] = "127.0.0.1,localhost,::1"
    env["no_proxy"] = env["NO_PROXY"]
    open_code = run_cli(["open", "--project", str(project), "--lang", "zh"], env=env)
    if open_code != 0:
        raise RuntimeError(f"WeChat DevTools open failed with exit code {open_code}")


def validate_project(project: pathlib.Path) -> pathlib.Path:
    resolved = project.resolve()
    if not (resolved / "project.config.json").is_file():
        raise ValueError(f"Invalid mini-program project: {resolved}")
    return resolved


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--ip", help="Force one currently reachable COS IPv4 route")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("check", help="Probe routes without changing the IDE")
    subparsers.add_parser("proxy-server", help=argparse.SUPPRESS)

    open_parser = subparsers.add_parser("open", help="Restart the IDE with fast COS routing")
    open_parser.add_argument("--project", type=pathlib.Path, default=DEFAULT_PROJECT)

    preview_parser = subparsers.add_parser("preview", help="Restart the IDE and create a preview")
    preview_parser.add_argument("--project", type=pathlib.Path, default=DEFAULT_PROJECT)

    upload_parser = subparsers.add_parser("upload", help="Restart the IDE and upload a development version")
    upload_parser.add_argument("--project", type=pathlib.Path, default=DEFAULT_PROJECT)
    upload_parser.add_argument("--version", required=True)
    upload_parser.add_argument("--desc", required=True)

    args = parser.parse_args()
    if args.command == "proxy-server":
        return serve_proxy(args.host, args.ip)

    try:
        selected, results = choose_route(args.host, args.ip)
        print_results(args.host, selected, results)
        if args.command == "check":
            return 0
        project = validate_project(args.project)
        restart_devtools(project, args.host, args.ip)
    except (OSError, RuntimeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 1

    if args.command == "open":
        print("WeChat DevTools restarted with HTTPS_PROXY routing")
        return 0
    if args.command == "preview":
        return run_cli(["preview", "--project", str(project), "--qr-format", "terminal", "--lang", "zh"])
    return run_cli(
        [
            "upload",
            "--project",
            str(project),
            "--version",
            args.version,
            "--desc",
            args.desc,
            "--lang",
            "zh",
        ]
    )


if __name__ == "__main__":
    raise SystemExit(main())
