import { describe, expect, it } from 'vitest';
import {
  createBigQueryJWT,
  decryptConfig,
  encryptConfig,
  generateEncryptionKey,
  isDialectSupported,
  parseBigQueryColumns,
  parseInformationSchema,
  parseSnowflakeColumns,
  type BigQueryColumnRow,
  type InformationSchemaRow,
  type SnowflakeColumnRow,
} from '../services/schemaConnector';

describe('encryptConfig / decryptConfig', () => {
  it('round-trips a connection string', async () => {
    const key = generateEncryptionKey();
    const secret = 'postgresql://user:pw@db.example.com:5432/prod';
    const enc = await encryptConfig(secret, key);
    expect(enc).not.toContain('example.com'); // ciphertext doesn't leak the plaintext
    const dec = await decryptConfig(enc, key);
    expect(dec).toBe(secret);
  });

  it('produces a different ciphertext each time (random IV)', async () => {
    const key = generateEncryptionKey();
    const a = await encryptConfig('same', key);
    const b = await encryptConfig('same', key);
    expect(a).not.toBe(b);
    expect(await decryptConfig(a, key)).toBe('same');
    expect(await decryptConfig(b, key)).toBe('same');
  });

  it('fails to decrypt with the wrong key', async () => {
    const enc = await encryptConfig('secret', generateEncryptionKey());
    await expect(decryptConfig(enc, generateEncryptionKey())).rejects.toBeDefined();
  });

  it('rejects a key that is not 32 bytes', async () => {
    await expect(encryptConfig('x', btoa('short'))).rejects.toThrow(/32 bytes/);
  });
});

describe('isDialectSupported', () => {
  it('postgresql, bigquery and snowflake are supported', () => {
    expect(isDialectSupported('postgresql')).toBe(true);
    expect(isDialectSupported('bigquery')).toBe(true);
    expect(isDialectSupported('snowflake')).toBe(true);
  });
  it('mysql is still coming soon', () => {
    expect(isDialectSupported('mysql')).toBe(false);
  });
});

describe('parseInformationSchema', () => {
  const rows: InformationSchemaRow[] = [
    { table_name: 'users', column_name: 'id', data_type: 'integer', is_nullable: 'NO', constraint_type: 'PRIMARY KEY' },
    { table_name: 'users', column_name: 'email', data_type: 'character varying', is_nullable: 'NO' },
    { table_name: 'orders', column_name: 'id', data_type: 'integer', is_nullable: 'NO', constraint_type: 'PRIMARY KEY' },
    {
      table_name: 'orders',
      column_name: 'user_id',
      data_type: 'integer',
      is_nullable: 'YES',
      constraint_type: 'FOREIGN KEY',
      foreign_table_name: 'users',
      foreign_column_name: 'id',
    },
  ];

  it('groups rows into tables with columns', () => {
    const schema = parseInformationSchema(rows);
    expect(schema.tables.map((t) => t.name).sort()).toEqual(['orders', 'users']);
    const users = schema.tables.find((t) => t.name === 'users')!;
    expect(users.columns.map((c) => c.name)).toEqual(['id', 'email']);
  });

  it('maps primary keys, foreign keys, nullability, and types', () => {
    const schema = parseInformationSchema(rows);
    const orders = schema.tables.find((t) => t.name === 'orders')!;
    const id = orders.columns.find((c) => c.name === 'id')!;
    const fk = orders.columns.find((c) => c.name === 'user_id')!;
    expect(id.isPK).toBe(true);
    expect(id.type).toBe('int');
    expect(fk.isFK).toBe(true);
    expect(fk.nullable).toBe(true);
    expect(fk.fkReferencesTable).toBe('users');
    expect(fk.fkReferencesColumn).toBe('id');
    const email = schema.tables.find((t) => t.name === 'users')!.columns.find((c) => c.name === 'email')!;
    expect(email.type).toBe('varchar');
  });

  it('folds a column that is both PK and FK', () => {
    const dual: InformationSchemaRow[] = [
      { table_name: 'memberships', column_name: 'user_id', data_type: 'integer', is_nullable: 'NO', constraint_type: 'PRIMARY KEY' },
      { table_name: 'memberships', column_name: 'user_id', data_type: 'integer', is_nullable: 'NO', constraint_type: 'FOREIGN KEY', foreign_table_name: 'users', foreign_column_name: 'id' },
    ];
    const schema = parseInformationSchema(dual);
    const col = schema.tables[0].columns[0];
    expect(col.isPK).toBe(true);
    expect(col.isFK).toBe(true);
    expect(col.fkReferencesTable).toBe('users');
    // not duplicated
    expect(schema.tables[0].columns.length).toBe(1);
  });

  it('ignores rows without table/column names', () => {
    const schema = parseInformationSchema([{ table_name: '', column_name: '', data_type: 'text', is_nullable: 'YES' }]);
    expect(schema.tables.length).toBe(0);
  });
});

