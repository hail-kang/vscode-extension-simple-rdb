import * as vscode from 'vscode';
import { ConnectionTreeProvider } from './tree/ConnectionTreeProvider';
import { CredentialStore, StoredConnection } from './storage/CredentialStore';
import { SqlFileStorage } from './storage/SqlFileStorage';
import { TableViewProvider } from './webview/TableViewProvider';
import { showConnectionDialog } from './webview/ConnectionDialog';
import { TableNode, SqlFileNode } from './tree/TreeNodes';

export function activate(context: vscode.ExtensionContext) {
  const treeProvider = new ConnectionTreeProvider(context);
  const sqlStorage = new SqlFileStorage(context);

  const treeView = vscode.window.createTreeView('simple-rdb-connections', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

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
      await treeProvider.disconnectFrom(id);

      const result = await showConnectionDialog(conn);
      if (result) {
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

    vscode.commands.registerCommand('simple-rdb.newSqlFile', async () => {
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
        const fileName = await sqlStorage.createSqlFile(name);
        const document = await vscode.workspace.openTextDocument({
          content: sqlStorage.getContent(fileName),
          language: 'sql',
        });
        const editor = await vscode.window.showTextDocument(document);

        const onSave = editor.document;
        vscode.workspace.onDidSaveTextDocument((e) => {
          if (e.fileName === document.fileName) {
            sqlStorage.saveContent(fileName, e.getText());
          }
        });

        treeProvider.refresh();
      }
    }),

    vscode.commands.registerCommand('simple-rdb.openSqlFile', async (node: SqlFileNode) => {
      const content = sqlStorage.getContent(node.fileName);
      const document = await vscode.workspace.openTextDocument({
        content,
        language: 'sql',
      });
      await vscode.window.showTextDocument(document);

      vscode.workspace.onDidSaveTextDocument((e) => {
        if (e.languageId === 'sql') {
          sqlStorage.saveContent(node.fileName, e.getText());
        }
      });
    }),

    vscode.commands.registerCommand('simple-rdb.deleteSqlFile', async (node: SqlFileNode) => {
      const confirm = await vscode.window.showWarningMessage(
        `Delete "${node.fileName}"?`,
        { modal: true },
        'Delete',
      );
      if (confirm === 'Delete') {
        await sqlStorage.deleteSqlFile(node.fileName);
        treeProvider.refresh();
      }
    }),
  );

  treeProvider.loadConnections();
}

export function deactivate() {}
