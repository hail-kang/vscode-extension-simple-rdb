import * as vscode from 'vscode';
import { StoredConnection, CredentialStore } from '../storage/CredentialStore';
import {
  ConnectionNode,
  DatabaseNode,
  TableNode,
  SqlFileGroupNode,
  SqlFileNode,
} from './TreeNodes';
import type { ConnectionManager } from '../db/ConnectionManager';

export class ConnectionTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private connections: StoredConnection[] = [];
  private activeConnections = new Map<string, ConnectionManager>();

  constructor(private context: vscode.ExtensionContext) {}

  refresh(node?: vscode.TreeItem): void {
    this._onDidChangeTreeData.fire(node);
  }

  getActiveConnection(id: string): ConnectionManager | undefined {
    return this.activeConnections.get(id);
  }

  async loadConnections(): Promise<void> {
    this.connections = await CredentialStore.getConnections(this.context);
    this.refresh();
  }

  async connectTo(id: string): Promise<void> {
    const conn = this.connections.find((c) => c.id === id);
    if (!conn) {
      return;
    }

    if (this.activeConnections.has(id)) {
      return;
    }

    const { ConnectionManager: CM } = await import('../db/ConnectionManager');
    const manager = new CM(conn);
    try {
      await manager.connect();
      this.activeConnections.set(id, manager);
      this.refresh();
    } catch (err: any) {
      vscode.window.showErrorMessage(`Connection failed: ${err.message}`);
    }
  }

  async disconnectFrom(id: string): Promise<void> {
    const manager = this.activeConnections.get(id);
    if (manager) {
      await manager.disconnect();
      this.activeConnections.delete(id);
      this.refresh();
    }
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!element) {
      return this.getRootChildren();
    }

    if (element instanceof ConnectionNode) {
      const manager = this.activeConnections.get(element.connection.id);
      if (manager) {
        return this.getDatabaseChildren(element.connection.id, manager);
      }
      return [];
    }

    if (element instanceof DatabaseNode) {
      const manager = this.activeConnections.get(element.connectionId);
      if (manager) {
        return this.getTableChildren(element.connectionId, element.databaseName, manager);
      }
      return [];
    }

    if (element instanceof SqlFileGroupNode) {
      return this.getSqlFileChildren();
    }

    return [];
  }

  private async getRootChildren(): Promise<vscode.TreeItem[]> {
    const items: vscode.TreeItem[] = [];

    for (const conn of this.connections) {
      const isConnected = this.activeConnections.has(conn.id);
      items.push(
        new ConnectionNode(
          { id: conn.id, name: conn.name, host: conn.host, port: conn.port, user: conn.user },
          isConnected,
        ),
      );
    }

    items.push(new SqlFileGroupNode());
    return items;
  }

  private async getDatabaseChildren(
    connectionId: string,
    manager: ConnectionManager,
  ): Promise<vscode.TreeItem[]> {
    try {
      const databases = await manager.getDatabases();
      return databases.map((db) => new DatabaseNode(connectionId, db));
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to list databases: ${err.message}`);
      return [];
    }
  }

  private async getTableChildren(
    connectionId: string,
    databaseName: string,
    manager: ConnectionManager,
  ): Promise<vscode.TreeItem[]> {
    try {
      const tables = await manager.getTables(databaseName);
      return tables.map((table) => new TableNode(connectionId, databaseName, table));
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to list tables: ${err.message}`);
      return [];
    }
  }

  private async getSqlFileChildren(): Promise<vscode.TreeItem[]> {
    const files = this.context.globalState.get<string[]>('simple-rdb-sql-files', []);
    return files.map((name) => new SqlFileNode(name));
  }
}
