#!/usr/bin/env python3
"""SafeSQL dbt integration — validate dbt SQL models before `dbt run`.

Scans models/**/*.sql, strips dbt Jinja, extracts a rough DDL from
sources.yml / schema.yml, calls the SafeSQL REST API for each model, and exits
non-zero if any model scores below the threshold. Thin wrapper around
POST /api/validate — no validator logic lives here.

Usage:
    safesql-dbt --project-dir . --dialect postgresql
    safesql-dbt --project-dir . --threshold 70
    safesql-dbt --project-dir . --warn-only
    safesql-dbt --project-dir . --target-dir target   # send manifest/catalog/run_results
    SAFESQL_API_KEY=ssk_live_xxx safesql-dbt --project-dir .

dbt artifacts (Sprint 8): when <target-dir>/manifest.json exists, the
artifacts are sent in the request's `dbt` field and the schema.yml DDL path
is skipped — catalog.json is strictly better (complete columns, real types,
PK/FK from the project's own tests). Without a manifest, behaviour is
unchanged.
"""
import argparse
import glob
import json
import os
import re
import sys

try:
    import requests
except ImportError:  # pragma: no cover
    print("SafeSQL: `pip install requests` is required.", file=sys.stderr)
    sys.exit(2)

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None

API_URL = os.environ.get("SAFESQL_API_URL", "https://safesqlpro.dev/api/validate")

# Mirrors the SafeSQL score policy: <41 hard error, 41-69 high-risk semantic
# warning, 70-84 medium, 85+ suggestion only. The default threshold therefore
# fails the build on errors and high-risk warnings, and stays quiet above that.
DEFAULT_THRESHOLD = 70


_QUOTED = re.compile(r"""['"]([^'"]+)['"]""")


def _last_identifier(args: str, fallback: str) -> str:
    """ref('users') -> users; ref('pkg', 'users') -> users;
    source('sch', 'tbl') -> tbl. dbt's relation name is always the last arg."""
    found = _QUOTED.findall(args)
    return found[-1] if found else fallback


def strip_dbt_jinja(sql: str) -> str:
    """Rewrite dbt Jinja into plain SQL that node-sql-parser can parse.

    ref()/source() become the bare relation identifier, so table and column
    resolution still works against the DDL built from schema.yml. Rendering
    them as a string literal instead would make every model report a
    hallucinated table — a false positive on every ref() in the project.
    """
    # config() is a directive, not a value — drop it rather than leave an identifier.
    sql = re.sub(r"\{\{\s*config\s*\([^}]*?\)\s*\}\}", "", sql)
    sql = re.sub(
        r"\{\{\s*ref\s*\(([^)]*)\)\s*\}\}",
        lambda m: _last_identifier(m.group(1), "__dbt_ref__"),
        sql,
    )
    sql = re.sub(
        r"\{\{\s*source\s*\(([^)]*)\)\s*\}\}",
        lambda m: _last_identifier(m.group(1), "__dbt_source__"),
        sql,
    )
    # Anything else ({{ var(...) }}, {{ this }}, macros) sits in expression
    # position — a string literal keeps the statement parseable.
    sql = re.sub(r"\{\{[^}]+\}\}", "'__dbt_expr__'", sql)
    sql = re.sub(r"\{%[^%]+%\}", "", sql)
    return sql


def extract_schema_from_dbt(project_dir: str) -> str:
    """Parse schema.yml / sources.yml column definitions into a best-effort DDL
    string. Returns '' if pyyaml is unavailable or no columns are found."""
    if yaml is None:
        return ""
    tables: dict[str, list[str]] = {}
    for yml in glob.glob(f"{project_dir}/models/**/*.yml", recursive=True):
        try:
            with open(yml, "r", encoding="utf-8") as fh:
                doc = yaml.safe_load(fh) or {}
        except Exception:
            continue
        # models: [{name, columns: [{name, data_type}]}]; sources: [{tables: [...]}]
        groups = list(doc.get("models", []))
        for src in doc.get("sources", []) or []:
            groups.extend(src.get("tables", []) or [])
        for model in groups:
            name = model.get("name")
            cols = model.get("columns") or []
            if not name or not cols:
                continue
            defs = []
            for c in cols:
                cname = c.get("name")
                if not cname:
                    continue
                dtype = c.get("data_type") or "TEXT"
                defs.append(f"{cname} {dtype}")
            if defs:
                tables[name] = defs
    return "\n".join(f"CREATE TABLE {t} ({', '.join(cols)});" for t, cols in tables.items())


