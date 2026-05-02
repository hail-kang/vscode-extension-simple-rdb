import * as vscode from 'vscode';
import { formatDateTime } from '../utils';

export interface QueryEditContext {
  manager: any;
  database: string;
  table: string;
  primaryKeys: string[];
}

export class QueryResultProvider {
  private panel: vscode.WebviewPanel | null = null;

  constructor(private extensionUri: vscode.Uri) {}

  show(
    columns: string[],
    rows: Record<string, any>[],
    sql: string,
    editContext?: QueryEditContext,
    readonlyReason?: string,
  ): void {
    if (this.panel) {
      this.panel.dispose();
    }

    const editable = (editContext?.primaryKeys?.length ?? 0) > 0;

    this.panel = vscode.window.createWebviewPanel(
      'queryResult',
      'Query Result',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      },
    );

    this.panel.webview.html = this.getHtml(
      columns,
      rows,
      sql,
      editable,
      editContext,
      readonlyReason,
    );

    this.panel.webview.onDidReceiveMessage(async (message) => {
      if (!editContext) return;
      try {
        switch (message.type) {
          case 'updateRow':
            await editContext.manager.updateRow(
              editContext.database,
              editContext.table,
              message.primaryKeys,
              message.updates,
            );
            this.panel?.webview.postMessage({ type: 'updateSuccess' });
            break;
          case 'deleteRow':
            await editContext.manager.deleteRow(
              editContext.database,
              editContext.table,
              message.primaryKeys,
            );
            this.panel?.webview.postMessage({ type: 'deleteSuccess' });
            break;
        }
      } catch (err: any) {
        this.panel?.webview.postMessage({ type: 'error', message: err.message });
      }
    });

