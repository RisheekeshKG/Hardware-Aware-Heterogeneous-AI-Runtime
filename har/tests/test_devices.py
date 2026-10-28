from har.runtime.devices import BACKENDS, discover_devices


def test_discovery_returns_every_supported_backend():
    devices = discover_devices()
    assert [device.backend for device in devices] == list(BACKENDS)
    assert devices[0].available is True
    assert all(device.torch_version for device in devices)


def test_unavailable_backend_has_reason_or_is_available():
    for device in discover_devices():
        if not device.available:
            assert device.unavailable_reason
