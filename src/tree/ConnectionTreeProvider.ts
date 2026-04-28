import * as vscode from 'vscode';
import { StoredConnection, CredentialStore } from '../storage/CredentialStore';
import {
  ConnectionNode,
  DatabaseNode,
  TableNode,
  SqlFileGroupNode,
  SqlFileNode,
} from './TreeNodes';
import { SqlFileStorage } from '../storage/SqlFileStorage';
import type { ConnectionManager } from '../db/ConnectionManager';

export class ConnectionTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private connections: StoredConnection[] = [];
  private activeConnections = new Map<string, ConnectionManager>();
  private sqlStorage: SqlFileStorage;

  constructor(private context: vscode.ExtensionContext) {
    this.sqlStorage = new SqlFileStorage(context);
  }

  getSqlStorage(): SqlFileStorage {
    return this.sqlStorage;
  }

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

    const ctx = element.contextValue;

    if (ctx === 'connection' || ctx === 'connected') {
      return this.getConnectionChildren((element as ConnectionNode).connection.id);
    }

    if (ctx === 'database') {
      const dbNode = element as DatabaseNode;
      const manager = this.activeConnections.get(dbNode.connectionId);
      if (manager) {
        return this.getTableChildren(dbNode.connectionId, dbNode.databaseName, manager);
      }
      return [];
    }

    if (ctx === 'sqlFileGroup') {
      return this.getSqlFileChildren((element as SqlFileGroupNode).connectionId);
    }

    return [];
  }

  private async getRootChildren(): Promise<vscode.TreeItem[]> {
    return this.connections.map((conn) => {
      const isConnected = this.activeConnections.has(conn.id);
      return new ConnectionNode(
        {
          id: conn.id,
          name: conn.name,
          host: conn.host,
          port: conn.port,
          user: conn.user,
        },
        isConnected,
      );
    });
  }

  private async getConnectionChildren(connectionId: string): Promise<vscode.TreeItem[]> {
    const items: vscode.TreeItem[] = [];
    const manager = this.activeConnections.get(connectionId);
    if (manager) {
      try {
        const databases = await manager.getDatabases();
        items.push(...databases.map((db) => new DatabaseNode(connectionId, db)));
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to list databases: ${err.message}`);
      }
    }
    items.push(new SqlFileGroupNode(connectionId));
    return items;
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

  private async getSqlFileChildren(connectionId: string): Promise<vscode.TreeItem[]> {
    const files = this.sqlStorage.getSqlFileNames(connectionId);
    const children = files.map((name) => new SqlFileNode(connectionId, name));
    return children;
  }
}
