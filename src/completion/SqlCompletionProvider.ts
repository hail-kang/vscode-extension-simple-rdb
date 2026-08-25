import * as vscode from 'vscode';
import { ConnectionTreeProvider } from '../tree/ConnectionTreeProvider';
import { SqlFileStorage } from '../storage/SqlFileStorage';
import { ConnectionManager } from '../db/ConnectionManager';
import { completionContextAt, CompletionContext, TableRef } from '../sqlCompletionContext';

/**
 * Simple RDB가 관리하는 SQL 파일용 자동완성 provider.
 * 활성 연결의 메타데이터로 database / table / column 제안을 생성한다.
 */
export class SqlCompletionProvider implements vscode.CompletionItemProvider {
  constructor(
    private treeProvider: ConnectionTreeProvider,
    private sqlStorage: SqlFileStorage,
  ) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.CompletionItem[]> {
    const connectionId = this.sqlStorage.connectionIdFromPath(document.uri.fsPath);
    if (!connectionId) {
      return [];
    }
    const manager = this.treeProvider.getActiveConnection(connectionId);
    if (!manager || token.isCancellationRequested) {
      return [];
    }

    let ctx: CompletionContext;
    try {
      ctx = completionContextAt(document.getText(), document.offsetAt(position));
    } catch {
      return [];
    }

    try {
      switch (ctx.kind) {
        case 'database':
          return await this.databaseItems(manager, ctx, document, position);
        case 'table':
          return await this.tableItems(manager, ctx, document, position);
        case 'column':
          return await this.columnItems(manager, ctx, document, position);
        default:
          return [];
      }
    } catch {
      // 메타데이터 조회 실패 시 타이핑마다 에러 팝업을 띄우지 않고 조용히 빈 목록을 반환한다.
      return [];
    }
  }

  private async databaseItems(
    manager: ConnectionManager,
    ctx: CompletionContext,
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[]> {
    const range = replacementRange(ctx, document, position);
    const databases = await manager.getDatabases();
    return databases.map((db) => {
      const item = new vscode.CompletionItem(db, vscode.CompletionItemKind.Module);
      item.detail = 'Database';
      item.range = range;
      item.insertText = quoteIdentifierIfNeeded(db, ctx.quoteOpen);
      return item;
    });
  }

  private async tableItems(
    manager: ConnectionManager,
    ctx: CompletionContext,
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[]> {
    const items: vscode.CompletionItem[] = [];
    const range = replacementRange(ctx, document, position);
    const defaultDb = manager.database;

    // 한정 없이 입력 중이면 기본 데이터베이스의 테이블을 먼저 제안한다.
    if (!ctx.database && defaultDb) {
      for (const t of await manager.getTables(defaultDb)) {
        items.push(this.tableItem(t, undefined, range, ctx.quoteOpen));
      }
    }

    // `db.` 한정 입력이 아니면 database 이름도 제안한다(한정 입력으로 이어짐).
    if (!ctx.database && !ctx.quoteOpen) {
      const databases = await manager.getDatabases();
      for (const db of databases) {
        if (defaultDb && db === defaultDb && ctx.prefix === '') {
          // 기본 DB 테이블 제안과 중복 노출되지 않도록 빈 prefix에서는 생략한다.
          continue;
        }
        const item = new vscode.CompletionItem(db, vscode.CompletionItemKind.Module);
        item.detail = 'Database';
        item.range = range;
        item.insertText = quoteIdentifierIfNeeded(db, false) + '.';
        items.push(item);
      }
    }

    if (ctx.database) {
      for (const t of await manager.getTables(ctx.database)) {
        items.push(this.tableItem(t, ctx.database, range, ctx.quoteOpen));
      }
    }

    return items;
  }

  private tableItem(
    table: string,
    database: string | undefined,
    range: vscode.Range,
    quoteOpen: boolean,
  ): vscode.CompletionItem {
    const label = database ? `${database}.${table}` : table;
    const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Struct);
    item.detail = database ? `Table (${database})` : 'Table';
    item.range = range;
    item.insertText = quoteIdentifierIfNeeded(table, quoteOpen);
    return item;
  }

  private async columnItems(
    manager: ConnectionManager,
    ctx: CompletionContext,
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[]> {
    const range = replacementRange(ctx, document, position);

    // 명시적 한정자(db.table., alias.)가 있으면 해당 테이블만,
    // 없으면 문장 스코프의 모든 테이블 컬럼을 병합한다.
    let targets: TableRef[];
    if (ctx.table) {
      targets = [{ database: ctx.database, table: ctx.table, alias: ctx.alias }];
    } else if (ctx.tables.length > 0) {
      targets = ctx.tables;
    } else {
      const defaultDb = manager.database;
      if (!defaultDb) {
        return [];
      }
      targets = [{ database: defaultDb }];
    }

    const seen = new Set<string>();
    const items: vscode.CompletionItem[] = [];
    for (const ref of targets) {
      const db = ref.database ?? manager.database;
      if (!db || !ref.table) continue;
      const columns = await manager.getTableColumns(db, ref.table);
      for (const col of columns as Record<string, any>[]) {
        const name = col.COLUMN_NAME as string;
        const key = `${db}.${ref.table}.${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(this.columnItem(name, col, range));
      }
    }
    return items;
  }

  private columnItem(
    name: string,
    col: Record<string, any>,
    range: vscode.Range,
  ): vscode.CompletionItem {
    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Field);
    const parts: string[] = [String(col.COLUMN_TYPE ?? col.DATA_TYPE ?? '')];
    if (col.COLUMN_KEY === 'PRI') parts.push('PK');
    else if (col.COLUMN_KEY === 'UNI') parts.push('UNIQUE');
    parts.push(col.IS_NULLABLE === 'YES' ? 'NULL' : 'NOT NULL');
    item.detail = parts.filter(Boolean).join(' · ');
    if (col.COLUMN_COMMENT) {
      item.documentation = new vscode.MarkdownString(String(col.COLUMN_COMMENT));
    }
    if (col.COLUMN_KEY === 'PRI') {
      item.preselect = true;
    }
    item.range = range;
    item.insertText = quoteIdentifierIfNeeded(name, false);
    return item;
  }
}

/** 특수문자가 포함된 식별자는 백틱으로 감싸 삽입한다(사용자가 이미 백틱을 연 경우 그대로). */
function quoteIdentifierIfNeeded(name: string, quoteOpen: boolean): string {
  if (quoteOpen || /^[A-Za-z0-9_$]+$/.test(name)) {
    return name;
  }
  return '`' + name.replace(/`/g, '``') + '`';
}

function replacementRange(
  ctx: CompletionContext,
  document: vscode.TextDocument,
  position: vscode.Position,
): vscode.Range {
  const start = document.positionAt(ctx.prefixStart);
  const end = ctx.prefix.length > 0 ? position : start;
  return new vscode.Range(start, end);
}
