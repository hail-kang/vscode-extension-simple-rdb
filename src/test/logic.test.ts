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
