#!/usr/bin/env python3
"""SafeSQL dbt integration — validate dbt SQL models before `dbt run`.

Scans models/**/*.sql, strips dbt Jinja, extracts a rough DDL from
sources.yml / schema.yml, calls the SafeSQL REST API for each model, and exits
non-zero if any model has errors. Thin wrapper around POST /api/validate — no
validator logic lives here.

Usage:
    python validate_dbt.py --project-dir . --dialect postgresql
    SAFESQL_API_KEY=ssk_live_xxx python validate_dbt.py --project-dir .
"""
import argparse
import glob
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


def strip_dbt_jinja(sql: str) -> str:
    """Replace {{ ... }} expressions with a placeholder and drop {% ... %} blocks
    so node-sql-parser can parse the model as plain SQL."""
    sql = re.sub(r"\{\{[^}]+\}\}", "'__dbt_ref__'", sql)
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


def validate_dbt_project(project_dir: str, api_key: str, dialect: str = "postgresql") -> int:
    sql_files = glob.glob(f"{project_dir}/models/**/*.sql", recursive=True)
    schema_ddl = extract_schema_from_dbt(project_dir)

    results = []
    for sql_file in sql_files:
        with open(sql_file, "r", encoding="utf-8") as fh:
            clean_sql = strip_dbt_jinja(fh.read())
        try:
            resp = requests.post(
                API_URL,
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={"sql": clean_sql, "ddl": schema_ddl, "dialect": dialect},
                timeout=30,
            )
            report = resp.json()
        except Exception as exc:  # network / parse failure — surface, don't crash all
            report = {"errors": [{"issueType": "API_ERROR", "message": str(exc)}], "warnings": []}
        results.append({"file": sql_file, "report": report})

    with_errors = [r for r in results if r["report"].get("errors")]
    print(f"SafeSQL: {len(sql_files)} models checked, {len(with_errors)} with errors")
    for r in with_errors:
        errs = r["report"].get("errors", [])
        print(f"  ❌ {r['file']}: {len(errs)} error(s)")
        for e in errs:
            print(f"     {e.get('issueType', e.get('id', 'ERROR'))}: {e.get('message', e.get('description', ''))}")

    return 1 if with_errors else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate dbt SQL models with SafeSQL")
    parser.add_argument("--project-dir", default=".")
    parser.add_argument("--profiles-dir", default=os.path.expanduser("~/.dbt"))
    parser.add_argument("--dialect", default="postgresql")
    parser.add_argument("--api-key", default=os.environ.get("SAFESQL_API_KEY", ""))
    args = parser.parse_args()

    if not args.api_key:
        print("SafeSQL: set --api-key or SAFESQL_API_KEY env var.", file=sys.stderr)
        return 2

    return validate_dbt_project(args.project_dir, args.api_key, args.dialect)


if __name__ == "__main__":
    sys.exit(main())
