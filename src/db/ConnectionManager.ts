import * as mysql from 'mysql2/promise';
import { Client } from 'ssh2';
import * as net from 'net';
import * as fs from 'fs';
import { StoredConnection } from '../storage/CredentialStore';

/** MySQL 식별자를 안전하게 백틱으로 감싼다(내부 백틱은 이중화). */
function escapeId(identifier: string): string {
  return '`' + String(identifier).replace(/`/g, '``') + '`';
}

export class ConnectionManager {
  private pool: mysql.Pool | null = null;
  private sshClient: Client | null = null;
  private sshServer: net.Server | null = null;
  private sshLocalPort: number | null = null;
  /** 메타데이터 TTL 캐시(databases/tables/columns 공용). 값은 in-flight Promise를 포함한다. */
  private metaCache = new Map<string, { promise: Promise<any>; expires: number }>();
  /** 자동완성 등 빈번한 조회를 위한 메타데이터 캐시 TTL(ms) */
  private static readonly META_TTL_MS = 30_000;
  /** 연결이 예기치 않게 끊겼을 때 호출(트리 상태 갱신용). 의도적 disconnect에서는 호출하지 않는다. */
  private onClosedCallback?: (reason?: string) => void;

  constructor(private config: StoredConnection) {}

  /** 예기치 않은 연결 끊김을 통지받을 콜백을 등록한다(연결 성공 후 호출). */
  setOnClosed(callback: (reason?: string) => void): void {
    this.onClosedCallback = callback;
  }

  private notifyClosed(reason?: string): void {
    const cb = this.onClosedCallback;
    this.onClosedCallback = undefined;
    if (cb) {
      cb(reason);
    }
  }

  async connect(): Promise<void> {
    const poolConfig: mysql.PoolOptions = {
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      waitForConnections: true,
      connectionLimit: 5,
      rowsAsArray: false,
      // BIGINT 등 2^53 초과 정수를 문자열로 받아 표시·PK 왕복에서 정밀도 손실 방지
      supportBigNumbers: true,
      bigNumberStrings: true,
      // DATE/DATETIME/TIMESTAMP를 서버 형식 문자열 그대로 받아 시간대 밀림·소수초 손실 방지,
      // 두 뷰의 표시 통일, PK/WHERE 왕복 일치 보장
      dateStrings: true,
      // 유휴 커넥션이 서버 wait_timeout으로 죽는 것을 줄이고, 남은 죽은 커넥션은 회수
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
      maxIdle: 2,
      idleTimeout: 60000,
    };

    if (this.config.ssh) {
      const localPort = await this.createSshTunnel();
      poolConfig.host = '127.0.0.1';
      poolConfig.port = localPort;
    } else {
      poolConfig.host = this.config.host;
      poolConfig.port = this.config.port;
    }

    this.pool = mysql.createPool(poolConfig);
    // 풀 생성은 lazy이므로 실제 접속·인증을 검증한다. 실패 시 만든 자원을 정리하고 예외를 전파.
    try {
      await this.pool.query('SELECT 1');
    } catch (err) {
      await this.disconnect();
      throw err;
    }
  }

  get database(): string | undefined {
    return this.config.database;
  }

  async disconnect(): Promise<void> {
    // 의도적 종료이므로 끊김 통지를 막고, pool.end() 실패와 무관하게 SSH 자원을 정리한다.
    this.onClosedCallback = undefined;
    try {
      if (this.pool) {
        await this.pool.end();
      }
    } finally {
      this.pool = null;
      if (this.sshClient) {
        try {
          this.sshClient.end();
        } catch {
          /* 이미 끊긴 경우 무시 */
        }
        this.sshClient = null;
      }
      if (this.sshServer) {
        try {
          this.sshServer.close();
        } catch {
          /* 이미 닫힌 경우 무시 */
        }
        this.sshServer = null;
      }
      this.sshLocalPort = null;
      // 끊긴 연결의 메타데이터 캐시는 재접속 시 새로 조회해야 한다.
      this.metaCache.clear();
    }
  }

  private async createSshTunnel(): Promise<number> {
    const sshConfig = this.config.ssh!;

    // 개인키는 '경로'가 아니라 '내용'을 ssh2에 전달해야 한다. 실패 시 즉시 reject되도록 먼저 읽는다.
    let privateKey: Buffer | undefined;
    if (sshConfig.privateKeyPath) {
      try {
        privateKey = fs.readFileSync(sshConfig.privateKeyPath);
      } catch {
        throw new Error(`SSH 개인키 파일을 읽을 수 없습니다: ${sshConfig.privateKeyPath}`);
      }
    }

    return new Promise<number>((resolve, reject) => {
      let settled = false;
      let ready = false;
      const succeed = (port: number) => {
        if (!settled) {
          settled = true;
          ready = true;
          resolve(port);
        }
      };
      const fail = (err: Error) => {
        if (this.sshServer) {
          try {
            this.sshServer.close();
          } catch {
            /* 무시 */
          }
        }
        if (!settled) {
          settled = true;
          reject(err);
        } else if (ready) {
          // 이미 연결된 뒤 끊긴 경우: 트리에 통지
          this.notifyClosed(err.message);
        }
      };

      this.sshServer = net.createServer((socket) => {
        // pipe는 에러를 전파하지 않으므로 소켓/스트림 각각에 error 핸들러가 없으면 확장 호스트가 크래시한다.
        socket.on('error', () => socket.destroy());
        if (!this.sshClient) {
          socket.end();
          return;
        }
        this.sshClient.forwardOut(
          '127.0.0.1',
          this.sshLocalPort!,
          this.config.host,
          this.config.port,
          (err: Error | undefined, stream: any) => {
            if (err) {
              socket.destroy();
              return;
            }
            stream.on('error', () => socket.destroy());
            socket.pipe(stream).pipe(socket);
          },
        );
      });
      // listen 실패 등 서버 에러도 Promise를 정착시킨다(무한 대기 방지).
      this.sshServer.on('error', (err: Error) => fail(err));

      this.sshServer.listen(0, '127.0.0.1', () => {
        const address = this.sshServer!.address() as net.AddressInfo;
        this.sshLocalPort = address.port;

        this.sshClient = new Client();
        this.sshClient.on('ready', () => succeed(address.port));
        this.sshClient.on('error', (err: Error) => fail(err));
        // 연결 후 끊김 감지 → 트리 상태 갱신
        this.sshClient.on('close', () => {
          if (ready) {
            this.notifyClosed();
          }
        });

        this.sshClient.connect({
          host: sshConfig.host,
          port: sshConfig.port,
          username: sshConfig.username,
          password: sshConfig.password,
          privateKey,
          passphrase: sshConfig.passphrase,
          // NAT/방화벽 유휴 타임아웃으로 조용히 끊기는 것을 방지
          keepaliveInterval: 10000,
          keepaliveCountMax: 3,
        });
      });
    });
  }

  /**
   * TTL 캐시가 적용된 메타데이터 로더. 같은 키의 동시 요청은 하나의 Promise를 공유하고,
   * 실패한 요청은 캐시에서 제거해 다음 호출에서 재시도한다.
   */
  private cachedMeta<T>(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.metaCache.get(key);
    if (hit && hit.expires > now) {
      return hit.promise;
    }
    const promise = load().catch((err) => {
      this.metaCache.delete(key);
      throw err;
    });
    this.metaCache.set(key, { promise, expires: now + ConnectionManager.META_TTL_MS });
    return promise;
  }

  /** DDL 실행·트리 새로고침 등 이후 메타데이터 캐시를 무효화한다. */
  invalidateMetaCache(): void {
    this.metaCache.clear();
  }

  async query(sql: string, params?: any[]): Promise<any[]> {
    if (!this.pool) {
      throw new Error('Not connected');
    }
    try {
      const [rows] = await this.pool.query(sql, params);
      return rows as any[];
    } catch (err: any) {
      // 유휴 중 서버가 끊은 죽은 커넥션을 풀에서 받은 경우: 쿼리는 서버에 도달하지 않았으므로
      // 1회 재시도해도 안전하다(중복 실행 위험 없음).
      if (err?.code === 'PROTOCOL_CONNECTION_LOST' && this.pool) {
        const [rows] = await this.pool.query(sql, params);
        return rows as any[];
      }
      throw err;
    }
  }

  async getDatabases(): Promise<string[]> {
    return this.cachedMeta('databases', async () => {
      const rows = await this.query('SHOW DATABASES');
      return rows.map((row: any) => row.Database);
    });
  }

  async getTables(database: string): Promise<string[]> {
    return this.cachedMeta(`tables:${database}`, async () => {
      const rows = await this.query(
        `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
        [database],
      );
      return rows.map((row: any) => row.TABLE_NAME);
    });
  }

  async getTableColumns(database: string, table: string): Promise<any[]> {
    return this.cachedMeta(`columns:${database}.${table}`, async () => {
      const rows = await this.query(
        `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, EXTRA, COLUMN_COMMENT
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
        [database, table],
      );
      return rows;
    });
  }

  async getPrimaryKeys(database: string, table: string): Promise<string[]> {
    const rows = await this.query(
      `SELECT COLUMN_NAME
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_KEY = 'PRI'
       ORDER BY ORDINAL_POSITION`,
      [database, table],
    );
    return rows.map((row: any) => row.COLUMN_NAME);
  }

  async getTableData(
    database: string,
    table: string,
    offset: number,
    limit: number,
  ): Promise<{
    rows: any[];
    total: number;
  }> {
    const qualifiedTable = `${escapeId(database)}.${escapeId(table)}`;
    const countRows = await this.query(`SELECT COUNT(*) as total FROM ${qualifiedTable}`);
    const total = (countRows[0] as any).total;

    const selectSql = `SELECT * FROM ${qualifiedTable} LIMIT ? OFFSET ?`;
    const rows = await this.query(selectSql, [limit, offset]);

    return { rows, total };
  }

  /**
   * WHERE 절을 만든다. 값이 null이면 `col = ?`(항상 거짓) 대신 `col IS NULL`로 처리해
   * NULL 컬럼이 포함된 행도 매칭되도록 한다.
   */
  private buildWhereClause(keys: Record<string, any>): { clause: string; params: any[] } {
    const clauses: string[] = [];
    const params: any[] = [];
    for (const [key, value] of Object.entries(keys)) {
      if (value === null || value === undefined) {
        clauses.push(`${escapeId(key)} IS NULL`);
      } else {
        clauses.push(`${escapeId(key)} = ?`);
        params.push(value);
      }
    }
    return { clause: clauses.join(' AND '), params };
  }

  private async getColumnNames(database: string, table: string): Promise<Set<string>> {
    // getTableColumns의 TTL 캐시를 재사용한다(자동완성과 동일한 데이터 원천).
    const cols = await this.getTableColumns(database, table);
    return new Set(cols.map((c: any) => c.COLUMN_NAME));
  }

  /** 전달된 컬럼 키가 실제 테이블 컬럼인지 검증한다(신뢰되지 않은 식별자 차단). */
  private async assertColumns(database: string, table: string, keys: string[]): Promise<void> {
    const allowed = await this.getColumnNames(database, table);
    for (const key of keys) {
      if (!allowed.has(key)) {
        throw new Error(`알 수 없는 컬럼입니다: ${key}`);
      }
    }
  }

  async updateRow(
    database: string,
    table: string,
    primaryKeys: Record<string, any>,
    updates: Record<string, any>,
  ): Promise<void> {
    await this.assertColumns(database, table, [
      ...Object.keys(updates),
      ...Object.keys(primaryKeys),
    ]);
    const qualifiedTable = `${escapeId(database)}.${escapeId(table)}`;
    const setClauses = Object.keys(updates)
      .map((key) => `${escapeId(key)} = ?`)
      .join(', ');
    const where = this.buildWhereClause(primaryKeys);

    // LIMIT 1: PK 없는 테이블의 전체 컬럼 매칭에서 동일한 중복 행이 여럿이어도 한 행만 수정
    const sql = `UPDATE ${qualifiedTable} SET ${setClauses} WHERE ${where.clause} LIMIT 1`;
    const params = [...Object.values(updates), ...where.params];
    const result = (await this.query(sql, params)) as unknown as { affectedRows: number };
    // mysql2는 CLIENT_FOUND_ROWS가 기본이라 affectedRows는 '매칭된 행 수'(값 무변경 no-op도 1)
    if (result.affectedRows === 0) {
      throw new Error(
        '수정할 대상 행을 찾지 못했습니다. 다른 세션에서 변경되었거나 조건이 일치하지 않을 수 있습니다.',
      );
    }
  }

  async insertRow(database: string, table: string, values: Record<string, any>): Promise<void> {
    await this.assertColumns(database, table, Object.keys(values));
    const qualifiedTable = `${escapeId(database)}.${escapeId(table)}`;
    const columns = Object.keys(values)
      .map((key) => escapeId(key))
      .join(', ');
    const placeholders = Object.keys(values)
      .map(() => '?')
      .join(', ');

    const sql = `INSERT INTO ${qualifiedTable} (${columns}) VALUES (${placeholders})`;
    await this.query(sql, Object.values(values));
  }

  async deleteRow(
    database: string,
    table: string,
    primaryKeys: Record<string, any>,
  ): Promise<void> {
    await this.assertColumns(database, table, Object.keys(primaryKeys));
    const qualifiedTable = `${escapeId(database)}.${escapeId(table)}`;
    const where = this.buildWhereClause(primaryKeys);

    // LIMIT 1: 항상 한 행만 삭제(호출부는 행 단위로 이 메서드를 호출)
    const sql = `DELETE FROM ${qualifiedTable} WHERE ${where.clause} LIMIT 1`;
    const result = (await this.query(sql, where.params)) as unknown as { affectedRows: number };
    // 0행 삭제도 성공으로 처리하면 '가짜 삭제'(화면에선 사라졌는데 DB에 남음)가 되므로 오류로 알림
    if (result.affectedRows === 0) {
      throw new Error(
        '삭제할 대상 행을 찾지 못했습니다. 다른 세션에서 이미 삭제되었거나 조건이 일치하지 않을 수 있습니다.',
      );
    }
  }
}
