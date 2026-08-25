import { splitStatements, statementAtOffset } from './sqlStatements';

/** 문장 스코프의 테이블 참조(FROM/JOIN/UPDATE/INTO에서 수집) */
export interface TableRef {
  database?: string;
  table?: string;
  alias?: string;
}

export type CompletionKind = 'database' | 'table' | 'column' | 'none';

export interface CompletionContext {
  kind: CompletionKind;
  /** 커서 직전에 입력 중인 식별자 조각(dot 뒤 커서면 빈 문자열) */
  prefix: string;
  /** 원본 문서에서 prefix가 시작하는 오프셋(prefix가 빈 경우 커서 위치) */
  prefixStart: number;
  /** 사용자가 백틱으로 식별자를 열어둔 상태인지 */
  quoteOpen: boolean;
  /** table 문맥에서 명시적으로 한정된 database(예: FROM db.) */
  database?: string;
  /** column 문맥에서 한정에 사용된 테이블(alias가 가리키는 테이블 또는 명시적 한정자) */
  table?: string;
  /** column 문맥에서 사용된 alias 이름 */
  alias?: string;
  /** 현재 문장 스코프의 테이블 목록(column 해석용) */
  tables: TableRef[];
}

interface Token {
  kind: 'word' | 'punct';
  /** word는 따옴표를 벗긴 이름, punct는 한 글자 기호 */
  text: string;
  start: number;
  end: number;
  quoted: boolean;
}

const CLAUSE_KEYWORDS = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'JOIN',
  'ON',
  'GROUP',
  'ORDER',
  'HAVING',
  'LIMIT',
  'SET',
  'UPDATE',
  'INSERT',
  'DELETE',
  'VALUES',
  'USE',
]);

const TABLE_KEYWORDS = new Set(['FROM', 'JOIN', 'UPDATE', 'INSERT', 'INTO', 'TABLE']);
const COLUMN_KEYWORDS = new Set([
  'SELECT',
  'WHERE',
  'ON',
  'GROUP',
  'ORDER',
  'HAVING',
  'SET',
  'AND',
  'OR',
  'NOT',
  'BY',
  'WHEN',
  'THEN',
  'ELSE',
  'DISTINCT',
]);
const DATABASE_KEYWORDS = new Set(['USE']);

/** 이전 키워드 탐색 시 하드 경계로 취급하는 기호(괄호는 서브쿼리 경계) */
const HARD_BOUNDARY = new Set(['(', ')', ';']);

function isWordChar(c: string): boolean {
  return /[A-Za-z0-9_$\u0080-\uFFFF]/.test(c);
}

