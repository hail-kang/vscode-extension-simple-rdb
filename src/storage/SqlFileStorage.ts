import * as vscode from 'vscode';

export class SqlFileStorage {
  constructor(private context: vscode.ExtensionContext) {}

  getSqlFileNames(connectionId: string): string[] {
    return this.context.globalState.get<string[]>(`simple-rdb-sql-files:${connectionId}`, []);
  }

  async createSqlFile(connectionId: string, name: string): Promise<string> {
    const files = this.getSqlFileNames(connectionId);
    if (!name.endsWith('.sql')) {
      name += '.sql';
    }
    if (files.includes(name)) {
      name = name.replace(/\.sql$/, `_${Date.now()}.sql`);
    }
    files.push(name);
    await this.context.globalState.update(`simple-rdb-sql-files:${connectionId}`, files);
    return name;
  }

  async deleteSqlFile(connectionId: string, name: string): Promise<void> {
    const files = this.getSqlFileNames(connectionId);
    await this.context.globalState.update(
      `simple-rdb-sql-files:${connectionId}`,
      files.filter((f) => f !== name),
    );
    await this.context.globalState.update(
      `simple-rdb-sql-content:${connectionId}:${name}`,
      undefined,
    );
  }

  async saveContent(connectionId: string, name: string, content: string): Promise<void> {
    await this.context.globalState.update(
      `simple-rdb-sql-content:${connectionId}:${name}`,
      content,
    );
  }

  getContent(connectionId: string, name: string): string {
    return this.context.globalState.get<string>(
      `simple-rdb-sql-content:${connectionId}:${name}`,
      '',
    );
  }
}
