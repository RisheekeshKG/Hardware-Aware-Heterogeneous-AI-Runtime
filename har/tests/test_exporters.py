import json

from har.runtime.benchmark import run_matmul
from har.runtime.exporters import write_csv, write_json


def test_json_and_csv_exports(tmp_path):
    result = run_matmul(size=4, backend="cpu", warmup_iterations=0, measured_iterations=1)
    json_path = write_json(result, tmp_path / "result.json")
    csv_path = write_csv(result, tmp_path / "result.csv")
    assert json.loads(json_path.read_text())["backend"] == "cpu"
    assert "latency_median_seconds" in csv_path.read_text()