/** 커서 앞 구간을 토큰화한다. 문자열·주석은 건너뛰고 백틱 식별자는 word로 보존한다. */
function tokenizePrefix(text: string): Token[] {
  const tokens: Token[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];

    if (/\s/.test(c)) {
      i++;
      continue;
    }
    // 라인 주석(-- 또는 #)
    if ((c === '-' && c2 === '-' && (i + 2 >= n || /\s/.test(text[i + 2]))) || c === '#') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    // 블록 주석
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i = Math.min(i + 2, n);
      continue;
    }
    // 문자열 리터럴('...', "...")
    if (c === "'" || c === '"') {
      i++;
      while (i < n) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === c) {
          if (text[i + 1] === c) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // 백틱 식별자. 끝나지 않은 백틱도 입력 중인 토큰이므로 포함한다.
    if (c === '`') {
      const start = i;
      i++;
      let name = '';
      let closed = false;
      while (i < n) {
        if (text[i] === '`') {
          if (text[i + 1] === '`') {
            name += '`';
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        name += text[i];
        i++;
      }
      tokens.push({ kind: 'word', text: name, start, end: i, quoted: true });
      if (!closed) break;
      continue;
    }
    // 일반 단어
    if (isWordChar(c)) {
      const start = i;
      while (i < n && isWordChar(text[i])) i++;
      tokens.push({ kind: 'word', text: text.slice(start, i), start, end: i, quoted: false });
      continue;
    }
    tokens.push({ kind: 'punct', text: c, start: i, end: i + 1, quoted: false });
    i++;
  }
  return tokens;
}

/** 예약어로 보이는 비인용 단어는 식별자 체인에서 제외한다. */
function isReservedWord(t: Token): boolean {
  if (t.kind !== 'word' || t.quoted) return false;
  const upper = t.text.toUpperCase();
  return CLAUSE_KEYWORDS.has(upper) || COLUMN_KEYWORDS.has(upper) || TABLE_KEYWORDS.has(upper);
}

/**
 * 토큰 배열 끝에서 커서 앞 식별자 체인(word ('.' word)*)을 수집한다.
 * chainStartIdx는 체인 바로 앞 토큰의 인덱스(체인이 배열 처음부터면 -1).
 */
function collectChain(
  tokens: Token[],
): { parts: Token[]; chainStartIdx: number; endsWithDot: boolean } | null {
  if (tokens.length === 0) return null;
  let idx = tokens.length - 1;
  let parts: Token[] = [];
  let endsWithDot = false;

  const last = tokens[idx];
  // 커서 바로 앞이 word면 입력 중인 조각, '.'면 dot 뒤 빈 조각이다.
  if (last.kind === 'word' && !isReservedWord(last)) {
    parts = [last];
    idx--;
  } else if (last.kind === 'punct' && last.text === '.') {
    endsWithDot = true;
    idx--;
  } else {
    return null;
  }

  // 뒤에서부터 word / '.' 을 교대로 흡수해 한정 체인을 완성한다.
  let expectWord = endsWithDot;
  for (;;) {
    if (idx < 0) break;
    const t = tokens[idx];
    if (expectWord) {
      if (t.kind === 'word' && !isReservedWord(t)) {
        parts.unshift(t);
        idx--;
        expectWord = false;
      } else {
        break;
      }
    } else {
      if (t.kind === 'punct' && t.text === '.') {
        idx--;
        expectWord = true;
      } else {
        break;
      }
    }
  }

  return { parts, chainStartIdx: idx, endsWithDot };
}

/** 이전 키워드 탐색을 중단시키는 단어(LIMIT 뒤는 값, VALUES 뒤는 리터럴 목록). */
const STOP_WORDS = new Set(['LIMIT', 'VALUES']);

/** 체인 시작 앞에서 가장 가까운 절 키워드를 찾는다. 콤마·연산자·일반 식별자는 건너뛰고 괄호·세미콜론은 경계로 본다. */
function precedingKeyword(tokens: Token[], startIdx: number): string | null {
  for (let i = startIdx; i >= 0; i--) {
    const t = tokens[i];
    if (t.kind === 'punct') {
      if (HARD_BOUNDARY.has(t.text)) return null;
      continue;
    }
    const upper = t.text.toUpperCase();
    if (STOP_WORDS.has(upper)) return null;
    if (CLAUSE_KEYWORDS.has(upper) || COLUMN_KEYWORDS.has(upper)) {
      return upper;
    }
    // 일반 식별자(예: 연산자 우변의 컬럼 참조)는 건너뛰고 계속 탐색한다.
  }
  return null;
}

/** 문장 전체 토큰에서 FROM/JOIN/UPDATE/INTO 영역의 테이블 참조와 alias를 수집한다. */
function collectTablesInScope(tokens: Token[]): TableRef[] {
  const refs: TableRef[] = [];
  const pushRef = (ref: TableRef) => {
    if (
      !refs.some(
        (r) => r.table === ref.table && r.database === ref.database && r.alias === ref.alias,
      )
    ) {
      refs.push(ref);
    }
  };

  const isScopeKeyword = (t: Token) =>
    t.kind === 'word' && ['FROM', 'JOIN', 'UPDATE', 'INTO'].includes(t.text.toUpperCase());

  let i = 0;
  while (i < tokens.length) {
    if (!isScopeKeyword(tokens[i])) {
      i++;
      continue;
    }
    i++;
    // 스코프 키워드 이후 콤마로 이어지는 테이블 참조 나열을 절 키워드 전까지 읽는다.
    while (i < tokens.length) {
      const tok = tokens[i];
      if (tok.kind === 'punct' && tok.text === ',') {
        i++;
        continue;
      }
      if (tok.kind !== 'word') break;

      const first = tok;
      let tableTok: Token = tok;
      if (
        i + 2 < tokens.length &&
        tokens[i + 1].kind === 'punct' &&
        tokens[i + 1].text === '.' &&
        tokens[i + 2].kind === 'word'
      ) {
        tableTok = tokens[i + 2];
        i += 3;
      } else {
        i += 1;
      }

      // AS? alias
      let alias: string | undefined;
      if (i < tokens.length && tokens[i].kind === 'word' && tokens[i].text.toUpperCase() === 'AS') {
        i++;
      }
      if (
        i < tokens.length &&
        tokens[i].kind === 'word' &&
        !CLAUSE_KEYWORDS.has(tokens[i].text.toUpperCase()) &&
        tokens[i].text.toUpperCase() !== 'AS'
      ) {
        alias = tokens[i].text;
        i++;
      }

      pushRef({
        database: first === tableTok ? undefined : first.text,
        table: tableTok.text,
        alias,
      });

      if (!(i < tokens.length && tokens[i].kind === 'punct' && tokens[i].text === ',')) {
        break;
      }
    }
  }
  return refs;
}

/** 커서가 문자열/주석 내부(또는 미종결 문자열 진입 중)인지. 미종결 백틱은 식별자 입력으로 본다. */
function insideLiteralOrComment(prefix: string): boolean {
  const n = prefix.length;
  let i = 0;
  type State = 'code' | 'line-comment' | 'block-comment' | 'string' | 'backtick';
  let state: State = 'code';
  let quote = '';
  while (i < n) {
    const c = prefix[i];
    const c2 = prefix[i + 1];
    switch (state) {
      case 'code':
        if ((c === '-' && c2 === '-' && (i + 2 >= n || /\s/.test(prefix[i + 2]))) || c === '#') {
          state = 'line-comment';
          i++;
          continue;
        }
        if (c === '/' && c2 === '*') {
          state = 'block-comment';
          i += 2;
          continue;
        }
        if (c === "'" || c === '"') {
          state = 'string';
          quote = c;
          i++;
          continue;
        }
        if (c === '`') {
          state = 'backtick';
          i++;
          continue;
        }
        i++;
        break;
      case 'line-comment':
        if (c === '\n') state = 'code';
        i++;
        break;
      case 'block-comment':
        if (c === '*' && c2 === '/') {
          state = 'code';
          i += 2;
        }
        i++;
        break;
      case 'string':
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === quote) {
          if (prefix[i + 1] === quote) {
            i += 2;
            continue;
          }
          state = 'code';
        }
        i++;
        break;
      case 'backtick':
        if (c === '`') {
          if (prefix[i + 1] === '`') {
            i += 2;
            continue;
          }
          state = 'code';
        }
        i++;
        break;
    }
  }
  return state === 'string' || state === 'block-comment' || state === 'line-comment';
}

