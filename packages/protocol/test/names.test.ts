import { describe, expect, it } from 'vitest';
import { ToolNameTable, exposeName, isValidSlug } from '../src/index.js';

describe('isValidSlug', () => {
  it.each(['crm', 'files', 'crm-eu', 'a1', 'x-1-y'])('accepts %s', (s) => expect(isValidSlug(s)).toBe(true));
  it.each(['', 'CRM', 'crm_eu', 'crm__x', '-crm', 'crm-', 'crm--eu', 'crm.eu', 'a'.repeat(25), 'crm eu'])(
    'rejects %j',
    (s) => expect(isValidSlug(s)).toBe(false),
  );
});

describe('exposeName', () => {
  it('joins slug and tool with a double underscore', () => {
    expect(exposeName('crm', 'read_customer')).toEqual({ ok: true, name: 'crm__read_customer' });
  });

  it('keeps upstream tool names that themselves contain __', () => {
    expect(exposeName('crm', 'a__b')).toEqual({ ok: true, name: 'crm__a__b' });
  });

  it('rejects names with dots (legal in MCP, unsafe for LLM hosts)', () => {
    const r = exposeName('admin', 'tools.list');
    expect(r.ok).toBe(false);
  });

  it('rejects names over 64 characters', () => {
    expect(exposeName('crm', 'x'.repeat(60)).ok).toBe(false);
  });

  it('rejects upstream names that violate MCP rules', () => {
    expect(exposeName('crm', 'has space').ok).toBe(false);
    expect(exposeName('crm', '').ok).toBe(false);
    expect(exposeName('crm', 'ünïcode').ok).toBe(false);
  });
});

describe('ToolNameTable', () => {
  const build = () => {
    const t = new ToolNameTable<string>();
    t.add('files', 'read', 'files.read');
    t.add('crm', 'read_customer', 'crm.read');
    t.add('crm', 'delete_customer', 'crm.delete');
    t.add('crm', 'a__b', 'crm.ab');
    return t;
  };

  it('resolves exact names only', () => {
    const t = build();
    expect(t.resolve('crm__read_customer')?.value).toBe('crm.read');
    expect(t.resolve('CRM__read_customer')).toBeUndefined();
    expect(t.resolve('crm__READ_CUSTOMER')).toBeUndefined();
    expect(t.resolve('crm__read_customer ')).toBeUndefined();
    expect(t.resolve('read_customer')).toBeUndefined();
    expect(t.resolve('crm.read_customer')).toBeUndefined();
  });

  it('cannot be steered across slugs by crafted names', () => {
    const t = build();
    // "crm__a__b" belongs to crm/a__b, never to a hypothetical "crm__a" upstream.
    expect(t.resolve('crm__a__b')).toMatchObject({ slug: 'crm', upstreamToolName: 'a__b' });
    expect(t.resolve('crm__a')).toBeUndefined();
    expect(t.resolve('files__read__x')).toBeUndefined();
  });

  it('lists entries in deterministic sorted order', () => {
    expect(
      build()
        .list()
        .map((e) => e.exposedName),
    ).toEqual(['crm__a__b', 'crm__delete_customer', 'crm__read_customer', 'files__read']);
  });

  it('records rejections instead of throwing', () => {
    const t = new ToolNameTable<number>();
    expect(t.add('crm', 'x.y', 1)).toBeUndefined();
    expect(t.add('crm', 'ok', 2)).toBeDefined();
    expect(t.add('crm', 'ok', 3)).toBeUndefined();
    expect(t.rejections()).toHaveLength(2);
    expect(t.resolve('crm__ok')?.value).toBe(2);
  });
});
