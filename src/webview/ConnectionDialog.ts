import * as vscode from 'vscode';
import { StoredConnection } from '../storage/CredentialStore';

export async function showConnectionDialog(
  existing?: StoredConnection,
): Promise<StoredConnection | undefined> {
  let name = '';
  let host = '127.0.0.1';
  let port = '3306';
  let user = 'root';
  // 비밀번호류는 편집 시에도 폼 HTML에 평문으로 넣지 않는다(L-3). 저장 시 비어 있으면 기존 값 유지.
  const password = '';
  let database = '';
  let sshEnabled = false;
  let sshHost = '';
  let sshPort = '22';
  let sshUser = '';
  const sshPassword = '';
  const sshPassphrase = '';
  let sshKeyPath = '';

  if (existing) {
    name = existing.name;
    host = existing.host;
    port = String(existing.port);
    user = existing.user;
    database = existing.database || '';
    if (existing.ssh) {
      sshEnabled = true;
      sshHost = existing.ssh.host;
      sshPort = String(existing.ssh.port);
      sshUser = existing.ssh.username;
      sshKeyPath = existing.ssh.privateKeyPath || '';
    }
  }

  const panel = vscode.window.createWebviewPanel(
    'connectionEditor',
    existing ? 'Edit Connection' : 'Add Connection',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );

  const fillData = {
    name,
    host,
    port,
    user,
    password,
    database,
    sshEnabled,
    sshHost,
    sshPort,
    sshUser,
    sshPassword,
    sshPassphrase,
    sshKeyPath,
  };

  panel.webview.html = getConnectionHtml(
    fillData,
    panel.webview.cspSource,
    existing ? existing.id : undefined,
  );

  return new Promise<StoredConnection | undefined>((resolve) => {
    let settled = false;
    const finish = (value: StoredConnection | undefined) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    // 탭 X로 닫으면(패널 dispose) 취소로 처리 — 그렇지 않으면 Promise가 영구 미해결된다.
    panel.onDidDispose(() => finish(undefined));
    panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.type) {
          case 'save': {
            const data = message.data;
            const conn: StoredConnection = {
              id: existing?.id || 'conn_' + Date.now(),
              name: data.name.trim(),
              host: data.host.trim(),
              port: parseInt(data.port, 10) || 3306,
              user: data.user.trim(),
              // 비어 있으면 기존 비밀번호 유지(L-3)
              password: data.password !== '' ? data.password : (existing?.password ?? ''),
              database: data.database.trim() || undefined,
            };

            if (data.sshEnabled) {
              conn.ssh = {
                host: data.sshHost.trim(),
                port: parseInt(data.sshPort, 10) || 22,
                username: data.sshUser.trim(),
              };
              const sshPw =
                data.sshPassword !== '' ? data.sshPassword : existing?.ssh?.password;
              if (sshPw) {
                conn.ssh.password = sshPw;
              }
              if (data.sshKeyPath.trim()) {
                conn.ssh.privateKeyPath = data.sshKeyPath.trim();
              }
              const sshPp =
                data.sshPassphrase !== '' ? data.sshPassphrase : existing?.ssh?.passphrase;
              if (sshPp) {
                conn.ssh.passphrase = sshPp;
              }
            }

            finish(conn);
            panel.dispose();
            break;
          }
          case 'cancel':
            finish(undefined);
            panel.dispose();
            break;
        }
      },
      undefined,
      [],
    );
  });
}