/**
 * 문서 전체 텍스트와 커서 오프셋으로 자동완성 문맥을 계산한다.
 * 순수 함수이므로 VS Code 런타임 없이 단위 테스트할 수 있다.
 */
export function completionContextAt(sql: string, offset: number): CompletionContext {
  const base = (over: Partial<CompletionContext> = {}): CompletionContext => ({
    kind: 'none',
    prefix: '',
    prefixStart: offset,
    quoteOpen: false,
    tables: [],
    ...over,
  });

  const statements = splitStatements(sql);
  const stmt = statementAtOffset(statements, offset);
  if (!stmt) return base();

  const relEnd = Math.max(stmt.start, Math.min(offset, stmt.end));
  const prefixText = sql.slice(stmt.start, relEnd);

  if (insideLiteralOrComment(prefixText)) return base();

  const tokens = tokenizePrefix(prefixText);
  const tables = collectTablesInScope(tokenizePrefix(sql.slice(stmt.start, stmt.end)));

  const chain = collectChain(tokens);
  if (chain) {
    const { parts, chainStartIdx, endsWithDot } = chain;
    const last = parts[parts.length - 1];
    const prefix = endsWithDot ? '' : (last?.text ?? '');
    const prefixStart = endsWithDot ? relEnd : (last?.start ?? relEnd);
    const quoteOpen = parts.some((p) => p.quoted);
    const kw = precedingKeyword(tokens, chainStartIdx);

    if (kw && DATABASE_KEYWORDS.has(kw)) {
      return base({ kind: 'database', prefix, prefixStart, quoteOpen, tables });
    }

    // 3단계(db.table.col 또는 db.table.) → column
    if (endsWithDot ? parts.length >= 2 : parts.length >= 3) {
      const db = endsWithDot ? parts[parts.length - 2]?.text : parts[parts.length - 3]?.text;
      const tbl = endsWithDot ? last?.text : parts[parts.length - 2]?.text;
      return base({
        kind: 'column',
        prefix,
        prefixStart,
        quoteOpen,
        database: db,
        table: tbl,
        tables,
      });
    }

    // 2단계(db.table. 또는 alias./table.)
    if (parts.length === (endsWithDot ? 1 : 2)) {
      const qualifier = parts[0]?.text;
      if (kw && TABLE_KEYWORDS.has(kw)) {
        return base({
          kind: 'table',
          prefix,
          prefixStart,
          quoteOpen,
          database: qualifier,
          tables,
        });
      }
      const byAlias = tables.find((r) => r.alias === qualifier);
      return base({
        kind: 'column',
        prefix,
        prefixStart,
        quoteOpen,
        alias: byAlias ? qualifier : undefined,
        database: byAlias?.database,
        table: byAlias ? byAlias.table : qualifier,
        tables,
      });
    }

    // 1단계(한정 없음)
    if (kw && TABLE_KEYWORDS.has(kw)) {
      return base({ kind: 'table', prefix, prefixStart, quoteOpen, tables });
    }
    if (kw && COLUMN_KEYWORDS.has(kw)) {
      return base({ kind: 'column', prefix, prefixStart, quoteOpen, tables });
    }
    return base({ prefix, prefixStart, quoteOpen, tables });
  }

  // 커서에 바로 붙어 입력 중인 단어가 예약어 접두와 겹치는 경우(or, use 등)에는
  // 그 앞의 절 키워드를 문맥 근거로 쓴다. 공백 뒤 완성된 키워드는 그 자체가 근거다.
  const startIdx = tokens.length - 1;
  const lastTok = tokens[startIdx];
  // 커서와 마지막 토큰 사이에 공백이 없을 때만 "입력 중인 단어"로 본다.
  // 문장 끝 공백은 splitStatements에서 잘려나가므로 실제 커서 오프셋과 비교한다.
  const gap = lastTok ? sql.slice(stmt.start + lastTok.end, Math.max(offset, relEnd)) : '';
  const adjacentToCursor = gap.trim().length === 0 && gap.length === 0;
  const collidesWithKeyword =
    !!lastTok &&
    adjacentToCursor &&
    lastTok.kind === 'word' &&
    !lastTok.quoted &&
    (CLAUSE_KEYWORDS.has(lastTok.text.toUpperCase()) ||
      COLUMN_KEYWORDS.has(lastTok.text.toUpperCase()));
  const kw = precedingKeyword(tokens, collidesWithKeyword ? startIdx - 1 : startIdx);
  // 체인으로 수집되지 않은 입력 중인 단어도 교체 범위(prefix)로는 유지한다.
  const typingPrefix =
    lastTok && lastTok.kind === 'word' && adjacentToCursor
      ? { prefix: lastTok.text, prefixStart: stmt.start + lastTok.start }
      : {};
  if (kw && DATABASE_KEYWORDS.has(kw)) {
    return base({ kind: 'database', tables, ...typingPrefix });
  }
  if (kw && TABLE_KEYWORDS.has(kw)) {
    return base({ kind: 'table', tables, ...typingPrefix });
  }
  if (kw && COLUMN_KEYWORDS.has(kw)) {
    return base({ kind: 'column', tables, ...typingPrefix });
  }
  return base(typingPrefix);
}
