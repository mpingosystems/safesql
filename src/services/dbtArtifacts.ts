// Sprint 8 — dbt manifest integration.
//
// Pure translation of dbt `target/` artifacts (manifest.json, catalog.json,
// run_results.json) into two things the engine already understands or can be
// handed alongside a request:
//
//   1. an enriched SchemaDefinition — complete column lists and real warehouse
//      types from the catalog, PK / FK / nullable derived from the project's
//      own `unique`, `not_null` and `relationships` tests;
//   2. a DbtContext — which relations are sources vs models, their tags,
//      materialization, last run status and lineage, plus the derived
//      source → trusted-mart map the UNAPPROVED_SOURCE detector reads.
//
// No I/O and no side effects: callers (CLI, Action, API, Python package) read
// the files and hand over parsed JSON. Nothing dbt-specific leaks into the
// detectors — they see SchemaDefinition + DbtContext only.
//
// Manifest schema versions v10, v11 and v12 (dbt 1.5 → 1.8+) are handled. The
// keys read are the stable ones: nodes, sources, child_map, depends_on,
// columns, tags, config.materialized, resource_type, test_metadata.

import type { SchemaColumn, SchemaDefinition, SchemaTable } from '../types/validation';

// ── Input — raw parsed JSON as dbt writes it ─────────────────────────────────
// Structural "at least these keys" types: a real artifact carries far more,
// and extra keys must never be a type error for a caller.

export interface DbtManifestColumn {
  name: string;
  data_type?: string | null;
}

export interface DbtManifestNode {
  unique_id: string;
  resource_type: string; // 'model' | 'test' | 'seed' | 'snapshot' | 'analysis' | 'operation' | ...
  name: string;
  alias?: string;
  tags?: string[];
  config?: { materialized?: string; tags?: string[] | string; meta?: Record<string, unknown> };
  meta?: Record<string, unknown>;
  columns?: Record<string, DbtManifestColumn>;
  depends_on?: { nodes?: string[] };
  // Present on resource_type === 'test' for generic (schema) tests.
  test_metadata?: { name: string; kwargs?: Record<string, unknown> };
  // dbt ≥ 1.5 — the model/source a generic test is attached to.
  attached_node?: string;
}

export interface DbtManifestSource {
  unique_id: string;
  resource_type: 'source';
  name: string; // table name inside the source
  identifier?: string; // physical relation name when it differs from `name`
  source_name: string;
  tags?: string[];
  meta?: Record<string, unknown>;
  columns?: Record<string, DbtManifestColumn>;
}

export interface DbtManifest {
  metadata?: { dbt_version?: string; dbt_schema_version?: string; generated_at?: string };
  nodes: Record<string, DbtManifestNode>;
  sources?: Record<string, DbtManifestSource>;
  parent_map?: Record<string, string[]>;
  child_map?: Record<string, string[]>;
}

export interface DbtCatalogNode {
  unique_id?: string;
  columns: Record<string, { name: string; type: string; index?: number }>;
  stats?: Record<string, { id: string; value: unknown; include?: boolean }>;
}

export interface DbtCatalog {
  nodes: Record<string, DbtCatalogNode>;
  sources?: Record<string, DbtCatalogNode>;
}

export interface DbtRunResults {
  results: Array<{ unique_id: string; status: string }>;
}

export interface DbtArtifactInput {
  manifest: DbtManifest;
  catalog?: DbtCatalog;
  runResults?: DbtRunResults;
  // Tags that mark a relation as sensitive for FINANCE_TAG_UNVALIDATED.
  // Configuration is an input; the context only records what was used.
  sensitiveTags?: string[];
  // Relation name of the model whose SQL is being validated. Lets
  // UNAPPROVED_SOURCE exempt a staging model reading its own raw source.
  currentModel?: string;
}

// ── Output ───────────────────────────────────────────────────────────────────

// dbt's own vocabulary, kept raw so the detectors compare against 'success'
// with no lossy mapping. run_results writes 'skipped'; it is normalised to
// 'skip' (the only rename). Tests report 'pass' / 'fail' / 'warn'.
export type DbtRunStatus = 'success' | 'error' | 'skip' | 'fail' | 'warn' | 'pass';

export type DbtRelationType = 'model' | 'source' | 'seed' | 'snapshot';