# ── dbt artifacts (Sprint 8) ────────────────────────────────────────────────

ARTIFACT_FILES = (("manifest", "manifest.json"), ("catalog", "catalog.json"), ("runResults", "run_results.json"))


def load_dbt_artifacts(target_dir: str):
    """Read manifest.json (required), catalog.json and run_results.json
    (optional) from a dbt target/ directory. Returns a dict shaped for the
    API's `dbt` field, or None when there is no manifest.json — the caller then
    falls back to the schema.yml DDL path."""
    if not target_dir:
        return None
    out = {}
    for key, name in ARTIFACT_FILES:
        path = os.path.join(target_dir, name)
        if not os.path.isfile(path):
            continue
        try:
            with open(path, "r", encoding="utf-8") as fh:
                out[key] = json.load(fh)
        except (OSError, ValueError) as exc:
            print(f"SafeSQL: cannot read {path}: {exc}", file=sys.stderr)
    if "manifest" not in out:
        return None
    if not isinstance(out["manifest"].get("nodes"), dict):
        print(f"SafeSQL: {os.path.join(target_dir, 'manifest.json')} is not a dbt manifest (no `nodes` map)", file=sys.stderr)
        return None
    return out


def model_name_from_path(path: str) -> str:
    """dbt's model-name rule: the file's basename without its extension."""
    return os.path.splitext(os.path.basename(path))[0]


def build_request(sql: str, dialect: str, schema_ddl: str, artifacts, current_model: str = "") -> dict:
    """The POST /api/validate body. With artifacts, `ddl` is omitted and the
    `dbt` field carries manifest/catalog/run_results plus the current model
    name (so a staging model may read its own raw source). Without, the
    pre-Sprint-8 body is sent unchanged."""
    if artifacts:
        dbt = dict(artifacts)
        if current_model:
            dbt["currentModel"] = current_model
        return {"sql": sql, "dialect": dialect, "dbt": dbt}
    return {"sql": sql, "ddl": schema_ddl, "dialect": dialect}


def artifacts_banner(target_dir: str, artifacts) -> str:
    if artifacts:
        found = [name for key, name in ARTIFACT_FILES if key in artifacts]
        return f"SafeSQL: dbt artifacts loaded from {target_dir} ({', '.join(found)})"
    return f"SafeSQL: no manifest.json in {target_dir} - using schema.yml"


def sensitive_tag_note(issue: dict):
    """The CLI line printed under a FINANCE_TAG_UNVALIDATED finding. The tag
    comes from the finding itself, so a `pii` relation says pii."""
    if issue.get("issueType", issue.get("id")) != "FINANCE_TAG_UNVALIDATED":
        return None
    tag = (issue.get("metadata") or {}).get("tag") or "finance"
    return f"This query touches a model tagged {tag} - validation required before export"


def score_of(report: dict) -> int:
    """riskScore from POST /api/validate. A report with no score (API_ERROR,
    malformed response) is treated as 0 so it can never pass the threshold."""
    raw = report.get("riskScore")
    return raw if isinstance(raw, int) else 0


def is_failing(report: dict, threshold: int) -> bool:
    """A model fails if the engine returned hard errors, or if its score falls
    below the threshold. Models at or above the threshold are not reported."""
    return bool(report.get("errors")) or score_of(report) < threshold


