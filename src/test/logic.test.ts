import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  maskLiteralsAndComments,
  splitStatements,
  statementAtOffset,
  hasLimitClause,
  isPlainSelect,
} from '../sqlStatements';
import { parseSqlForEditability } from '../sqlParser';
import { completionContextAt } from '../sqlCompletionContext';
import { toDisplayValue, formatDateTime } from '../utils';
import { toSafeJson, escapeHtml } from '../webview/webviewSecurity';

test('maskLiteralsAndComments preserves length', () => {
  for (const s of ['SELECT 1', "a '/*' b -- x\n c", '`a;b` /* c;d */ e']) {
    assert.equal(maskLiteralsAndComments(s).length, s.length);
  }
});

test('splitStatements ignores semicolons inside strings/backticks/comments', () => {
  assert.equal(splitStatements('SELECT 1; SELECT 2').length, 2);
  assert.equal(splitStatements("SELECT ';' ; SELECT 2")[0].text, "SELECT ';'");
  assert.equal(splitStatements('SELECT `a;b` FROM t; SELECT 2').length, 2);
  assert.equal(splitStatements('SELECT 1 /* a;b */ ; SELECT 2').length, 2);
  assert.equal(splitStatements('SELECT 1 -- a;b\n; SELECT 2').length, 2);
  assert.equal(splitStatements('  ; ; SELECT 1 ;  ').length, 1);
});

test('splitStatements offsets map back to original', () => {
  const src = 'SELECT 1;\nSELECT 2';
  const st = splitStatements(src);
  assert.equal(src.slice(st[1].start, st[1].end), 'SELECT 2');
});

test('statementAtOffset finds the statement under the cursor', () => {
  const st = splitStatements('SELECT 1;\nSELECT 2;\nSELECT 3');
  assert.equal(statementAtOffset(st, 0)?.text, 'SELECT 1');
  assert.equal(statementAtOffset(st, 12)?.text, 'SELECT 2');
  assert.equal(statementAtOffset(st, 100)?.text, 'SELECT 3');
});

test('hasLimitClause / isPlainSelect ignore literals and comments', () => {
  assert.equal(hasLimitClause('SELECT * FROM t'), false);
  assert.equal(hasLimitClause('SELECT * FROM t LIMIT 10'), true);
  assert.equal(hasLimitClause("SELECT 'limit' FROM t"), false);
  assert.equal(hasLimitClause('SELECT * FROM t -- limit 5'), false);
  assert.equal(isPlainSelect('SELECT * FROM t'), true);
  assert.equal(isPlainSelect('-- hi\nSELECT * FROM t'), true);
  assert.equal(isPlainSelect('SELECT 1 UNION SELECT 2'), false);
  assert.equal(isPlainSelect('UPDATE t SET a=1'), false);
});

test('parseSqlForEditability: editable single-table SELECTs', () => {
  for (const [sql, db, table] of [
    ['SELECT * FROM t', null, 't'],
    ['SELECT * FROM db.t', 'db', 't'],
    ['SELECT a, b FROM t', null, 't'],
    ['SELECT COUNT(*) FROM t', null, 't'],
    ['SELECT * FROM t WHERE id IN (1,2,3)', null, 't'],
    ['-- comment\nSELECT * FROM t', null, 't'],
    ["SELECT * FROM t WHERE name = 'union all'", null, 't'],
  ] as const) {
    const r = parseSqlForEditability(sql);
    assert.equal(r.editable, true, sql);
    assert.equal(r.database, db, sql);
    assert.equal(r.table, table, sql);
  }
});

test('parseSqlForEditability: read-only queries', () => {
  for (const [sql, reason] of [
    ['SELECT * FROM a, b', 'Multi-table query'],
    ['SELECT * FROM a STRAIGHT_JOIN b', 'JOIN query'],
    ['SELECT * FROM a JOIN b ON a.id=b.id', 'JOIN query'],
    ['SELECT * FROM t GROUP BY x', 'GROUP BY'],
    ['SELECT SUM(x) FROM t', 'Aggregate function'],
    ['SELECT * FROM (SELECT 1) x', 'Subquery'],
    ['UPDATE t SET a=1', 'Non-SELECT query'],
    ['SELECT 1 UNION SELECT 2', 'UNION query'],
  ] as const) {
    const r = parseSqlForEditability(sql);
    assert.equal(r.editable, false, sql);
    assert.equal(r.reason, reason, sql);
  }
});

test('toDisplayValue serializes complex types', () => {
  assert.equal(toDisplayValue(Buffer.from([0xde, 0xad])), '0xdead');
  assert.equal(toDisplayValue({ a: 1 }), '{"a":1}');
  assert.equal(toDisplayValue([1, 2]), '[1,2]');
  assert.equal(toDisplayValue(null), null);
  assert.equal(toDisplayValue(42), 42);
  assert.equal(toDisplayValue('x'), 'x');
});

test('formatDateTime formats Date, passes through strings', () => {
  assert.equal(formatDateTime('2024-01-15 10:30:00'), '2024-01-15 10:30:00');
  assert.equal(formatDateTime(null), 'NULL');
});

test('toSafeJson neutralizes </script> breakout', () => {
  const s = toSafeJson([{ note: '</script><script>alert(1)</script>' }]);
  assert.equal(s.includes('</script>'), false);
  const restored = JSON.parse(
    s
      .replace(/\\u003c/g, '<')
      .replace(/\\u003e/g, '>')
      .replace(/\\u0026/g, '&'),
  );
  assert.equal(restored[0].note, '</script><script>alert(1)</script>');
});

