import { describe, expect, it } from 'vitest';
import {
  decryptConfig,
  encryptConfig,
  generateEncryptionKey,
  isDialectSupported,
  parseInformationSchema,
  type InformationSchemaRow,
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
  it('postgresql is supported in v1', () => {
    expect(isDialectSupported('postgresql')).toBe(true);
  });
  it('mysql / bigquery / snowflake are not yet', () => {
    expect(isDialectSupported('mysql')).toBe(false);
    expect(isDialectSupported('bigquery')).toBe(false);
    expect(isDialectSupported('snowflake')).toBe(false);
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