def validate_dbt_project(
    project_dir: str,
    api_key: str,
    dialect: str = "postgresql",
    threshold: int = DEFAULT_THRESHOLD,
    warn_only: bool = False,
    target_dir: str = "",
) -> int:
    sql_files = sorted(glob.glob(f"{project_dir}/models/**/*.sql", recursive=True))

    # Sprint 8: artifacts replace the schema.yml DDL when a manifest exists.
    target_dir = target_dir or os.path.join(project_dir, "target")
    artifacts = load_dbt_artifacts(target_dir)
    print(artifacts_banner(target_dir, artifacts))
    schema_ddl = "" if artifacts else extract_schema_from_dbt(project_dir)

    results = []
    for sql_file in sql_files:
        sql_file = os.path.normpath(sql_file)
        with open(sql_file, "r", encoding="utf-8") as fh:
            clean_sql = strip_dbt_jinja(fh.read())
        try:
            resp = requests.post(
                API_URL,
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json=build_request(clean_sql, dialect, schema_ddl, artifacts, model_name_from_path(sql_file)),
                timeout=30,
            )
            report = resp.json()
        except Exception as exc:  # network / parse failure — surface, don't crash all
            report = {"errors": [{"issueType": "API_ERROR", "message": str(exc)}], "warnings": []}
        results.append({"file": sql_file, "report": report})

    failing = [r for r in results if is_failing(r["report"], threshold)]

    # ASCII only: these lines land in Windows consoles and CI logs that are not
    # reliably UTF-8, and a mojibaked dash in a failure message reads as a bug.
    print(
        f"SafeSQL: {len(sql_files)} models checked, {len(failing)} failing "
        f"(threshold {threshold})"
    )
    for r in failing:
        report = r["report"]
        issues = list(report.get("errors") or []) + list(report.get("warnings") or [])
        reason = "hard error" if report.get("errors") else f"score below {threshold}"
        print(
            f"  X {r['file']} (score: {score_of(report)}, {reason}) - {len(issues)} issue(s)"
        )
        for i in issues:
            label = i.get("issueType", i.get("id", "ISSUE"))
            print(f"     {label}: {i.get('message', i.get('description', ''))}")
            fix = i.get("fix")
            if fix:
                print(f"       Fix: {fix}")
            note = sensitive_tag_note(i)
            if note:
                print(f"       {note}")
    for r in results:
        if r not in failing:
            print(f"  OK {r['file']} (score: {score_of(r['report'])})")

    if not failing:
        return 0
    if warn_only:
        print("SafeSQL: --warn-only set, not failing the build.")
        return 0
    print("SafeSQL: fix the issues above, or re-run with --warn-only to proceed.")
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate dbt SQL models with SafeSQL")
    parser.add_argument("--project-dir", default=".")
    parser.add_argument("--profiles-dir", default=os.path.expanduser("~/.dbt"))
    parser.add_argument("--dialect", default="postgresql")
    parser.add_argument("--api-key", default=os.environ.get("SAFESQL_API_KEY", ""))
    parser.add_argument(
        "--target-dir",
        default=os.environ.get("SAFESQL_DBT_TARGET", ""),
        help="dbt target/ directory with manifest.json (default: <project-dir>/target); "
        "when found, manifest/catalog/run_results are sent instead of the schema.yml DDL",
    )
    parser.add_argument(
        "--threshold",
        type=int,
        default=int(os.environ.get("SAFESQL_THRESHOLD", DEFAULT_THRESHOLD)),
        help=f"fail models scoring below this (0-100, default {DEFAULT_THRESHOLD}); "
        "models at or above it are not reported",
    )
    parser.add_argument(
        "--warn-only",
        action="store_true",
        default=os.environ.get("SAFESQL_WARN_ONLY", "").lower() in ("1", "true", "yes"),
        help="print findings but always exit 0 (does not block dbt run / commit)",
    )
    # Accept SQL paths from pre-commit without choking; discovery is project-wide.
    parser.add_argument("files", nargs="*", help=argparse.SUPPRESS)
    args = parser.parse_args()

    if not args.api_key:
        print("SafeSQL: set --api-key or SAFESQL_API_KEY env var.", file=sys.stderr)
        return 2

    return validate_dbt_project(
        args.project_dir, args.api_key, args.dialect, args.threshold, args.warn_only, args.target_dir
    )


if __name__ == "__main__":
    sys.exit(main())
