import * as vscode from 'vscode';
import * as path from 'path';

export class SqlFileStorage {
  private static readonly KEY = 'simple-rdb-sql-files';

  constructor(private context: vscode.ExtensionContext) {}

  getSqlFileNames(): string[] {
    return this.context.globalState.get<string[]>(SqlFileStorage.KEY, []);
  }

  async createSqlFile(name: string): Promise<string> {
    const files = this.getSqlFileNames();
    if (!name.endsWith('.sql')) {
      name += '.sql';
    }
    if (files.includes(name)) {
      name = name.replace(/\.sql$/, `_${Date.now()}.sql`);
    }
    files.push(name);
    await this.context.globalState.update(SqlFileStorage.KEY, files);
    return name;
  }

  async deleteSqlFile(name: string): Promise<void> {
    const files = this.getSqlFileNames();
    await this.context.globalState.update(
      SqlFileStorage.KEY,
      files.filter((f) => f !== name),
    );
  }

  async saveContent(name: string, content: string): Promise<void> {
    await this.context.globalState.update(`simple-rdb-sql-content:${name}`, content);
  }

  getContent(name: string): string {
    return this.context.globalState.get<string>(`simple-rdb-sql-content:${name}`, '');
  }

  async rename(oldName: string, newName: string): Promise<void> {
    const content = this.getContent(oldName);
    await this.saveContent(newName, content);
    await this.context.globalState.update(`simple-rdb-sql-content:${oldName}`, undefined);

    const files = this.getSqlFileNames();
    const idx = files.indexOf(oldName);
    if (idx >= 0) {
      files[idx] = newName;
      await this.context.globalState.update(SqlFileStorage.KEY, files);
    }
  }
}
