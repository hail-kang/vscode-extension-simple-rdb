interface ParsedQuery {
  editable: boolean;
  reason?: string;
  database: string | null;
  table: string | null;
  columns: string[];
}

export function parseSqlForEditability(sql: string): ParsedQuery {
  const trimmed = sql.trim();
  const upper = trimmed.toUpperCase();

  if (upper.startsWith('SELECT') !== true) {
    return {
      editable: false,
      reason: 'Non-SELECT query',
      database: null,
      table: null,
      columns: [],
    };
  }

  if (upper.includes(' UNION ') || upper.includes(' UNION\n')) {
    return { editable: false, reason: 'UNION query', database: null, table: null, columns: [] };
  }

  if (countOccurrences(upper, /\bSELECT\b/g) > 1) {
    return { editable: false, reason: 'Subquery', database: null, table: null, columns: [] };
  }

  if (/GROUP\s+BY/i.test(upper)) {
    return { editable: false, reason: 'GROUP BY', database: null, table: null, columns: [] };
  }

  if (
    /\b(?:COUNT|SUM|AVG|MAX|MIN|GROUP_CONCAT)\s*\(/i.test(upper) &&
    !/COUNT\s*\(\s*\*\s*\)/i.test(upper)
  ) {
    return {
      editable: false,
      reason: 'Aggregate function',
      database: null,
      table: null,
      columns: [],
    };
  }

  const fromIdx = findKeyword(upper, 'FROM');
  if (fromIdx === -1) {
    return { editable: false, reason: 'No FROM clause', database: null, table: null, columns: [] };
  }

  const joinIdx = findKeyword(upper, 'JOIN', fromIdx);
  if (joinIdx !== -1 && joinIdx < upper.length) {
    return { editable: false, reason: 'JOIN query', database: null, table: null, columns: [] };
  }

  const parsed = extractDbTable(trimmed, fromIdx);
  if (!parsed) {
    return {
      editable: false,
      reason: 'Cannot parse table',
      database: null,
      table: null,
      columns: [],
    };
  }

  return {
    editable: true,
    reason: undefined,
    database: parsed.db,
    table: parsed.table,
    columns: [],
  };
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
  const after = idx + keyword.length >= str.length || /\s|\(|;|\n/.test(str[idx + keyword.length]);
  return before && after;
}

function extractDbTable(sql: string, fromIdx: number): { db: string | null; table: string } | null {
  const rest = sql.slice(fromIdx + 4).trim();
  const spaceIdx = rest.search(/\s|;|\(|$|\n/);
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

function countOccurrences(str: string, pattern: RegExp): number {
  return (str.match(pattern) || []).length;
}
