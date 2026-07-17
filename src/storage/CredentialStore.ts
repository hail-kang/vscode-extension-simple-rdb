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
    /** 개인키 파일 경로(키 내용이 아니라 경로). 연결 시 파일을 읽어 사용한다. */
    privateKeyPath?: string;
    passphrase?: string;
  };
}

/** globalState(평문 SQLite)에 저장되는 비민감 메타데이터. 비밀번호류는 제외한다. */
interface PublicConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  database?: string;
  ssh?: {
    host: string;
    port: number;
    username: string;
    privateKeyPath?: string;
  };
}

/** SecretStorage(OS 키체인 암호화)에 저장되는 민감 정보. */
interface ConnectionSecret {
  password?: string;
  sshPassword?: string;
  sshPassphrase?: string;
}

const INDEX_KEY = 'simple-rdb-connections';
const secretKey = (id: string) => `simple-rdb.secret.${id}`;

/**
 * 연결 정보를 저장한다. 비밀번호·SSH 비밀번호·passphrase는 SecretStorage(암호화)에,
 * 나머지 메타데이터는 globalState에 분리 저장한다. 과거 버전이 globalState에 평문으로
 * 남긴 비밀은 최초 로드 시 SecretStorage로 자동 이전(migrate)한다.
 */
export class CredentialStore {
  static async getConnections(context: vscode.ExtensionContext): Promise<StoredConnection[]> {
    const stored = context.globalState.get<any[]>(INDEX_KEY) ?? [];
    const publics = await this.migrateLegacy(context, stored);
    const result: StoredConnection[] = [];
    for (const pub of publics) {
      const secret = await this.readSecret(context, pub.id);
      result.push(this.hydrate(pub, secret));
    }
    return result;
  }

  static async addConnection(
    context: vscode.ExtensionContext,
    connection: StoredConnection,
  ): Promise<void> {
    const stored = context.globalState.get<any[]>(INDEX_KEY) ?? [];
    const publics = await this.migrateLegacy(context, stored);
    publics.push(this.toPublic(connection));
    await context.globalState.update(INDEX_KEY, publics);
    await this.writeSecret(context, connection.id, this.toSecret(connection));
  }

  static async updateConnection(
    context: vscode.ExtensionContext,
    id: string,
    updates: Partial<StoredConnection>,
  ): Promise<void> {
    const connections = await this.getConnections(context);
    const index = connections.findIndex((c) => c.id === id);
    if (index === -1) {
      return;
    }
    const merged: StoredConnection = { ...connections[index], ...updates, id };
    const publics = connections.map((c) => this.toPublic(c));
    publics[index] = this.toPublic(merged);
    await context.globalState.update(INDEX_KEY, publics);
    await this.writeSecret(context, id, this.toSecret(merged));
  }

  static async removeConnection(context: vscode.ExtensionContext, id: string): Promise<void> {
    const stored = context.globalState.get<any[]>(INDEX_KEY) ?? [];
    // 다른 연결의 레거시 비밀이 유실되지 않도록 먼저 이전한 뒤 제거한다.
    const publics = await this.migrateLegacy(context, stored);
    const filtered = publics.filter((c) => c.id !== id);
    await context.globalState.update(INDEX_KEY, filtered);
    await context.secrets.delete(secretKey(id));
  }

  private static toPublic(c: any): PublicConnection {
    const pub: PublicConnection = {
      id: c.id,
      name: c.name,
      host: c.host,
      port: c.port,
      user: c.user,
    };
    if (c.database) {
      pub.database = c.database;
    }
    if (c.ssh) {
      pub.ssh = {
        host: c.ssh.host,
        port: c.ssh.port,
        username: c.ssh.username,
      };
      // 과거 버전은 키 경로를 privateKey 필드에 저장했으므로 둘 다 수용한다.
      const keyPath = c.ssh.privateKeyPath ?? c.ssh.privateKey;
      if (keyPath) {
        pub.ssh.privateKeyPath = keyPath;
      }
    }
    return pub;
  }

  private static toSecret(c: any): ConnectionSecret {
    const secret: ConnectionSecret = {};
    if (c.password) {
      secret.password = c.password;
    }
    if (c.ssh?.password) {
      secret.sshPassword = c.ssh.password;
    }
    if (c.ssh?.passphrase) {
      secret.sshPassphrase = c.ssh.passphrase;
    }
    return secret;
  }

  private static hydrate(pub: PublicConnection, secret: ConnectionSecret): StoredConnection {
    const conn: StoredConnection = {
      id: pub.id,
      name: pub.name,
      host: pub.host,
      port: pub.port,
      user: pub.user,
      password: secret.password ?? '',
    };
    if (pub.database) {
      conn.database = pub.database;
    }
    if (pub.ssh) {
      conn.ssh = {
        host: pub.ssh.host,
        port: pub.ssh.port,
        username: pub.ssh.username,
      };
      if (pub.ssh.privateKeyPath) {
        conn.ssh.privateKeyPath = pub.ssh.privateKeyPath;
      }
      if (secret.sshPassword) {
        conn.ssh.password = secret.sshPassword;
      }
      if (secret.sshPassphrase) {
        conn.ssh.passphrase = secret.sshPassphrase;
      }
    }
    return conn;
  }

  private static async readSecret(
    context: vscode.ExtensionContext,
    id: string,
  ): Promise<ConnectionSecret> {
    const raw = await context.secrets.get(secretKey(id));
    if (!raw) {
      return {};
    }
    try {
      return JSON.parse(raw) as ConnectionSecret;
    } catch {
      return {};
    }
  }

  private static async writeSecret(
    context: vscode.ExtensionContext,
    id: string,
    secret: ConnectionSecret,
  ): Promise<void> {
    if (!secret.password && !secret.sshPassword && !secret.sshPassphrase) {
      await context.secrets.delete(secretKey(id));
      return;
    }
    await context.secrets.store(secretKey(id), JSON.stringify(secret));
  }

  /** 과거에 globalState에 평문으로 저장된 비밀을 SecretStorage로 이전하고 메타데이터만 남긴다. */
  private static async migrateLegacy(
    context: vscode.ExtensionContext,
    stored: any[],
  ): Promise<PublicConnection[]> {
    let changed = false;
    const publics: PublicConnection[] = [];
    for (const c of stored) {
      const hasInlineSecret =
        c.password !== undefined ||
        c.ssh?.password !== undefined ||
        c.ssh?.passphrase !== undefined ||
        c.ssh?.privateKey !== undefined;
      if (hasInlineSecret) {
        changed = true;
        await this.writeSecret(context, c.id, this.toSecret(c));
      }
      publics.push(this.toPublic(c));
    }
    if (changed) {
      await context.globalState.update(INDEX_KEY, publics);
    }
    return publics;
  }
}
