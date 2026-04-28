import * as vscode from 'vscode';
import * as path from 'path';

type TreeNode = ConnectionNode | DatabaseNode | TableNode | SqlFileGroupNode | SqlFileNode;

export class ConnectionNode extends vscode.TreeItem {
  constructor(
    public readonly connection: {
      id: string;
      name: string;
      host: string;
      port: number;
      user: string;
    },
    public readonly isConnected: boolean,
  ) {
    super(connection.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = isConnected ? 'connected' : 'connection';
    this.iconPath = new vscode.ThemeIcon(isConnected ? 'vm-running' : 'vm-connect');
    this.description = isConnected ? `${connection.host}:${connection.port}` : 'disconnected';
    this.tooltip = `${connection.user}@${connection.host}:${connection.port}`;
  }
}

export class DatabaseNode extends vscode.TreeItem {
  constructor(
    public readonly connectionId: string,
    public readonly databaseName: string,
  ) {
    super(databaseName, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'database';
    this.iconPath = new vscode.ThemeIcon('database');
  }
}

export class TableNode extends vscode.TreeItem {
  constructor(
    public readonly connectionId: string,
    public readonly databaseName: string,
    public readonly tableName: string,
  ) {
    super(tableName, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'table';
    this.iconPath = new vscode.ThemeIcon('table');
    this.command = {
      command: 'simple-rdb.openTable',
      title: 'Open Table',
      arguments: [this],
    };
  }
}

export class SqlFileGroupNode extends vscode.TreeItem {
  constructor() {
    super('SQL Files', vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'sqlFileGroup';
    this.iconPath = new vscode.ThemeIcon('folder');
  }
}

export class SqlFileNode extends vscode.TreeItem {
  constructor(public readonly fileName: string) {
    super(fileName, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'sqlFile';
    this.iconPath = new vscode.ThemeIcon('file-code');
    this.command = {
      command: 'simple-rdb.openSqlFile',
      title: 'Open SQL File',
      arguments: [this],
    };
  }
}