    this.panel.onDidDispose(() => (this.panel = null));
  }

  private getHtml(
    columns: string[],
    rows: Record<string, any>[],
    sql: string,
    editable: boolean,
    editContext?: QueryEditContext,
    readonlyReason?: string,
  ): string {
    const pkSet = new Set(editContext?.primaryKeys ?? []);
    const columnsJson = JSON.stringify(columns);
    const rowsJson = JSON.stringify(rows);
    const pkJson = JSON.stringify(editContext?.primaryKeys ?? []);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Query Result</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      height: 100vh; display: flex; flex-direction: column; overflow: hidden;
    }
    .sql-bar {
      padding: 8px 12px; background: var(--vscode-editor-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px; color: var(--vscode-descriptionForeground);
      white-space: pre-wrap; max-height: 80px; overflow: auto; flex-shrink: 0;
    }
    .toolbar {
      display: flex; align-items: center; gap: 8px; padding: 6px 12px;
      border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0;
    }
    .toolbar button {
      padding: 4px 12px; border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border-radius: 3px; cursor: pointer; font-size: 12px;
    }
    .toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .toolbar button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .toolbar button.primary:hover { background: var(--vscode-button-hoverBackground); }
    .toolbar button.danger { background: #c62828; color: #fff; }
    .spacer { flex: 1; }
    .row-count { font-size: 12px; color: var(--vscode-descriptionForeground); }
    .readonly-badge { font-size: 11px; padding: 2px 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 3px; }
    .table-wrapper { flex: 1; overflow: auto; }
    table { border-collapse: collapse; width: max-content; min-width: 100%; }
    th, td {
      border: 1px solid var(--vscode-panel-border); padding: 4px 10px;
      white-space: nowrap; min-width: 80px; max-width: 400px;
      overflow: hidden; text-overflow: ellipsis;
    }
    th {
      position: sticky; top: 0; background: var(--vscode-editor-background);
      z-index: 2; font-weight: 600; text-align: left;
    }
    th.pk { color: var(--vscode-symbolIcon-variableForeground); }
    td { cursor: default; }
    td.null-cell { color: var(--vscode-descriptionForeground); font-style: italic; }
    td.modified { background: var(--vscode-diffEditor-insertedTextBackground); }
    td.editing { padding: 0; }
    td.editing input {
      width: 100%; border: 2px solid var(--vscode-focusBorder);
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      padding: 4px 8px; font-family: inherit; font-size: inherit; outline: none;
    }
    .pending-bar {
      padding: 6px 12px; background: var(--vscode-statusBarItem-warningBackground);
      color: var(--vscode-statusBarItem-warningForeground); font-size: 12px;
      flex-shrink: 0; display: none;
    }
    .pending-bar.visible { display: flex; align-items: center; gap: 8px; }
  </style>
</head>
<body>
  <div class="sql-bar">${escapeHtml(sql)}</div>
  <div class="toolbar">
    <span class="row-count">${rows.length} row(s)</span>
    ${
      editable
        ? `
      <button id="commitBtn" class="primary" onclick="commitChanges()">Apply Changes (<span id="pendingCount">0</span>)</button>
    `
        : `
      <span class="readonly-badge">Read-only${readonlyReason ? ': ' + escapeHtml(readonlyReason) : ''}</span>
    `
    }
    <span class="spacer"></span>
    <button onclick="exportCSV()">Export CSV</button>
    ${editable ? '<button onclick="deleteSelected()" class="danger">Delete Row</button>' : ''}
  </div>
  <div id="pendingBar" class="pending-bar">
    <span id="pendingMsg"></span>
  </div>
  <div class="table-wrapper">
    <table>
      <thead><tr>${columns.map((c) => `<th class="${pkSet.has(c) ? 'pk' : ''}">${escapeHtml(c)}</th>`).join('')}</tr></thead>
      <tbody id="tableBody"></tbody>
    </table>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const columns = ${columnsJson};
    const rows = ${rowsJson};
    const pks = new Set(${pkJson});
    const editable = ${editable};

    let pendingChanges = new Map();
    let modifiedCells = new Set();
    let selectedRow = null;

    window.addEventListener('message', (e) => {
      if (e.data.type === 'updateSuccess' || e.data.type === 'deleteSuccess') {
        pendingChanges.clear();
        modifiedCells.clear();
        updatePendingUI();
        renderRows();
      } else if (e.data.type === 'error') {
        alert(e.data.message);
      }
    });

    renderRows();

    function renderRows() {
      const tbody = document.getElementById('tableBody');
      tbody.innerHTML = '';
      rows.forEach((row, idx) => {
        const tr = document.createElement('tr');
        tr.dataset.rowIndex = idx;
        columns.forEach((col) => {
          const td = document.createElement('td');
          const v = row[col];
          const cellKey = idx + ':' + col;

          if (v === null) {
            td.textContent = 'NULL';
            td.classList.add('null-cell');
          } else {
            td.textContent = String(v);
          }

          if (modifiedCells.has(cellKey)) td.classList.add('modified');

          if (editable) {
            td.addEventListener('click', () => { selectedRow = idx; });
            td.addEventListener('dblclick', () => startEdit(td, row, col, idx));
          }

          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
    }

    ${
      editable
        ? `
    function startEdit(td, row, col, idx) {
      if (td.classList.contains('editing')) return;
      td.innerHTML = '';
      td.classList.add('editing');
      const input = document.createElement('input');
      input.value = row[col] === null ? '' : String(row[col]);
      input.addEventListener('blur', () => {
        const val = input.value.trim();
        finishEdit(td, row, col, idx, val === '' ? null : val);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const val = input.value.trim();
          finishEdit(td, row, col, idx, val === '' ? null : val);
        }
        if (e.key === 'Escape') cancelEdit(td, row, col);
      });
      td.appendChild(input);
      input.focus(); input.select();
    }

    function finishEdit(td, row, col, idx, newVal) {
      td.classList.remove('editing');
      if (newVal === null) { td.textContent = 'NULL'; td.classList.add('null-cell'); }
      else { td.textContent = String(newVal); td.classList.remove('null-cell'); }

      if (String(row[col]) !== String(newVal)) {
        row[col] = newVal;
        modifiedCells.add(idx + ':' + col);
        td.classList.add('modified');

        const pkObj = {};
        pks.forEach((k) => { pkObj[k] = row[k]; });
        const key = JSON.stringify(pkObj);
        if (!pendingChanges.has(key)) {
          pendingChanges.set(key, { primaryKeys: pkObj, updates: { [col]: newVal } });
        } else {
          pendingChanges.get(key).updates[col] = newVal;
        }
        updatePendingUI();
      }
    }

    function cancelEdit(td, row, col) {
      td.classList.remove('editing');
      td.textContent = row[col] === null ? 'NULL' : String(row[col]);
      if (row[col] === null) td.classList.add('null-cell');
    }

    function commitChanges() {
      for (const [, change] of pendingChanges) {
        vscode.postMessage({ type: 'updateRow', primaryKeys: change.primaryKeys, updates: change.updates });
      }
    }

    function deleteSelected() {
      if (selectedRow === null) return;
      const row = rows[selectedRow];
      const pkObj = {};
      pks.forEach((k) => { pkObj[k] = row[k]; });
      vscode.postMessage({ type: 'deleteRow', primaryKeys: pkObj });
      rows.splice(selectedRow, 1);
      renderRows();
      selectedRow = null;
    }

    function updatePendingUI() {
      const count = pendingChanges.size;
      document.getElementById('pendingCount').textContent = count;
      const bar = document.getElementById('pendingBar');
      if (count > 0) {
        bar.classList.add('visible');
        document.getElementById('pendingMsg').textContent = 'Pending: ' + count + ' change(s)';
      } else {
        bar.classList.remove('visible');
      }
    }
    `
        : ''
    }

    document.addEventListener('keydown', (e) => {
      if (${editable} && (e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (pendingChanges.size > 0) commitChanges();
      }
    });

    function exportCSV() {
      let csv = columns.map(escapeCsv).join(',') + '\\n';
      rows.forEach((row) => {
        csv += columns.map((col) => {
          const v = row[col];
          if (v === null) return 'NULL';
          return escapeCsv(String(v));
        }).join(',') + '\\n';
      });
      download(new Blob([csv], { type: 'text/csv' }), 'result.csv');
    }

    function download(blob, name) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; a.click();
      URL.revokeObjectURL(url);
    }

    function escapeCsv(str) {
      if (str.includes(',') || str.includes('"') || str.includes('\\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    }
  </script>
</body>
</html>`;
  }
}

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
