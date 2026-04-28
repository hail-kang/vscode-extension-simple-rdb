import * as vscode from 'vscode';

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
    this.id = `conn:${connection.id}`;
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
    this.id = `db:${connectionId}:${databaseName}`;
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
    this.id = `tbl:${connectionId}:${databaseName}:${tableName}`;
    this.contextValue = 'table';
    this.iconPath = new vscode.ThemeIcon('table');
    this.command = {
      command: 'simple-rdb.openTable',
      title: 'Open Table',
      arguments: [this],
    };
  }
}

export class SqlFileNode extends vscode.TreeItem {
  constructor(
    public readonly connectionId: string,
    public readonly fileName: string,
  ) {
    super(fileName, vscode.TreeItemCollapsibleState.None);
    this.id = `sql:${connectionId}:${fileName}`;
    this.contextValue = 'sqlFile';
    this.resourceUri = vscode.Uri.parse(`untitled:${connectionId}/${fileName}`);
    this.command = {
      command: 'simple-rdb.openSqlFile',
      title: 'Open SQL File',
      arguments: [this],
    };
  }
}

export class SqlFileGroupNode extends vscode.TreeItem {
  constructor(public readonly connectionId: string) {
    super('SQL Files', vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `sqlgrp:${connectionId}`;
    this.contextValue = 'sqlFileGroup';
  }
}
