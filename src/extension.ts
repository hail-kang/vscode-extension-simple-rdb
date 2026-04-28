import * as vscode from 'vscode';
import { ConnectionTreeProvider } from './tree/ConnectionTreeProvider';
import { CredentialStore } from './storage/CredentialStore';
import { TableViewProvider } from './webview/TableViewProvider';
import { showConnectionDialog } from './webview/ConnectionDialog';
import { TableNode, SqlFileNode, SqlFileGroupNode } from './tree/TreeNodes';

export function activate(context: vscode.ExtensionContext) {
  const treeProvider = new ConnectionTreeProvider(context);

  const treeView = vscode.window.createTreeView('simple-rdb-connections', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  const sqlStorage = treeProvider.getSqlStorage();

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
      const manager = treeProvider.getActiveConnection(node.connectionId);
      if (!manager) {
        const connect = await vscode.window.showInformationMessage(
          'Not connected. Connect first?',
          'Connect',
        );
        if (connect) {
          await treeProvider.connectTo(node.connectionId);
        }
        return;
      }

      const content = sqlStorage.getContent(node.connectionId, node.fileName);
      if (!content.trim()) {
        vscode.window.showWarningMessage('SQL file is empty.');
        return;
      }

      try {
        const results = await manager.query(content);
        vscode.window.showInformationMessage(
          `Query executed. ${Array.isArray(results) ? results.length + ' row(s)' : 'OK'}`,
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(`Query failed: ${err.message}`);
      }
    }),
  );

  treeProvider.loadConnections();
}

export function deactivate() {}