test('escapeHtml escapes angle brackets and quotes', () => {
  assert.equal(escapeHtml('<b title="x">'), '&lt;b title=&quot;x&quot;&gt;');
});

/** '|' 위치를 커서로 간주해 자동완성 문맥을 계산한다. */
function ctxOf(sql: string): ReturnType<typeof completionContextAt> {
  const off = sql.indexOf('|');
  assert.ok(off >= 0, 'cursor marker | required');
  return completionContextAt(sql.slice(0, off) + sql.slice(off + 1), off);
}

test('completion: table context after FROM/JOIN/UPDATE', () => {
  const c1 = ctxOf('SELECT * FROM |');
  assert.equal(c1.kind, 'table');
  assert.equal(c1.prefix, '');

  const c2 = ctxOf('SELECT * FROM users|');
  assert.equal(c2.kind, 'table');
  assert.equal(c2.prefix, 'users');

  const c3 = ctxOf('SELECT * FROM users u JOIN |');
  assert.equal(c3.kind, 'table');

  const c4 = ctxOf('UPDATE users SET a = 1 WHERE id = 2; DELETE FROM or|');
  assert.equal(c4.kind, 'table');
  assert.equal(c4.prefix, 'or');
});

test('completion: qualified table (db.) context', () => {
  const c1 = ctxOf('SELECT * FROM mydb.|');
  assert.equal(c1.kind, 'table');
  assert.equal(c1.database, 'mydb');
  assert.equal(c1.prefix, '');
  assert.equal(c1.prefixStart, 'SELECT * FROM mydb.'.length);

  const c2 = ctxOf('SELECT * FROM mydb.us|');
  assert.equal(c2.kind, 'table');
  assert.equal(c2.database, 'mydb');
  assert.equal(c2.prefix, 'us');
});

test('completion: column context in SELECT/WHERE/ORDER BY/SET', () => {
  const c1 = ctxOf('SELECT na| FROM users');
  assert.equal(c1.kind, 'column');
  assert.equal(c1.prefix, 'na');
  assert.equal(c1.tables.length, 1);
  assert.equal(c1.tables[0].table, 'users');

  const c2 = ctxOf('SELECT * FROM users WHERE |');
  assert.equal(c2.kind, 'column');

  const c3 = ctxOf('SELECT * FROM users ORDER BY cre|');
  assert.equal(c3.kind, 'column');
  assert.equal(c3.prefix, 'cre');

  const c4 = ctxOf('UPDATE t SET na|');
  assert.equal(c4.kind, 'column');
  assert.equal(c4.tables.length, 1);
  assert.equal(c4.tables[0].table, 't');
});

test('completion: alias-qualified column resolves to table', () => {
  const sql = 'SELECT u.na| FROM users AS u JOIN orders o ON u.id = o.user_id';
  const c = ctxOf(sql);
  assert.equal(c.kind, 'column');
  assert.equal(c.alias, 'u');
  assert.equal(c.table, 'users');
  assert.equal(c.prefix, 'na');
  // 스코프 테이블 수집: alias와 테이블 매핑
  assert.ok(
    c.tables.some((r) => r.table === 'users' && r.alias === 'u'),
    JSON.stringify(c.tables),
  );
  assert.ok(
    c.tables.some((r) => r.table === 'orders' && r.alias === 'o'),
    JSON.stringify(c.tables),
  );
});

test('completion: db.table. qualified column', () => {
  const c = ctxOf('SELECT mydb.users.na| FROM mydb.users');
  assert.equal(c.kind, 'column');
  assert.equal(c.database, 'mydb');
  assert.equal(c.table, 'users');
  assert.equal(c.prefix, 'na');
});

test('completion: database context after USE', () => {
  const c = ctxOf('USE my|');
  assert.equal(c.kind, 'database');
  assert.equal(c.prefix, 'my');
});

test('completion: multiple statements pick statement at cursor', () => {
  const c = ctxOf('SELECT 1;\nSELECT na| FROM users;\nSELECT 3');
  assert.equal(c.kind, 'column');
  assert.ok(c.tables.some((r) => r.table === 'users'));
});

test('completion: no suggestions inside strings and comments', () => {
  assert.equal(ctxOf("SELECT 'na|").kind, 'none');
  assert.equal(ctxOf('SELECT "na|').kind, 'none');
  assert.equal(ctxOf('SELECT 1 -- na|').kind, 'none');
  assert.equal(ctxOf('SELECT /* na| ').kind, 'none');
});

test('completion: backtick identifiers including incomplete quotes', () => {
  const c1 = ctxOf('FROM `my-db`.|');
  assert.equal(c1.kind, 'table');
  assert.equal(c1.database, 'my-db');

  const c2 = ctxOf('FROM `my|');
  assert.equal(c2.kind, 'table');
  assert.equal(c2.prefix, 'my');
  assert.equal(c2.quoteOpen, true);

  const c3 = ctxOf('SELECT `weird col` , `na| FROM t');
  assert.equal(c3.kind, 'column');
  assert.equal(c3.prefix, 'na');
});

test('completion: none for values and unknown contexts', () => {
  assert.equal(ctxOf('INSERT INTO files VALUES (1, |').kind, 'none');
  assert.equal(ctxOf('SELECT * FROM t LIMIT |').kind, 'none');
  assert.equal(completionContextAt('', 0).kind, 'none');
});
