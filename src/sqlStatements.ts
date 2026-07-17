export interface SqlStatement {
  /** 세미콜론과 앞뒤 공백을 제거한 문장 텍스트 */
  text: string;
  /** 원본 문자열에서 문장이 시작하는 오프셋 */
  start: number;
  /** 원본 문자열에서 문장이 끝나는 오프셋(세미콜론 앞, exclusive) */
  end: number;
}

/**
 * 문자열 리터럴('...', "..."), 백틱 식별자, 주석(--, #, /* *\/)의 내용을 같은 길이의 공백으로
 * 치환한다. 결과는 원본과 길이·오프셋이 동일하므로, 세미콜론 분리나 키워드 스캔 시
 * 리터럴 내부 문자에 속지 않게 된다. SELECT/FROM 등 키워드는 그대로 보존된다.
 */
export function maskLiteralsAndComments(sql: string): string {
  const out: string[] = [];
  const n = sql.length;
  let i = 0;
  const SP = ' ';
  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];

    // 라인 주석: `-- ` 또는 `--`<EOL>, 그리고 `#`
    if (c === '-' && c2 === '-' && (i + 2 >= n || /\s/.test(sql[i + 2]))) {
      while (i < n && sql[i] !== '\n') {
        out.push(SP);
        i++;
      }
      continue;
    }
    if (c === '#') {
      while (i < n && sql[i] !== '\n') {
        out.push(SP);
        i++;
      }
      continue;
    }

    // 블록 주석
    if (c === '/' && c2 === '*') {
      out.push(SP, SP);
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) {
        out.push(sql[i] === '\n' ? '\n' : SP);
        i++;
      }
      if (i < n) {
        out.push(SP, SP);
        i += 2;
      }
      continue;
    }

    // 문자열/백틱 리터럴
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out.push(SP);
      i++;
      while (i < n) {
        const ch = sql[i];
        // 백틱은 백슬래시 이스케이프가 없다
        if (ch === '\\' && quote !== '`') {
          out.push(SP);
          i++;
          if (i < n) {
            out.push(SP);
            i++;
          }
          continue;
        }
        if (ch === quote) {
          if (sql[i + 1] === quote) {
            // 이중 인용부호로 이스케이프된 인용부호
            out.push(SP, SP);
            i += 2;
            continue;
          }
          out.push(SP);
          i++;
          break;
        }
        out.push(ch === '\n' ? '\n' : SP);
        i++;
      }
      continue;
    }

    out.push(c);
    i++;
  }
  return out.join('');
}

/** 세미콜론(문자열/주석 밖) 기준으로 문장을 분리한다. 빈 문장은 제외한다. */
export function splitStatements(sql: string): SqlStatement[] {
  const masked = maskLiteralsAndComments(sql);
  const statements: SqlStatement[] = [];
  let start = 0;
  for (let i = 0; i <= masked.length; i++) {
    if (i === masked.length || masked[i] === ';') {
      const segment = sql.slice(start, i);
      if (segment.trim().length > 0) {
        const leading = segment.length - segment.trimStart().length;
        const trailing = segment.length - segment.trimEnd().length;
        statements.push({
          text: segment.trim(),
          start: start + leading,
          end: i - trailing,
        });
      }
      start = i + 1;
    }
  }
  return statements;
}

/** 주어진 오프셋(커서 위치)을 포함하는 문장을 반환한다. 경계 밖이면 가장 가까운 앞 문장을 반환. */
export function statementAtOffset(
  statements: SqlStatement[],
  offset: number,
): SqlStatement | undefined {
  if (statements.length === 0) {
    return undefined;
  }
  for (const s of statements) {
    if (offset >= s.start && offset <= s.end) {
      return s;
    }
  }
  let candidate: SqlStatement | undefined;
  for (const s of statements) {
    if (s.start <= offset) {
      candidate = s;
    }
  }
  return candidate ?? statements[0];
}

/** 문장에 (문자열/주석 밖) LIMIT 절이 있는지. */
export function hasLimitClause(sql: string): boolean {
  return /\blimit\b/i.test(maskLiteralsAndComments(sql));
}

/** 최상위가 단일 SELECT 문인지(자동 LIMIT 부착 대상 판별용, 보수적으로 판단). */
export function isPlainSelect(sql: string): boolean {
  const masked = maskLiteralsAndComments(sql).trim();
  if (!/^select\b/i.test(masked)) {
    return false;
  }
  // UNION이 있으면 트레일링 LIMIT의 적용 범위가 모호하므로 대상에서 제외
  if (/\bunion\b/i.test(masked)) {
    return false;
  }
  return true;
}
