import * as mysql from 'mysql2/promise';
import { Client } from 'ssh2';
import * as net from 'net';
import { StoredConnection } from '../storage/CredentialStore';

export class ConnectionManager {
  private pool: mysql.Pool | null = null;
  private sshClient: Client | null = null;
  private sshServer: net.Server | null = null;
  private sshLocalPort: number | null = null;

  constructor(private config: StoredConnection) {}

  async connect(): Promise<void> {
    const poolConfig: mysql.PoolOptions = {
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      waitForConnections: true,
      connectionLimit: 5,
      rowsAsArray: false,
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
  }

  get database(): string | undefined {
    return this.config.database;
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
    if (this.sshClient) {
      this.sshClient.end();
      this.sshClient = null;
    }
    if (this.sshServer) {
      this.sshServer.close();
      this.sshServer = null;
    }
    this.sshLocalPort = null;
  }

  private async createSshTunnel(): Promise<number> {
    const sshConfig = this.config.ssh!;

    return new Promise<number>((resolve, reject) => {
      this.sshServer = net.createServer((socket) => {
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
              socket.end();
              return;
            }
            socket.pipe(stream).pipe(socket);
          },
        );
      });

      this.sshServer.listen(0, '127.0.0.1', () => {
        const address = this.sshServer!.address() as net.AddressInfo;
        this.sshLocalPort = address.port;

        this.sshClient = new Client();
        this.sshClient.on('ready', () => {
          resolve(address.port);
        });
        this.sshClient.on('error', (err: Error) => {
          this.sshServer!.close();
          reject(err);
        });

        this.sshClient.connect({
          host: sshConfig.host,
          port: sshConfig.port,
          username: sshConfig.username,
          password: sshConfig.password,
          privateKey: sshConfig.privateKey,
          passphrase: sshConfig.passphrase,
        });
      });
    });
  }

  async query(sql: string, params?: any[]): Promise<any[]> {
    if (!this.pool) {
      throw new Error('Not connected');
    }
    const [rows] = await this.pool.query(sql, params);
    return rows as any[];
  }

  async getDatabases(): Promise<string[]> {
    const rows = await this.query('SHOW DATABASES');
    return rows.map((row: any) => row.Database);
  }

  async getTables(database: string): Promise<string[]> {
    const rows = await this.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
      [database],
    );
    return rows.map((row: any) => row.TABLE_NAME);
  }

  async getTableColumns(database: string, table: string): Promise<any[]> {
    const rows = await this.query(
      `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, EXTRA, COLUMN_COMMENT
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [database, table],
    );
    return rows;
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
    const qualifiedTable = `\`${database}\`.\`${table}\``;
    const [countRows] = await this.query(`SELECT COUNT(*) as total FROM ${qualifiedTable}`);
    const total = (countRows as any[])[0].total;

    const selectSql = `SELECT * FROM ${qualifiedTable} LIMIT ? OFFSET ?`;
    const rows = await this.query(selectSql, [limit, offset]);

    return { rows, total };
  }

  async updateRow(
    database: string,
    table: string,
    primaryKeys: Record<string, any>,
    updates: Record<string, any>,
  ): Promise<void> {
    const qualifiedTable = `\`${database}\`.\`${table}\``;
    const setClauses = Object.keys(updates)
      .map((key) => `\`${key}\` = ?`)
      .join(', ');
    const whereClauses = Object.keys(primaryKeys)
      .map((key) => `\`${key}\` = ?`)
      .join(' AND ');

    const sql = `UPDATE ${qualifiedTable} SET ${setClauses} WHERE ${whereClauses}`;
    const params = [...Object.values(updates), ...Object.values(primaryKeys)];
    await this.query(sql, params);
  }

  async insertRow(database: string, table: string, values: Record<string, any>): Promise<void> {
    const qualifiedTable = `\`${database}\`.\`${table}\``;
    const columns = Object.keys(values)
      .map((key) => `\`${key}\``)
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
    const qualifiedTable = `\`${database}\`.\`${table}\``;
    const whereClauses = Object.keys(primaryKeys)
      .map((key) => `\`${key}\` = ?`)
      .join(' AND ');

    const sql = `DELETE FROM ${qualifiedTable} WHERE ${whereClauses}`;
    await this.query(sql, Object.values(primaryKeys));
  }
}
