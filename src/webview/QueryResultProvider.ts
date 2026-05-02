import * as vscode from 'vscode';
import { formatDateTime } from '../utils';

export class QueryResultProvider {
  private panel: vscode.WebviewPanel | null = null;

  constructor(private extensionUri: vscode.Uri) {}

  show(columns: string[], rows: Record<string, any>[], sql: string): void {
    if (this.panel) {
      this.panel.dispose();
    }

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

    this.panel.webview.html = this.getHtml(columns, rows, sql);
    this.panel.onDidDispose(() => (this.panel = null));
  }

  private getHtml(columns: string[], rows: Record<string, any>[], sql: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Query Result</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, -apple-system, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .sql-bar {
      padding: 8px 12px;
      background: var(--vscode-editor-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      white-space: pre-wrap;
      max-height: 80px;
      overflow: auto;
      flex-shrink: 0;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .toolbar button {
      padding: 4px 12px;
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border-radius: 3px;
      cursor: pointer;
      font-size: 12px;
    }
    .toolbar button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .spacer { flex: 1; }
    .row-count {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .table-wrapper {
      flex: 1;
      overflow: auto;
    }
    table {
      border-collapse: collapse;
      width: max-content;
      min-width: 100%;
    }
    th, td {
      border: 1px solid var(--vscode-panel-border);
      padding: 4px 10px;
      white-space: nowrap;
      min-width: 80px;
      max-width: 400px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    th {
      position: sticky;
      top: 0;
      background: var(--vscode-editor-background);
      z-index: 2;
      font-weight: 600;
      text-align: left;
    }
    td.null-cell {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
  </style>
</head>
<body>
  <div class="sql-bar">${escapeHtml(sql)}</div>
  <div class="toolbar">
    <span class="row-count">${rows.length} row(s)</span>
    <span class="spacer"></span>
    <button onclick="exportCSV()">Export CSV</button>
    <button onclick="exportExcel()">Export Excel</button>
  </div>
  <div class="table-wrapper">
    <table>
      <thead><tr>${columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
      <tbody>
        ${rows
          .map(
            (row) =>
              `<tr>${columns
                .map((col) => {
                  const v = row[col];
                  const cls = v === null ? 'null-cell' : '';
                  return `<td class="${cls}">${v === null ? 'NULL' : escapeHtml(formatDateTime(v))}</td>`;
                })
                .join('')}</tr>`,
          )
          .join('')}
      </tbody>
    </table>
  </div>
  <script>
    const columns = ${JSON.stringify(columns)};
    const rows = ${JSON.stringify(rows)};

    function exportCSV() {
      let csv = columns.map(escapeCsv).join(',') + '\\n';
      rows.forEach((row) => {
        csv += columns.map((col) => {
          const v = row[col];
          if (v === null) return 'NULL';
          return escapeCsv(String(v));
        }).join(',') + '\\n';
      });
      const blob = new Blob([csv], { type: 'text/csv' });
      download(blob, 'result.csv');
    }

    function exportExcel() {
      let html = '<table><tr>' + columns.map(c => '<th>' + escapeHtml(c) + '</th>').join('') + '</tr>';
      rows.forEach((row) => {
        html += '<tr>' + columns.map(col => {
          const v = row[col];
          return '<td>' + (v === null ? 'NULL' : escapeHtml(String(v))) + '</td>';
        }).join('') + '</tr>';
      });
      html += '</table>';
      const blob = new Blob([html], { type: 'application/vnd.ms-excel' });
      download(blob, 'result.xls');
    }

    function download(blob, name) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    }

    function escapeCsv(str) {
      if (str.includes(',') || str.includes('"') || str.includes('\\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    }

    function escapeHtml(str) {
      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
