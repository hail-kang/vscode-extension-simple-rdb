import { maskLiteralsAndComments } from './sqlStatements';

interface ParsedQuery {
  editable: boolean;
  reason?: string;
  database: string | null;
  table: string | null;
  columns: string[];
}

function readOnly(reason: string): ParsedQuery {
  return { editable: false, reason, database: null, table: null, columns: [] };
}

export function parseSqlForEditability(sql: string): ParsedQuery {
  const trimmed = sql.trim();
  // 주석·문자열·백틱 내용을 공백으로 마스킹한 버전으로 키워드를 스캔한다(길이·오프셋 동일).
  const masked = maskLiteralsAndComments(trimmed);
  const upper = masked.toUpperCase();

  if (!/^\s*SELECT\b/.test(upper)) {
    return readOnly('Non-SELECT query');
  }
  if (/\bUNION\b/.test(upper)) {
    return readOnly('UNION query');
  }
  if ((upper.match(/\bSELECT\b/g) || []).length > 1) {
    return readOnly('Subquery');
  }
  if (/\bGROUP\s+BY\b/.test(upper)) {
    return readOnly('GROUP BY');
  }
  if (
    /\b(?:COUNT|SUM|AVG|MAX|MIN|GROUP_CONCAT)\s*\(/.test(upper) &&
    !/COUNT\s*\(\s*\*\s*\)/.test(upper)
  ) {
    return readOnly('Aggregate function');
  }

  const fromIdx = findKeyword(upper, 'FROM');
  if (fromIdx === -1) {
    return readOnly('No FROM clause');
  }
  if (/\bSTRAIGHT_JOIN\b/.test(upper)) {
    return readOnly('JOIN query');
  }
  if (findKeyword(upper, 'JOIN', fromIdx) !== -1) {
    return readOnly('JOIN query');
  }

  // FROM 절(다음 상위 절 키워드 전까지)에 콤마가 있으면 다중 테이블(콤마 조인)이다.
  const clauseEnd = nextClauseIndex(upper, fromIdx + 4);
  if (upper.slice(fromIdx + 4, clauseEnd).includes(',')) {
    return readOnly('Multi-table query');
  }

  const parsed = extractDbTable(trimmed, fromIdx);
  if (!parsed) {
    return readOnly('Cannot parse table');
  }

  return {
    editable: true,
    reason: undefined,
    database: parsed.db,
    table: parsed.table,
    columns: [],
  };
}

function nextClauseIndex(upper: string, from: number): number {
  let min = upper.length;
  for (const keyword of ['WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT']) {
    const idx = findKeyword(upper, keyword, from);
    if (idx !== -1 && idx < min) {
      min = idx;
    }
  }
  return min;
}

function findKeyword(upper: string, keyword: string, startFrom = 0): number {
  const pattern = new RegExp(`\\b${keyword}\\b`, 'i');
  let idx = startFrom;
  while (idx < upper.length) {
    const match = pattern.exec(upper.slice(idx));
    if (!match) return -1;
    const absIdx = idx + match.index;
    if (isKeyword(upper, absIdx, keyword)) {
      return absIdx;
    }
    idx = absIdx + keyword.length;
  }
  return -1;
}

function isKeyword(str: string, idx: number, keyword: string): boolean {
  const before = idx === 0 || /\s|\(|,/.test(str[idx - 1]);
  const after =
    idx + keyword.length >= str.length || /\s|\(|;|\n|,/.test(str[idx + keyword.length]);
  return before && after;
}

function extractDbTable(sql: string, fromIdx: number): { db: string | null; table: string } | null {
  const rest = sql.slice(fromIdx + 4).trim();
  const spaceIdx = rest.search(/\s|;|\(|,|$|\n/);
  if (spaceIdx <= 0) return null;
  let raw = rest.slice(0, spaceIdx).trim();
  raw = raw.replace(/`/g, '');

  if (raw.includes('.')) {
    const parts = raw.split('.');
    if (
      parts.length === 2 &&
      /^[a-zA-Z0-9_]+$/.test(parts[0]) &&
      /^[a-zA-Z0-9_]+$/.test(parts[1])
    ) {
      return { db: parts[0], table: parts[1] };
    }
    return null;
  }

  if (/^[a-zA-Z0-9_]+$/.test(raw)) {
    return { db: null, table: raw };
  }

  return null;
}
