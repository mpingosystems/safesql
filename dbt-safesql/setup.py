"""PyPI packaging for dbt-safesql.

Ships validate_dbt.py as a top-level module plus the `safesql-dbt`,
`dbt-safesql` and `safesql-sql` console scripts. Distribution is PyPI, not dbt Hub: dbt packages carry Jinja/SQL only and
cannot make HTTP calls, so the validator has to be an ordinary Python CLI that
runs beside dbt (pre-commit, CI, or a shell step before `dbt run`).
"""
import os

from setuptools import setup

HERE = os.path.abspath(os.path.dirname(__file__))

with open(os.path.join(HERE, "README.md"), "r", encoding="utf-8") as fh:
    LONG_DESCRIPTION = fh.read()

setup(
    name="dbt-safesql",
    version="0.3.0",
    description="Validate dbt SQL models with SafeSQL Pro before they execute",
    long_description=LONG_DESCRIPTION,
    long_description_content_type="text/markdown",
    author="Mpingo Systems LLC",
    url="https://safesqlpro.dev",
    project_urls={
        "Documentation": "https://safesqlpro.dev/docs",
        "Source": "https://github.com/mpingosystems/safesql",
    },
    license="Apache-2.0",
    # validate_dbt.py / validate_files.py live at the package root — shipped as
    # modules, not a package, so the existing files stay where they are.
    py_modules=["validate_dbt", "validate_files"],
    python_requires=">=3.9",
    install_requires=["requests>=2.25", "pyyaml>=5.4"],
    entry_points={
        "console_scripts": [
            # project-wide, dbt-aware (walks models/**, builds DDL from schema.yml)
            "safesql-dbt=validate_dbt:main",
            # 0.2.1 — same function under the package name, so `pip install
            # dbt-safesql` gives you a `dbt-safesql` command. safesql-dbt stays
            # as the original name and is what .pre-commit-hooks.yaml invokes.
            "dbt-safesql=validate_dbt:main",
            # file-scoped, not dbt-aware (validates exactly the paths given).
            # This is the entry point for the `safesql-sql` pre-commit hook —
            # removing it breaks that hook for every consumer.
            "safesql-sql=validate_files:main",
        ]
    },
    keywords=["dbt", "sql", "validation", "data-quality", "safesql", "linter"],
    classifiers=[
        "Development Status :: 4 - Beta",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: Apache Software License",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: SQL",
        "Topic :: Database",
        "Topic :: Software Development :: Quality Assurance",
    ],
)
