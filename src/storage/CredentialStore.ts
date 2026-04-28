import * as vscode from 'vscode';

export interface StoredConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
  ssh?: {
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: string;
    passphrase?: string;
  };
}

const SECRET_KEY = 'simple-rdb-connections';

export class CredentialStore {
  static async getConnections(context: vscode.ExtensionContext): Promise<StoredConnection[]> {
    const data = context.globalState.get<StoredConnection[]>(SECRET_KEY);
    return data ?? [];
  }

  static async saveConnections(
    context: vscode.ExtensionContext,
    connections: StoredConnection[],
  ): Promise<void> {
    await context.globalState.update(SECRET_KEY, connections);
  }

  static async addConnection(
    context: vscode.ExtensionContext,
    connection: StoredConnection,
  ): Promise<void> {
    const connections = await this.getConnections(context);
    connections.push(connection);
    await this.saveConnections(context, connections);
  }

  static async updateConnection(
    context: vscode.ExtensionContext,
    id: string,
    updates: Partial<StoredConnection>,
  ): Promise<void> {
    const connections = await this.getConnections(context);
    const index = connections.findIndex((c) => c.id === id);
    if (index !== -1) {
      connections[index] = { ...connections[index], ...updates };
      await this.saveConnections(context, connections);
    }
  }

  static async removeConnection(context: vscode.ExtensionContext, id: string): Promise<void> {
    const connections = await this.getConnections(context);
    const filtered = connections.filter((c) => c.id !== id);
    await this.saveConnections(context, filtered);
  }
}