export interface DbtModelMeta {
  uniqueId: string;
  // The logical name — what ref('x') / source('s','x') take, and what the
  // Python package renders Jinja to. Original casing preserved.
  relation: string;
  // alias (models) / identifier (sources) when it differs from `relation`:
  // the name compiled SQL uses. Registered as a second key so either resolves.
  physicalName?: string;
  resourceType: DbtRelationType;
  tags: string[]; // node.tags ∪ config.tags, lower-cased, de-duplicated
  materialized: string; // '' for sources
  isTrustedMart: boolean;
  lastRunStatus?: DbtRunStatus; // undefined ⇒ no run result for this node
  dependsOn: string[]; // upstream RELATION names (models, seeds, snapshots, sources)
  owner?: string; // meta.owner ?? config.meta.owner
}

export type DbtSourceMeta = DbtModelMeta & { resourceType: 'source'; sourceName: string };

export interface DbtContext {
  // Keys are lower-cased `relation`, plus `physicalName` when it differs — so
  // both the logical name (Python path) and the compiled name resolve.
  models: Map<string, DbtModelMeta>; // models, seeds, snapshots
  sources: Map<string, DbtSourceMeta>;
  // source relation (lower-cased) → trusted-mart relations that transitively
  // depend on it, NEAREST FIRST (BFS depth, then name). Index 0 is the mart a
  // finding should recommend.
  sourceToMart: Map<string, string[]>;
  sensitiveTags: string[];
  currentModel?: string;
  // Provenance — lets a surface say "no context loaded" rather than "clean".
  artifacts: { catalog: boolean; runResults: boolean };
  dbtVersion?: string;
  generatedAt?: string;
}

export interface DbtParseResult {
  schema: SchemaDefinition; // existing type, unchanged — PK/FK/nullable/type/rows populated
  context: DbtContext;
  // Non-fatal problems. A real dbt artifact never throws; it may warn.
  warnings: string[];
}

export const DEFAULT_SENSITIVE_TAGS: readonly string[] = ['finance', 'pii'];

const RELATION_TYPES: ReadonlySet<string> = new Set(['model', 'seed', 'snapshot']);
const SUPPORTED_SCHEMA_VERSIONS = ['v10', 'v11', 'v12'];

// ── Public helpers ───────────────────────────────────────────────────────────

export function looksLikeDbtManifest(value: unknown): value is DbtManifest {
  if (!value || typeof value !== 'object') return false;
  const nodes = (value as { nodes?: unknown }).nodes;
  return !!nodes && typeof nodes === 'object' && !Array.isArray(nodes);
}

// Explicit user DDL wins per table; tables only the artifacts know about are
// appended. One merge shared by the CLI, Action and API so precedence cannot
// drift between surfaces.
export function mergeSchemas(
  primary: SchemaDefinition | undefined,
  fallback: SchemaDefinition,
): SchemaDefinition {
  if (!primary || primary.tables.length === 0) return fallback;
  const seen = new Set(primary.tables.map((t) => t.name.toLowerCase()));
  const extra = fallback.tables.filter((t) => !seen.has(t.name.toLowerCase()));
  return { tables: [...primary.tables, ...extra] };
}

// ── Main entry ───────────────────────────────────────────────────────────────

