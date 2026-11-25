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


def test_device_info_survives_a_psutil_without_cpu_freq(monkeypatch):
    """Some psutil builds (the GitHub macOS runners') have no cpu_freq at all."""

    import psutil

    from har.runtime import devices

    monkeypatch.delattr(psutil, "cpu_freq", raising=False)
    assert devices.system_info()["cpu"]["frequency_mhz"] is None
    assert devices.get_device_info("cpu").available
