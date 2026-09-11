"""Sprint 8 Part 3 — tests 19-20: dbt artifacts flow through the Python
package. `requests.post` is mocked; no network. Run with:

    cd dbt-safesql && python -m pytest -q
"""
import json
import os
import shutil
import sys
from unittest import mock

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import validate_dbt  # noqa: E402
import validate_files  # noqa: E402

FIXTURE = os.path.join(HERE, "..", "src", "services", "__fixtures__", "dbt")


def _ok_report(**extra):
    base = {"riskScore": 100, "errors": [], "warnings": [], "suggestions": []}
    base.update(extra)
    return base


def _fake_post(calls, report=None):
    """A requests.post stand-in that records the JSON body and returns `report`."""

    def post(url, headers=None, json=None, timeout=None):
        calls.append(json)
        resp = mock.Mock()
        resp.json.return_value = report or _ok_report()
        return resp

    return post


@pytest.fixture
def project(tmp_path):
    """A dbt project with one model + schema.yml and a real target/ from the fixture."""
    models = tmp_path / "models"
    models.mkdir()
    (models / "stg_orders.sql").write_text(
        "SELECT id AS order_id, customer_id FROM {{ source('raw', 'orders') }}", encoding="utf-8"
    )
    (models / "schema.yml").write_text(
        "version: 2\nmodels:\n  - name: stg_orders\n    columns:\n      - name: order_id\n", encoding="utf-8"
    )
    return tmp_path


def _with_target(project):
    target = project / "target"
    target.mkdir()
    for name in ("manifest.json", "catalog.json", "run_results.json"):
        shutil.copy(os.path.join(FIXTURE, name), target / name)
    return target


# ── 19. --target-dir reads artifacts and skips the schema.yml path ───────────

def test_19_target_dir_sends_artifacts_and_omits_ddl(project, capsys):
    _with_target(project)
    calls = []
    with mock.patch.object(validate_dbt.requests, "post", _fake_post(calls)):
        rc = validate_dbt.validate_dbt_project(str(project), "ssk_live_x", "postgresql")
    assert rc == 0
    assert len(calls) == 1
    body = calls[0]
    # artifacts present, DDL path skipped
    assert "ddl" not in body
    assert set(body["dbt"]) == {"manifest", "catalog", "runResults", "currentModel"}
    assert body["dbt"]["manifest"]["metadata"]["dbt_version"] == "1.8.4"
    # dbt's model-name rule: the file stem
    assert body["dbt"]["currentModel"] == "stg_orders"
    # Jinja rendered to the bare source name, so the engine can resolve it
    assert body["sql"].strip() == "SELECT id AS order_id, customer_id FROM orders"
    out = capsys.readouterr().out
    assert "SafeSQL: dbt artifacts loaded from" in out
    assert "manifest.json, catalog.json, run_results.json" in out


def test_19b_explicit_target_dir_and_manifest_only(project, tmp_path, capsys):
    elsewhere = tmp_path / "artifacts"
    elsewhere.mkdir()
    shutil.copy(os.path.join(FIXTURE, "manifest.json"), elsewhere / "manifest.json")
    calls = []
    with mock.patch.object(validate_dbt.requests, "post", _fake_post(calls)):
        validate_dbt.validate_dbt_project(str(project), "k", target_dir=str(elsewhere))
    assert set(calls[0]["dbt"]) == {"manifest", "currentModel"}
    assert "(manifest.json)" in capsys.readouterr().out


# ── 20. falls back to schema.yml when there are no artifacts ─────────────────

def test_20_no_artifacts_falls_back_to_schema_yml(project, capsys):
    calls = []
    with mock.patch.object(validate_dbt.requests, "post", _fake_post(calls)):
        rc = validate_dbt.validate_dbt_project(str(project), "k")
    assert rc == 0
    body = calls[0]
    assert "dbt" not in body
    assert body["ddl"] == "CREATE TABLE stg_orders (order_id TEXT);"
    assert "SafeSQL: no manifest.json in" in capsys.readouterr().out


def test_20b_unreadable_manifest_falls_back(project, capsys):
    target = project / "target"
    target.mkdir()
    (target / "manifest.json").write_text('{"results": []}', encoding="utf-8")  # not a manifest
    calls = []
    with mock.patch.object(validate_dbt.requests, "post", _fake_post(calls)):
        validate_dbt.validate_dbt_project(str(project), "k")
    assert "dbt" not in calls[0]
    assert "ddl" in calls[0]
    assert "not a dbt manifest" in capsys.readouterr().err


# ── CLI output: the finance note under a FINANCE_TAG_UNVALIDATED finding ─────

def test_finance_note_printed_under_failing_finding(project, capsys):
    _with_target(project)
    report = _ok_report(
        riskScore=60,
        warnings=[{
            "id": "FINANCE_TAG_UNVALIDATED",
            "issueType": "FINANCE_TAG_UNVALIDATED",
            "message": "Query references 'fct_revenue' tagged 'finance'. Last validation status: error. Review required before export or scheduling.",
            "fix": "Re-run and validate",
            "metadata": {"tag": "finance", "lastRunStatus": "error"},
        }],
    )
    with mock.patch.object(validate_dbt.requests, "post", _fake_post([], report)):
        rc = validate_dbt.validate_dbt_project(str(project), "k", threshold=70)
    assert rc == 1
    out = capsys.readouterr().out
    assert "This query touches a model tagged finance - validation required before export" in out
    # the tag is taken from the finding, not hard-coded
    assert validate_dbt.sensitive_tag_note({"issueType": "FINANCE_TAG_UNVALIDATED", "metadata": {"tag": "pii"}}).endswith(
        "tagged pii - validation required before export"
    )
    assert validate_dbt.sensitive_tag_note({"issueType": "CARTESIAN_JOIN"}) is None


# ── validate_files.py: explicit --target-dir only, same request shape ────────

def test_validate_files_target_dir(project, tmp_path):
    target = _with_target(project)
    sql = tmp_path / "adhoc.sql"
    sql.write_text("SELECT id FROM orders", encoding="utf-8")
    calls = []
    with mock.patch.object(validate_files.requests, "post", _fake_post(calls)):
        validate_files.validate_files([str(sql)], "k", target_dir=str(target))
    assert calls[0]["dbt"]["currentModel"] == "adhoc"
    assert "ddl" not in calls[0]
    # without --target-dir there is no auto-discovery: schema_ddl path as before
    calls.clear()
    with mock.patch.object(validate_files.requests, "post", _fake_post(calls)):
        validate_files.validate_files([str(sql)], "k", schema_ddl="CREATE TABLE t (id INT);")
    assert calls[0] == {"sql": "SELECT id FROM orders", "ddl": "CREATE TABLE t (id INT);", "dialect": "postgresql"}
