"""Small LAN discovery layer for runtime workers."""

from __future__ import annotations

import json
import socket
import threading
import time
from typing import Any

import psutil

DISCOVERY_PORT = 9471
DISCOVERY_INTERVAL_SECONDS = 2.0


class DiscoveryBeacon:
    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = {"service": "har-runtime", "version": 1, **payload}
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, daemon=True, name="har-discovery-beacon")
        self._thread.start()

    def _run(self) -> None:
        message = json.dumps(self.payload).encode("utf-8")
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            while not self._stop.is_set():
                for target in _broadcast_targets():
                    try:
                        sock.sendto(message, (target, DISCOVERY_PORT))
                    except OSError:
                        pass
                self._stop.wait(DISCOVERY_INTERVAL_SECONDS)


def _broadcast_targets() -> set[str]:
    """Return global, loopback, and interface-specific IPv4 broadcasts."""

    targets = {"255.255.255.255", "127.0.0.1"}
    for addresses in psutil.net_if_addrs().values():
        for address in addresses:
            if address.family != socket.AF_INET or not address.address or not address.netmask:
                continue
            try:
                ip = int.from_bytes(socket.inet_aton(address.address), "big")
                mask = int.from_bytes(socket.inet_aton(address.netmask), "big")
                broadcast = ip | (~mask & 0xFFFFFFFF)
                targets.add(socket.inet_ntoa(broadcast.to_bytes(4, "big")))
            except OSError:
                continue
    return targets


class DiscoveryRegistry:
    def __init__(self, local_node_id: str | None = None) -> None:
        self.local_node_id = local_node_id
        self._nodes: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._thread = threading.Thread(target=self._listen, daemon=True, name="har-discovery-listener")
        self._thread.start()

    def _listen(self) -> None:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("0.0.0.0", DISCOVERY_PORT))
            except OSError:
                return
            sock.settimeout(1.0)
            while True:
                try:
                    raw, address = sock.recvfrom(65535)
                    payload = json.loads(raw.decode("utf-8"))
                    if payload.get("service") != "har-runtime" or payload.get("node_id") == self.local_node_id:
                        continue
                    payload["source_ip"] = address[0]
                    payload["last_seen_monotonic"] = time.monotonic()
                    with self._lock:
                        self._nodes[payload["node_id"]] = payload
                except (TimeoutError, socket.timeout):
                    self._expire()
                except (OSError, ValueError, UnicodeDecodeError, KeyError):
                    continue

    def _expire(self) -> None:
        threshold = time.monotonic() - 6.0
        with self._lock:
            self._nodes = {
                node_id: node
                for node_id, node in self._nodes.items()
                if node.get("last_seen_monotonic", 0) >= threshold
            }

    def list_nodes(self) -> list[dict[str, Any]]:
        self._expire()
        with self._lock:
            return [{key: value for key, value in node.items() if key != "last_seen_monotonic"} for node in self._nodes.values()]

    def get(self, node_id: str) -> dict[str, Any] | None:
        self._expire()
        with self._lock:
            return self._nodes.get(node_id)