describe('parseBigQueryColumns', () => {
  it('converts INFORMATION_SCHEMA rows to a SchemaDefinition', () => {
    const rows: BigQueryColumnRow[] = [
      { table_name: 'events', column_name: 'id', data_type: 'INT64', is_nullable: 'NO' },
      { table_name: 'events', column_name: 'user_id', data_type: 'STRING', is_nullable: 'YES', is_partitioning_column: 'NO' },
      { table_name: 'sessions', column_name: 'id', data_type: 'INT64', is_nullable: 'NO' },
    ];
    const schema = parseBigQueryColumns(rows);
    expect(schema.tables.map((t) => t.name).sort()).toEqual(['events', 'sessions']);
    const events = schema.tables.find((t) => t.name === 'events')!;
    expect(events.columns.map((c) => c.name)).toEqual(['id', 'user_id']);
    expect(events.columns.find((c) => c.name === 'user_id')!.nullable).toBe(true);
    // No PK/FK metadata available from BigQuery COLUMNS view.
    expect(events.columns.every((c) => !c.isPK && !c.isFK)).toBe(true);
  });
});

describe('parseSnowflakeColumns', () => {
  it('converts UPPERCASE INFORMATION_SCHEMA rows to a SchemaDefinition', () => {
    const rows: SnowflakeColumnRow[] = [
      { TABLE_NAME: 'ORDERS', COLUMN_NAME: 'ID', DATA_TYPE: 'NUMBER', IS_NULLABLE: 'NO' },
      { TABLE_NAME: 'ORDERS', COLUMN_NAME: 'TOTAL', DATA_TYPE: 'NUMBER', IS_NULLABLE: 'YES', COLUMN_DEFAULT: null },
    ];
    const schema = parseSnowflakeColumns(rows);
    expect(schema.tables.length).toBe(1);
    expect(schema.tables[0].name).toBe('ORDERS');
    expect(schema.tables[0].columns.map((c) => c.name)).toEqual(['ID', 'TOTAL']);
    expect(schema.tables[0].columns.find((c) => c.name === 'TOTAL')!.nullable).toBe(true);
  });
});

describe('createBigQueryJWT', () => {
  it('produces a 3-segment RS256 JWT (mock service-account key)', async () => {
    // Generate a throwaway RSA key and export it to PKCS#8 PEM (the mock key).
    const pair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    );
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    let b64 = '';
    for (const x of pkcs8) b64 += String.fromCharCode(x);
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(b64)}\n-----END PRIVATE KEY-----`;

    const jwt = await createBigQueryJWT({ client_email: 'svc@proj.iam.gserviceaccount.com', private_key: pem }, 1_700_000_000);
    const segments = jwt.split('.');
    expect(segments.length).toBe(3);
    const header = JSON.parse(atob(segments[0].replace(/-/g, '+').replace(/_/g, '/')));
    expect(header).toMatchObject({ alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(atob(segments[1].replace(/-/g, '+').replace(/_/g, '/')));
    expect(claims.iss).toBe('svc@proj.iam.gserviceaccount.com');
    expect(claims.exp - claims.iat).toBe(3600);
  });
});
