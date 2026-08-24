import * as vscode from 'vscode';
import { ConnectionTreeProvider } from './tree/ConnectionTreeProvider';
import { CredentialStore } from './storage/CredentialStore';
import { TableViewProvider } from './webview/TableViewProvider';
import { QueryResultProvider, QueryEditContext } from './webview/QueryResultProvider';
import { parseSqlForEditability } from './sqlParser';
import { splitStatements, statementAtOffset, isPlainSelect, hasLimitClause } from './sqlStatements';
import { showConnectionDialog } from './webview/ConnectionDialog';
import { TableNode, SqlFileNode, SqlFileGroupNode } from './tree/TreeNodes';

/** SELECT에 LIMIT이 없을 때 자동으로 부착하는 기본 행 수(대용량 결과로 인한 프리즈 방지). */
const DEFAULT_ROW_LIMIT = 1000;

type QueryManager = {
  query(sql: string): Promise<any[]>;
  getPrimaryKeys(database: string, table: string): Promise<string[]>;
  database?: string;
};

type ShowResult = (
  columns: string[],
  rows: Record<string, any>[],
  sql: string,
  editContext?: QueryEditContext,
  readonlyReason?: string,
) => void;

/**
 * 문장 목록을 순차 실행한다. 행을 반환하는 마지막 문장은 결과 그리드로 표시하고,
 * DML 문장은 영향받은 행 수를 알린다. SELECT에 LIMIT이 없으면 자동으로 부착한다.
 */
