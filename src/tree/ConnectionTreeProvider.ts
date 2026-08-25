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
  private pendingConnects = new Map<string, Promise<void>>();
  private sqlStorage: SqlFileStorage;

  constructor(private context: vscode.ExtensionContext) {
    this.sqlStorage = new SqlFileStorage();
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

  /** 활성화된 모든 연결의 메타데이터 캐시를 무효화한다(DDL 이후 새로고침용). */
  invalidateMetaCaches(): void {
    for (const manager of this.activeConnections.values()) {
      manager.invalidateMetaCache();
    }
  }

  async loadConnections(): Promise<void> {
    this.connections = await CredentialStore.getConnections(this.context);
    this.refresh();
  }

  async connectTo(id: string): Promise<void> {
    if (this.activeConnections.has(id)) {
      return;
    }
    // 연결 진행 중 중복 호출은 같은 Promise를 공유해 풀·SSH 터널 이중 생성(누수)을 막는다.
    const pending = this.pendingConnects.get(id);
    if (pending) {
      return pending;
    }
    const p = this.doConnect(id).finally(() => this.pendingConnects.delete(id));
    this.pendingConnects.set(id, p);
    return p;
  }

  private async doConnect(id: string): Promise<void> {
    const conn = this.connections.find((c) => c.id === id);
    if (!conn || this.activeConnections.has(id)) {
      return;
    }

    const { ConnectionManager: CM } = await import('../db/ConnectionManager');
    const manager = new CM(conn);
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Connecting to ${conn.name}…`,
        },
        () => manager.connect(),
      );
      manager.setOnClosed((reason) => this.handleUnexpectedClose(id, reason));
      this.activeConnections.set(id, manager);
      this.refresh();
    } catch (err: any) {
      vscode.window.showErrorMessage(`Connection failed: ${err.message}`);
    }
  }

  private handleUnexpectedClose(id: string, reason?: string): void {
    if (!this.activeConnections.has(id)) {
      return;
    }
    this.activeConnections.delete(id);
    this.refresh();
    const conn = this.connections.find((c) => c.id === id);
    const name = conn ? conn.name : id;
    vscode.window.showWarningMessage(`연결이 끊어졌습니다: ${name}${reason ? ` (${reason})` : ''}`);
  }

  async disconnectFrom(id: string): Promise<void> {
    const manager = this.activeConnections.get(id);
    if (!manager) {
      return;
    }
    try {
      await manager.disconnect();
    } finally {
      // pool.end()가 실패해도 트리 상태는 항상 정리한다(좀비 '연결됨' 방지).
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
    const children = files.map(
      (name) => new SqlFileNode(connectionId, name, this.sqlStorage.filePath(connectionId, name)),
    );
    return children;
  }
}