export function parseDbtArtifacts(input: DbtArtifactInput): DbtParseResult {
  const { manifest, catalog, runResults } = input;
  if (!looksLikeDbtManifest(manifest)) {
    throw new Error('parseDbtArtifacts: `manifest` must be a parsed dbt manifest.json with a `nodes` map');
  }
  const warnings: string[] = [];

  const schemaVersion = schemaVersionOf(manifest);
  if (schemaVersion && !SUPPORTED_SCHEMA_VERSIONS.includes(schemaVersion)) {
    warnings.push(
      `manifest schema ${schemaVersion} is outside the tested range (${SUPPORTED_SCHEMA_VERSIONS.join(', ')}); parsing on a best-effort basis`,
    );
  }

  // 1. Relations: every model / seed / snapshot node plus every source.
  const nodes = manifest.nodes ?? {};
  const sources = manifest.sources ?? {};
  const relationById = new Map<string, string>(); // unique_id → relation name
  for (const node of Object.values(nodes)) {
    if (RELATION_TYPES.has(node.resource_type)) relationById.set(node.unique_id, nodeRelation(node));
  }
  for (const src of Object.values(sources)) relationById.set(src.unique_id, sourceRelation(src));

  // 2. Run statuses by unique_id.
  const statusById = new Map<string, DbtRunStatus>();
  for (const r of runResults?.results ?? []) {
    if (r && typeof r.unique_id === 'string') statusById.set(r.unique_id, normaliseStatus(r.status));
  }

  // 3. Column tests → PK / nullable / FK facts per (unique_id, column).
  const columnFacts = collectColumnFacts(nodes, relationById, warnings);

  // 4. Lineage: child map (from the manifest, or inverted from depends_on).
  const childMap = manifest.child_map ?? invertDependsOn(nodes);
  const reachFromSource = new Map<string, Map<string, number>>(); // source id → (node id → depth)
  for (const src of Object.values(sources)) reachFromSource.set(src.unique_id, reachable(src.unique_id, childMap));

  const isQueryableModel = (id: string): boolean => {
    const n = nodes[id];
    return !!n && n.resource_type === 'model' && materializedOf(n) !== 'ephemeral';
  };
  const trustedMartIds = new Set<string>();
  for (const reach of reachFromSource.values()) {
    for (const id of reach.keys()) if (isQueryableModel(id)) trustedMartIds.add(id);
  }

  // 5. Build context maps.
  const models = new Map<string, DbtModelMeta>();
  const sourceMap = new Map<string, DbtSourceMeta>();

  for (const node of Object.values(nodes)) {
    if (!RELATION_TYPES.has(node.resource_type)) continue;
    const relation = nodeRelation(node);
    const physical = nodePhysical(node);
    const meta: DbtModelMeta = {
      uniqueId: node.unique_id,
      relation,
      ...(physical ? { physicalName: physical } : {}),
      resourceType: node.resource_type as DbtRelationType,
      tags: tagsOf(node),
      materialized: materializedOf(node),
      isTrustedMart: trustedMartIds.has(node.unique_id),
      lastRunStatus: statusById.get(node.unique_id),
      dependsOn: (node.depends_on?.nodes ?? [])
        .map((id) => relationById.get(id))
        .filter((r): r is string => typeof r === 'string'),
      owner: ownerOf(node),
    };
    models.set(relation.toLowerCase(), meta);
    if (physical) models.set(physical.toLowerCase(), meta);
  }

  for (const src of Object.values(sources)) {
    const relation = sourceRelation(src);
    const physical = sourcePhysical(src);
    const meta: DbtSourceMeta = {
      uniqueId: src.unique_id,
      relation,
      ...(physical ? { physicalName: physical } : {}),
      resourceType: 'source',
      sourceName: src.source_name,
      tags: tagsOf(src),
      materialized: '',
      isTrustedMart: false,
      lastRunStatus: statusById.get(src.unique_id),
      dependsOn: [],
      owner: ownerOf(src),
    };
    sourceMap.set(relation.toLowerCase(), meta);
    if (physical) sourceMap.set(physical.toLowerCase(), meta);
  }

  // 6. source → marts, nearest first.
  const sourceToMart = new Map<string, string[]>();
  for (const src of Object.values(sources)) {
    const reach = reachFromSource.get(src.unique_id) ?? new Map<string, number>();
    const marts = [...reach.entries()]
      .filter(([id]) => isQueryableModel(id))
      .map(([id, depth]) => ({ relation: relationById.get(id) as string, depth }))
      .sort((a, b) => a.depth - b.depth || a.relation.localeCompare(b.relation))
      .map((m) => m.relation);
    sourceToMart.set(sourceRelation(src).toLowerCase(), marts);
    const physical = sourcePhysical(src);
    if (physical) sourceToMart.set(physical.toLowerCase(), marts);
  }

  // 7. Schema: one table per relation; catalog columns win on type and
  //    completeness, manifest supplies the documented subset and the tests.
  const tables: SchemaTable[] = [];
  const catalogNodes: Record<string, DbtCatalogNode> = { ...(catalog?.nodes ?? {}), ...(catalog?.sources ?? {}) };
  const seenTable = new Set<string>();

  const addTable = (uniqueId: string, relation: string, manifestCols?: Record<string, DbtManifestColumn>) => {
    const key = relation.toLowerCase();
    if (seenTable.has(key)) {
      warnings.push(`relation "${relation}" is defined more than once (${uniqueId}); keeping the first definition`);
      return;
    }
    seenTable.add(key);
    const cat = catalogNodes[uniqueId];
    const facts = columnFacts.get(uniqueId) ?? new Map<string, ColumnFacts>();

    // Column order: catalog index when present, else manifest order.
    const names = new Map<string, { type: string }>(); // lower → display
    const ordered: string[] = [];
    if (cat) {
      const cols = Object.values(cat.columns ?? {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      for (const c of cols) {
        if (!c?.name) continue;
        const lower = c.name.toLowerCase();
        if (!names.has(lower)) {
          names.set(lower, { type: c.type || 'TEXT' });
          ordered.push(c.name);
        }
      }
    }
    for (const c of Object.values(manifestCols ?? {})) {
      if (!c?.name) continue;
      const lower = c.name.toLowerCase();
      if (!names.has(lower)) {
        names.set(lower, { type: c.data_type || 'TEXT' });
        ordered.push(c.name);
      }
      // catalog type wins; manifest data_type only fills a gap
    }

    const columns: SchemaColumn[] = ordered.map((name) => {
      const lower = name.toLowerCase();
      const f = facts.get(lower);
      const isPK = !!(f?.unique && f?.notNull);
      return {
        name,
        type: names.get(lower)?.type ?? 'TEXT',
        nullable: !(f?.notNull || isPK),
        isPK,
        isFK: !!f?.fkTable,
        ...(f?.fkTable ? { fkReferencesTable: f.fkTable } : {}),
        ...(f?.fkColumn ? { fkReferencesColumn: f.fkColumn } : {}),
      };
    });

    const rows = rowCountOf(cat);
    tables.push({ name: relation, columns, ...(rows !== undefined ? { estimatedRows: rows } : {}) });
  };

  for (const node of Object.values(nodes)) {
    if (!RELATION_TYPES.has(node.resource_type)) continue;
    addTable(node.unique_id, nodeRelation(node), node.columns);
    const physical = nodePhysical(node);
    if (physical) addTable(node.unique_id, physical, node.columns);
  }
  for (const src of Object.values(sources)) {
    addTable(src.unique_id, sourceRelation(src), src.columns);
    const physical = sourcePhysical(src);
    if (physical) addTable(src.unique_id, physical, src.columns);
  }

  // Catalog nodes with no manifest twin are stale docs — say so, don't invent tables.
  for (const id of Object.keys(catalogNodes)) {
    if (!relationById.has(id)) warnings.push(`catalog node ${id} has no manifest counterpart; ignored`);
  }

  const sensitiveTags = (input.sensitiveTags ?? DEFAULT_SENSITIVE_TAGS).map((t) => t.toLowerCase());

  return {
    schema: { tables },
    context: {
      models,
      sources: sourceMap,
      sourceToMart,
      sensitiveTags,
      ...(input.currentModel ? { currentModel: input.currentModel } : {}),
      artifacts: { catalog: !!catalog, runResults: !!runResults },
      ...(manifest.metadata?.dbt_version ? { dbtVersion: manifest.metadata.dbt_version } : {}),
      ...(manifest.metadata?.generated_at ? { generatedAt: manifest.metadata.generated_at } : {}),
    },
    warnings,
  };
}

// ── Internals ────────────────────────────────────────────────────────────────

interface ColumnFacts {
  unique?: boolean;
  notNull?: boolean;
  fkTable?: string;
  fkColumn?: string;
}

function nodeRelation(node: DbtManifestNode): string {
  return node.name;
}

function nodePhysical(node: DbtManifestNode): string | undefined {
  return node.alias && node.alias.toLowerCase() !== node.name.toLowerCase() ? node.alias : undefined;
}

function sourceRelation(src: DbtManifestSource): string {
  return src.name;
}

function sourcePhysical(src: DbtManifestSource): string | undefined {
  return src.identifier && src.identifier.toLowerCase() !== src.name.toLowerCase() ? src.identifier : undefined;
}

function materializedOf(node: DbtManifestNode): string {
  return String(node.config?.materialized ?? '').toLowerCase();
}

function tagsOf(node: { tags?: string[]; config?: { tags?: string[] | string } }): string[] {
  const cfg = node.config?.tags;
  const fromConfig = Array.isArray(cfg) ? cfg : typeof cfg === 'string' ? [cfg] : [];
  const out = new Set<string>();
  for (const t of [...(node.tags ?? []), ...fromConfig]) if (typeof t === 'string' && t) out.add(t.toLowerCase());
  return [...out];
}

function ownerOf(node: { meta?: Record<string, unknown>; config?: { meta?: Record<string, unknown> } }): string | undefined {
  const o = node.meta?.owner ?? node.config?.meta?.owner;
  return typeof o === 'string' && o ? o : undefined;
}

function schemaVersionOf(manifest: DbtManifest): string | null {
  const url = manifest.metadata?.dbt_schema_version;
  if (typeof url !== 'string') return null;
  const m = /manifest\/(v\d+)\.json/.exec(url);
  return m ? m[1] : null;
}

function normaliseStatus(raw: string): DbtRunStatus {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'skipped') return 'skip';
  if (s === 'success' || s === 'error' || s === 'skip' || s === 'fail' || s === 'warn' || s === 'pass') return s;
  // Unknown vocabulary is treated as not-success rather than dropped — an
  // unfamiliar status is exactly the case a reviewer should look at.
  return 'error';
}

function rowCountOf(cat: DbtCatalogNode | undefined): number | undefined {
  const v = cat?.stats?.row_count?.value;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

// `to: ref('x')` / `ref('pkg','x')` / `source('s','t')` → relation name. dbt's
// relation is always the LAST quoted argument (mirrors validate_dbt.py).
function relationFromRefExpr(expr: unknown, relationById: Map<string, string>, dependsOn: string[]): string | null {
  if (typeof expr !== 'string') return null;
  const quoted = [...expr.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  if (quoted.length === 0) return null;
  const wanted = quoted[quoted.length - 1].toLowerCase();
  // Prefer the depends_on node whose relation matches — resolves aliases.
  for (const id of dependsOn) {
    const rel = relationById.get(id);
    if (rel && rel.toLowerCase() === wanted) return rel;
    // ref('x') names the model by NAME even when it has an alias.
    const suffix = id.split('.').pop()?.toLowerCase();
    if (rel && suffix === wanted) return rel;
  }
  return quoted[quoted.length - 1];
}

// The model a generic test is attached to: `attached_node` (v11+), else the
// depends_on node that is NOT the relationships target (v10).
function attachedModelId(test: DbtManifestNode, toId: string | null): string | null {
  if (typeof test.attached_node === 'string' && test.attached_node) return test.attached_node;
  const deps = test.depends_on?.nodes ?? [];
  const candidates = deps.filter((id) => id !== toId && !id.startsWith('macro.'));
  return candidates[0] ?? null;
}

function collectColumnFacts(
  nodes: Record<string, DbtManifestNode>,
  relationById: Map<string, string>,
  warnings: string[],
): Map<string, Map<string, ColumnFacts>> {
  const facts = new Map<string, Map<string, ColumnFacts>>();
  const factsFor = (modelId: string, column: string): ColumnFacts => {
    let m = facts.get(modelId);
    if (!m) facts.set(modelId, (m = new Map()));
    const key = column.toLowerCase();
    let f = m.get(key);
    if (!f) m.set(key, (f = {}));
    return f;
  };

  for (const node of Object.values(nodes)) {
    if (node.resource_type !== 'test' || !node.test_metadata) continue;
    const kind = String(node.test_metadata.name ?? '').toLowerCase();
    const kwargs = node.test_metadata.kwargs ?? {};
    const column = typeof kwargs.column_name === 'string' ? kwargs.column_name : null;
    if (!column) continue;
    const deps = (node.depends_on?.nodes ?? []).filter((id) => !id.startsWith('macro.'));

    if (kind === 'unique' || kind === 'not_null') {
      const modelId = attachedModelId(node, null);
      if (!modelId) continue;
      const f = factsFor(modelId, column);
      if (kind === 'unique') f.unique = true;
      else f.notNull = true;
      continue;
    }

    if (kind === 'relationships') {
      // The `to` target is whichever depends_on node the `to:` expression names.
      const toRel = relationFromRefExpr(kwargs.to, relationById, deps);
      if (!toRel) {
        warnings.push(`relationships test ${node.unique_id} has an unparsable \`to\`; FK not derived`);
        continue;
      }
      const toId = deps.find((id) => relationById.get(id)?.toLowerCase() === toRel.toLowerCase()) ?? null;
      const modelId = attachedModelId(node, toId);
      if (!modelId) continue;
      const f = factsFor(modelId, column);
      f.fkTable = toRel;
      if (typeof kwargs.field === 'string' && kwargs.field) f.fkColumn = kwargs.field;
    }
  }
  return facts;
}

function invertDependsOn(nodes: Record<string, DbtManifestNode>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const node of Object.values(nodes)) {
    for (const parent of node.depends_on?.nodes ?? []) {
      (out[parent] ??= []).push(node.unique_id);
    }
  }
  return out;
}

// BFS over the child map from `start`, returning every reachable node with its
// depth. Ephemeral models are traversed (they are CTEs, not destinations) and
// filtered by the caller; tests / exposures are reachable too but are never
// queryable models so they fall out at the same filter.
function reachable(start: string, childMap: Record<string, string[]>): Map<string, number> {
  const depth = new Map<string, number>();
  const queue: Array<[string, number]> = (childMap[start] ?? []).map((id) => [id, 1]);
  while (queue.length > 0) {
    const [id, d] = queue.shift() as [string, number];
    if (depth.has(id)) continue;
    depth.set(id, d);
    for (const child of childMap[id] ?? []) if (!depth.has(child)) queue.push([child, d + 1]);
  }
  return depth;
}