export async function executeStatements(
  manager: QueryManager,
  statements: { text: string }[],
  defaultDatabase: string | undefined,
  show: ShowResult,
  notify: (message: string) => void = (m) => vscode.window.showInformationMessage(m),
  rowLimit: number = DEFAULT_ROW_LIMIT,
): Promise<void> {
  let shownGrid = false;
  const dmlMessages: string[] = [];
  let sawEmptySelect = false;

  for (const stmt of statements) {
    const parsed = parseSqlForEditability(stmt.text);
    let sqlToRun = stmt.text;
    let limitApplied = false;
    if (rowLimit > 0 && isPlainSelect(stmt.text) && !hasLimitClause(stmt.text)) {
      sqlToRun = `${stmt.text}\nLIMIT ${rowLimit}`;
      limitApplied = true;
    }

    const results = await manager.query(sqlToRun);

    if (Array.isArray(results)) {
      if (results.length > 0) {
        const columns = Object.keys(results[0] as object);
        let editContext: QueryEditContext | undefined;
        if (parsed.editable && parsed.table) {
          const pks = await manager.getPrimaryKeys(
            parsed.database || defaultDatabase || '',
            parsed.table,
          );
          if (pks.length > 0 && pks.every((pk) => columns.includes(pk))) {
            editContext = {
              manager,
              database: parsed.database || defaultDatabase || '',
              table: parsed.table,
              primaryKeys: pks,
            };
          }
        }
        show(
          columns,
          results as Record<string, any>[],
          limitApplied ? sqlToRun : stmt.text,
          editContext,
          parsed.editable ? undefined : parsed.reason,
        );
        shownGrid = true;
      } else {
        sawEmptySelect = true;
      }
    } else if (results && typeof results === 'object') {
      const affected = (results as any).affectedRows;
      if (typeof affected === 'number') {
        dmlMessages.push(`${affected} row(s) affected`);
      }
    }
  }

  if (!shownGrid) {
    if (dmlMessages.length > 0) {
      notify(dmlMessages.join(', '));
    } else if (sawEmptySelect) {
      notify('Query executed. No rows returned.');
    } else {
      notify('Query executed.');
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
  const treeProvider = new ConnectionTreeProvider(context);

  const treeView = vscode.window.createTreeView('simple-rdb-connections', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  const sqlStorage = treeProvider.getSqlStorage();
  const queryResultProvider = new QueryResultProvider(context.extensionUri);
  const showResult = queryResultProvider.show.bind(queryResultProvider);

  // Simple RDB가 관리하는 SQL 파일에서만 Cmd/Ctrl+Enter가 동작하도록 컨텍스트 키를 유지한다.
  const updateManagedSqlContext = (editor: vscode.TextEditor | undefined) => {
    const managed =
      !!editor && sqlStorage.connectionIdFromPath(editor.document.uri.fsPath) !== null;
    vscode.commands.executeCommand('setContext', 'simpleRdb.isManagedSqlFile', managed);
  };
  updateManagedSqlContext(vscode.window.activeTextEditor);
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateManagedSqlContext));

  context.subscriptions.push(
    vscode.commands.registerCommand('simple-rdb.addConnection', async () => {
      const result = await showConnectionDialog();
      if (result) {
        await CredentialStore.addConnection(context, result);
        treeProvider.loadConnections();
      }
    }),

    vscode.commands.registerCommand('simple-rdb.editConnection', async (node: any) => {
      const connections = await CredentialStore.getConnections(context);
      const id = typeof node === 'string' ? node : node?.connection?.id;
      const conn = connections.find((c) => c.id === id);
      if (!conn) {
        return;
      }

      const result = await showConnectionDialog(conn);
      if (result) {
        // 저장이 확정된 경우에만 끊고 새 설정으로 갱신한다(취소/닫기 시 연결 유지).
        await treeProvider.disconnectFrom(id);
        await CredentialStore.updateConnection(context, id, result);
        treeProvider.loadConnections();
      }
    }),

    vscode.commands.registerCommand('simple-rdb.removeConnection', async (node: any) => {
      const connections = await CredentialStore.getConnections(context);
      const id = typeof node === 'string' ? node : node?.connection?.id;
      const conn = connections.find((c) => c.id === id);
      if (!conn) {
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Remove connection "${conn.name}"?`,
        { modal: true },
        'Remove',
      );
      if (confirm === 'Remove') {
        await treeProvider.disconnectFrom(id);
        await CredentialStore.removeConnection(context, id);
        treeProvider.loadConnections();
      }
    }),

    vscode.commands.registerCommand('simple-rdb.connect', async (node: any) => {
      const id = node?.connection?.id;
      if (id) {
        await treeProvider.connectTo(id);
      }
    }),

    vscode.commands.registerCommand('simple-rdb.disconnect', async (node: any) => {
      const id = node?.connection?.id;
      if (id) {
        await treeProvider.disconnectFrom(id);
      }
    }),

    vscode.commands.registerCommand('simple-rdb.refresh', () => {
      treeProvider.loadConnections();
    }),

    vscode.commands.registerCommand('simple-rdb.openTable', async (node: TableNode) => {
      const manager = treeProvider.getActiveConnection(node.connectionId);
      if (!manager) {
        vscode.window.showErrorMessage('Not connected.');
        return;
      }

      const provider = new TableViewProvider(
        context.extensionUri,
        node.connectionId,
        node.databaseName,
        node.tableName,
        manager,
      );
      await provider.open();
    }),

    vscode.commands.registerCommand(
      'simple-rdb.newSqlFile',
      async (node: SqlFileGroupNode | any) => {
        let connectionId = node?.connectionId;
        if (!connectionId) {
          const picked = await vscode.window.showQuickPick(
            (await CredentialStore.getConnections(context)).map((c) => ({
              label: c.name,
              id: c.id,
            })),
            { placeHolder: 'Select connection for the SQL file' },
          );
          if (!picked) {
            return;
          }
          connectionId = picked.id;
        }

        const name = await vscode.window.showInputBox({
          prompt: 'SQL file name',
          placeHolder: 'query.sql',
          validateInput: (value) => {
            if (!value.trim()) {
              return 'Name required';
            }
            return null;
          },
        });
        if (name) {
          const fileName = await sqlStorage.createSqlFile(connectionId, name);
          const uri = vscode.Uri.file(sqlStorage.filePath(connectionId, fileName));
          const document = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(document);
          treeProvider.refresh();
        }
      },
    ),

    vscode.commands.registerCommand('simple-rdb.openSqlFile', async (node: SqlFileNode) => {
      const uri = vscode.Uri.file(sqlStorage.filePath(node.connectionId, node.fileName));
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);
    }),

    vscode.commands.registerCommand('simple-rdb.deleteSqlFile', async (node: SqlFileNode) => {
      const confirm = await vscode.window.showWarningMessage(
        `Delete "${node.fileName}"?`,
        { modal: true },
        'Delete',
      );
      if (confirm === 'Delete') {
        await sqlStorage.deleteSqlFile(node.connectionId, node.fileName);
        treeProvider.refresh();
      }
    }),

    vscode.commands.registerCommand('simple-rdb.runSqlFile', async (node: SqlFileNode) => {
      let manager = treeProvider.getActiveConnection(node.connectionId);
      if (!manager) {
        const connect = await vscode.window.showInformationMessage(
          'Not connected. Connect first?',
          'Connect',
        );
        if (connect) {
          await treeProvider.connectTo(node.connectionId);
          manager = treeProvider.getActiveConnection(node.connectionId);
        }
        if (!manager) {
          return;
        }
      }

      const content = sqlStorage.getContent(node.connectionId, node.fileName);
      const statements = splitStatements(content);
      if (statements.length === 0) {
        vscode.window.showWarningMessage('SQL file is empty.');
        return;
      }

      try {
        await executeStatements(
          manager,
          statements,
          manager.database,
          showResult,
          undefined,
          vscode.workspace.getConfiguration('simpleRdb').get('defaultLimit', DEFAULT_ROW_LIMIT),
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(`Query failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('simple-rdb.runQuery', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }

      const filePath = editor.document.uri.fsPath;
      const connectionId = sqlStorage.connectionIdFromPath(filePath);
      if (!connectionId) {
        vscode.window.showWarningMessage(
          'This SQL file is not associated with a Simple RDB connection.',
        );
        return;
      }

      let manager = treeProvider.getActiveConnection(connectionId);
      if (!manager) {
        await treeProvider.connectTo(connectionId);
        manager = treeProvider.getActiveConnection(connectionId);
        if (!manager) {
          return;
        }
      }

      // 선택 영역이 있으면 그 안의 문장들을, 없으면 커서가 위치한 문장 하나를 실행한다.
      let statements;
      if (!editor.selection.isEmpty) {
        statements = splitStatements(editor.document.getText(editor.selection));
      } else {
        const all = splitStatements(editor.document.getText());
        const offset = editor.document.offsetAt(editor.selection.active);
        const stmt = statementAtOffset(all, offset);
        statements = stmt ? [stmt] : [];
      }

      if (statements.length === 0) {
        vscode.window.showWarningMessage('No query to run.');
        return;
      }

      try {
        await executeStatements(
          manager,
          statements,
          manager.database,
          showResult,
          undefined,
          vscode.workspace.getConfiguration('simpleRdb').get('defaultLimit', DEFAULT_ROW_LIMIT),
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(`Query failed: ${err.message}`);
      }
    }),
  );

  treeProvider.loadConnections();
}

export function deactivate() {}
