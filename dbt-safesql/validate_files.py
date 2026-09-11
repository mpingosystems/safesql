#!/usr/bin/env python3
"""SafeSQL file-scoped validator — validates the exact .sql files it is given.

Companion to validate_dbt.py. That one walks a whole dbt project and is
dbt-aware (strips Jinja, builds DDL from schema.yml); this one validates the
specific paths handed to it, which is what pre-commit does. Same REST API, same
threshold semantics, no validator logic duplicated here.

Usage:
    safesql-sql models/revenue.sql reports/daily.sql
    safesql-sql --threshold 70 --dialect postgres *.sql
    SAFESQL_API_KEY=ssk_live_xxx safesql-sql --warn-only queries/*.sql
"""
import argparse
import os
import sys

try:
    import requests
except ImportError:  # pragma: no cover
    print("SafeSQL: `pip install requests` is required.", file=sys.stderr)
    sys.exit(2)

# Reuse the shared pieces rather than re-implementing them.
from validate_dbt import (
    API_URL,
    DEFAULT_THRESHOLD,
    artifacts_banner,
    build_request,
    is_failing,
    load_dbt_artifacts,
    model_name_from_path,
    score_of,
    sensitive_tag_note,
)

# The blueprint's documented pre-commit args use --dialect=postgres, but the
# engine's dialect ids are postgresql/mysql/bigquery/snowflake. Accept the
# common short forms so a copy-pasted config doesn't fail on a 400.
DIALECT_ALIASES = {
    "postgres": "postgresql",
    "pg": "postgresql",
    "psql": "postgresql",
    "postgresql": "postgresql",
    "mysql": "mysql",
    "bigquery": "bigquery",
    "bq": "bigquery",
    "snowflake": "snowflake",
}


def normalize_dialect(value: str) -> str:
    key = (value or "").strip().lower()
    if key not in DIALECT_ALIASES:
        valid = ", ".join(sorted(set(DIALECT_ALIASES.values())))
        raise argparse.ArgumentTypeError(f"unknown dialect '{value}' (expected one of: {valid})")
    return DIALECT_ALIASES[key]


def validate_files(
    paths: list,
    api_key: str,
    dialect: str = "postgresql",
    threshold: int = DEFAULT_THRESHOLD,
    warn_only: bool = False,
    schema_ddl: str = "",
    target_dir: str = "",
) -> int:
    # Sprint 8: explicit --target-dir only — no auto-discovery here, since
    # this entry point is not project-scoped.
    artifacts = load_dbt_artifacts(target_dir) if target_dir else None
    if target_dir:
        print(artifacts_banner(target_dir, artifacts))

    results = []
    for path in paths:
        path = os.path.normpath(path)
        try:
            with open(path, "r", encoding="utf-8") as fh:
                sql = fh.read()
        except OSError as exc:  # deleted/renamed between staging and run
            print(f"SafeSQL: skipping {path} ({exc.strerror})", file=sys.stderr)
            continue
        if not sql.strip():
            continue
        try:
            resp = requests.post(
                API_URL,
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json=build_request(sql, dialect, schema_ddl, artifacts, model_name_from_path(path)),
                timeout=30,
            )
            report = resp.json()
        except Exception as exc:  # network / parse failure — surface, don't crash all
            report = {"errors": [{"issueType": "API_ERROR", "message": str(exc)}], "warnings": []}
        results.append({"file": path, "report": report})

    if not results:
        print("SafeSQL: no SQL files to check.")
        return 0

    failing = [r for r in results if is_failing(r["report"], threshold)]

    # ASCII only: these lines land in Windows consoles and CI logs that are not
    # reliably UTF-8, and a mojibaked dash in a failure message reads as a bug.
    print(f"SafeSQL: {len(results)} file(s) checked, {len(failing)} failing (threshold {threshold})")
    for r in failing:
        report = r["report"]
        issues = list(report.get("errors") or []) + list(report.get("warnings") or [])
        reason = "hard error" if report.get("errors") else f"score below {threshold}"
        print(f"  X {r['file']} (score: {score_of(report)}, {reason}) - {len(issues)} issue(s)")
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
        print("SafeSQL: --warn-only set, not failing the commit.")
        return 0
    print("SafeSQL: fix the issues above, or re-run with --warn-only to proceed.")
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate specific SQL files with SafeSQL")
    parser.add_argument("files", nargs="*", help="SQL files to validate")
    parser.add_argument("--dialect", type=normalize_dialect, default="postgresql")
    parser.add_argument("--api-key", default=os.environ.get("SAFESQL_API_KEY", ""))
    parser.add_argument("--schema-file", default="", help="optional DDL file for column resolution")
    parser.add_argument(
        "--target-dir",
        default="",
        help="dbt target/ directory with manifest.json; sends the artifacts instead of --schema-file. "
        "For project-scoped validation use validate_dbt.py --target-dir instead.",
    )
    parser.add_argument(
        "--threshold",
        type=int,
        default=int(os.environ.get("SAFESQL_THRESHOLD", DEFAULT_THRESHOLD)),
        help=f"fail files scoring below this (0-100, default {DEFAULT_THRESHOLD})",
    )
    parser.add_argument(
        "--warn-only",
        action="store_true",
        default=os.environ.get("SAFESQL_WARN_ONLY", "").lower() in ("1", "true", "yes"),
        help="print findings but always exit 0 (does not block the commit)",
    )
    args = parser.parse_args()

    if not args.files:
        print("SafeSQL: no files given, nothing to check.")
        return 0
    if not args.api_key:
        print("SafeSQL: set --api-key or SAFESQL_API_KEY env var.", file=sys.stderr)
        return 2

    schema_ddl = ""
    if args.schema_file:
        try:
            with open(args.schema_file, "r", encoding="utf-8") as fh:
                schema_ddl = fh.read()
        except OSError as exc:
            print(f"SafeSQL: cannot read --schema-file: {exc}", file=sys.stderr)
            return 2

    return validate_files(
        args.files, args.api_key, args.dialect, args.threshold, args.warn_only, schema_ddl, args.target_dir
    )


if __name__ == "__main__":
    sys.exit(main())