function getConnectionHtml(data: any, cspSource: string, existingId?: string): string {
  const pwPlaceholder = existingId ? '변경하려면 입력 (비우면 기존 값 유지)' : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource} 'unsafe-inline'; connect-src 'none';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${existingId ? 'Edit Connection' : 'Add Connection'}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, -apple-system, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      padding: 24px;
      max-width: 520px;
      margin: 0 auto;
    }
    h2 {
      margin-bottom: 20px;
      font-weight: 600;
    }
    .form-group {
      margin-bottom: 14px;
    }
    label {
      display: block;
      margin-bottom: 4px;
      font-weight: 500;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    input, select {
      width: 100%;
      padding: 6px 10px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 3px;
      font-family: inherit;
      font-size: 13px;
    }
    input:focus, select:focus {
      border-color: var(--vscode-focusBorder);
      outline: none;
    }
    .row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .checkbox-group {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
      margin-bottom: 14px;
    }
    .checkbox-group input[type="checkbox"] {
      width: auto;
    }
    .ssh-section {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 14px;
      margin-top: 8px;
      display: none;
    }
    .ssh-section.visible { display: block; }
    .buttons {
      display: flex;
      gap: 10px;
      margin-top: 24px;
      justify-content: flex-end;
    }
    button {
      padding: 6px 18px;
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border-radius: 3px;
      cursor: pointer;
      font-size: 13px;
    }
    button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    button.primary:hover {
      background: var(--vscode-button-hoverBackground);
    }
  </style>
</head>
<body>
  <h2>${existingId ? 'Edit Connection' : 'Add Connection'}</h2>
  <form id="connectionForm">
    <div class="form-group">
      <label for="name">Connection Name</label>
      <input type="text" id="name" value="${escapeAttr(data.name)}" required autofocus>
    </div>
    <div class="row">
      <div class="form-group">
        <label for="host">Host</label>
        <input type="text" id="host" value="${escapeAttr(data.host)}" required>
      </div>
      <div class="form-group">
        <label for="port">Port</label>
        <input type="number" id="port" value="${escapeAttr(data.port)}" required>
      </div>
    </div>
    <div class="form-group">
      <label for="user">User</label>
      <input type="text" id="user" value="${escapeAttr(data.user)}" required>
    </div>
    <div class="form-group">
      <label for="password">Password</label>
      <input type="password" id="password" value="" placeholder="${escapeAttr(pwPlaceholder)}">
    </div>
    <div class="form-group">
      <label for="database">Default Database (optional)</label>
      <input type="text" id="database" value="${escapeAttr(data.database)}">
    </div>

    <div class="checkbox-group">
      <input type="checkbox" id="sshEnabled" ${data.sshEnabled ? 'checked' : ''}>
      <label for="sshEnabled" style="margin:0;">Use SSH Tunnel</label>
    </div>

    <div id="sshSection" class="ssh-section ${data.sshEnabled ? 'visible' : ''}">
      <div class="row">
        <div class="form-group">
          <label for="sshHost">SSH Host</label>
          <input type="text" id="sshHost" value="${escapeAttr(data.sshHost)}">
        </div>
        <div class="form-group">
          <label for="sshPort">SSH Port</label>
          <input type="number" id="sshPort" value="${escapeAttr(data.sshPort)}">
        </div>
      </div>
      <div class="form-group">
        <label for="sshUser">SSH User</label>
        <input type="text" id="sshUser" value="${escapeAttr(data.sshUser)}">
      </div>
      <div class="form-group">
        <label for="sshPassword">SSH Password</label>
        <input type="password" id="sshPassword" value="" placeholder="${escapeAttr(pwPlaceholder)}">
      </div>
      <div class="form-group">
        <label for="sshKeyPath">SSH Private Key Path</label>
        <input type="text" id="sshKeyPath" value="${escapeAttr(data.sshKeyPath)}" placeholder="/home/user/.ssh/id_rsa">
      </div>
      <div class="form-group">
        <label for="sshPassphrase">SSH Key Passphrase</label>
        <input type="password" id="sshPassphrase" value="" placeholder="${escapeAttr(pwPlaceholder)}">
      </div>
    </div>

    <div class="buttons">
      <button type="button" onclick="cancel()">Cancel</button>
      <button type="submit" class="primary">Save</button>
    </div>
  </form>

  <script>
    const vscode = acquireVsCodeApi();

    document.getElementById('sshEnabled').addEventListener('change', function() {
      document.getElementById('sshSection').classList.toggle('visible', this.checked);
    });

    document.getElementById('connectionForm').addEventListener('submit', function(e) {
      e.preventDefault();
      const data = {
        name: document.getElementById('name').value,
        host: document.getElementById('host').value,
        port: document.getElementById('port').value,
        user: document.getElementById('user').value,
        password: document.getElementById('password').value,
        database: document.getElementById('database').value,
        sshEnabled: document.getElementById('sshEnabled').checked,
        sshHost: document.getElementById('sshHost').value,
        sshPort: document.getElementById('sshPort').value,
        sshUser: document.getElementById('sshUser').value,
        sshPassword: document.getElementById('sshPassword').value,
        sshPassphrase: document.getElementById('sshPassphrase').value,
        sshKeyPath: document.getElementById('sshKeyPath').value,
      };
      vscode.postMessage({ type: 'save', data });
    });

    function cancel() {
      vscode.postMessage({ type: 'cancel' });
    }

    function escapeAttr(str) {
      return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    }
  </script>
</body>
</html>`;
}

function escapeAttr(str: string): string {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
