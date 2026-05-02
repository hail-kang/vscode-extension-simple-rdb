import * as vscode from 'vscode';
import type { ConnectionManager } from '../db/ConnectionManager';
import { formatDateTime } from '../utils';

interface ColumnInfo {
  name: string;
  dataType: string;
  columnType: string;
  isNullable: boolean;
  columnKey: string;
  extra: string;
  comment: string;
  isEnum: boolean;
  enumValues: string[];
}

interface RowData {
  _rowIndex: number;
  _original: Record<string, any>;
  [key: string]: any;
}

export class TableViewProvider {
  static readonly viewType = 'simple-rdb.tableData';

  private panel: vscode.WebviewPanel | null = null;

  constructor(
    private extensionUri: vscode.Uri,
    private connectionId: string,
    private database: string,
    private table: string,
    private manager: ConnectionManager,
  ) {}

  async open(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      TableViewProvider.viewType,
      `${this.database}.${this.table}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      },
    );

    this.panel.webview.html = this.getHtml();
    this.panel.onDidDispose(() => (this.panel = null));

    this.panel.webview.onDidReceiveMessage(async (message) => {
      await this.handleMessage(message);
    });
  }

  private async handleMessage(message: any): Promise<void> {
    try {
      switch (message.type) {
        case 'fetchColumns':
          await this.fetchColumns();
          break;
        case 'fetchData': {
          const { offset, limit } = message;
          await this.fetchData(offset, limit);
          break;
        }
        case 'updateRow': {
          const { primaryKeys, updates } = message;
          await this.manager.updateRow(this.database, this.table, primaryKeys, updates);
          this.postMessage({ type: 'updateSuccess' });
          break;
        }
        case 'insertRow': {
          const { values } = message;
          await this.manager.insertRow(this.database, this.table, values);
          this.postMessage({ type: 'insertSuccess' });
          break;
        }
        case 'deleteRow': {
          const { primaryKeys } = message;
          await this.manager.deleteRow(this.database, this.table, primaryKeys);
          this.postMessage({ type: 'deleteSuccess' });
          break;
        }
      }
    } catch (err: any) {
      this.postMessage({ type: 'error', message: err.message });
    }
  }

  private async fetchColumns(): Promise<void> {
    const columns = await this.manager.getTableColumns(this.database, this.table);
    const processed = columns.map((col: any) => {
      const isEnum = col.DATA_TYPE === 'enum';
      let enumValues: string[] = [];
      if (isEnum) {
        const match = col.COLUMN_TYPE.match(/enum\((.*)\)/i);
        if (match) {
          enumValues = match[1].split(',').map((v: string) => v.trim().replace(/^'|'$/g, ''));
        }
      }
      return {
        name: col.COLUMN_NAME,
        dataType: col.DATA_TYPE,
        columnType: col.COLUMN_TYPE,
        isNullable: col.IS_NULLABLE === 'YES',
        columnKey: col.COLUMN_KEY,
        extra: col.EXTRA,
        comment: col.COLUMN_COMMENT,
        isEnum,
        enumValues,
      };
    });
    this.postMessage({ type: 'columns', columns: processed });

    await this.fetchData(0, 100);
  }

  private async fetchData(offset: number, limit: number): Promise<void> {
    const { rows, total } = await this.manager.getTableData(
      this.database,
      this.table,
      offset,
      limit,
    );
    const rowData = rows.map((row: any, i: number) => {
      const formatted: any = {};
      for (const key of Object.keys(row)) {
        formatted[key] = row[key] instanceof Date ? formatDateTime(row[key]) : row[key];
      }
      formatted._rowIndex = offset + i;
      formatted._original = { ...row };
      return formatted;
    });
    this.postMessage({ type: 'data', rows: rowData, total, offset, limit });
  }

  private postMessage(message: any): void {
    this.panel?.webview.postMessage(message);
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${this.database}.${this.table}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, -apple-system, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 0;
      overflow: hidden;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-toolbar-background, var(--vscode-editor-background));
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
      white-space: nowrap;
    }
    .toolbar button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .toolbar button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .toolbar button.primary:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .toolbar button.danger {
      background: #c62828;
      color: #fff;
    }
    .spacer { flex: 1; }
    .table-wrapper {
      flex: 1;
      overflow: auto;
      position: relative;
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
      user-select: none;
    }
    th:hover {
      background: var(--vscode-list-hoverBackground);
    }
    th.pk { color: var(--vscode-symbolIcon-variableForeground); }
    th.nullable { font-style: italic; }
    td {
      cursor: default;
    }
    td.null-cell {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
    td.modified {
      background: var(--vscode-diffEditor-insertedTextBackground);
    }
    td.editing {
      padding: 0;
    }
    td.editing input, td.editing select {
      width: 100%;
      border: 2px solid var(--vscode-focusBorder);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      padding: 4px 8px;
      font-family: inherit;
      font-size: inherit;
      outline: none;
    }
    td.selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    tr.row-modified {
      position: relative;
    }
    tr.row-modified::before {
      content: '';
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 3px;
      background: var(--vscode-charts-yellow);
    }
    .pagination {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 8px;
      border-top: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .pagination button {
      padding: 2px 10px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 3px;
      cursor: pointer;
      font-size: 12px;
    }
    .pagination button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .pagination button:disabled {
      opacity: 0.4;
      cursor: default;
    }
    .context-menu {
      position: fixed;
      background: var(--vscode-menu-background);
      border: 1px solid var(--vscode-menu-border);
      border-radius: 4px;
      padding: 4px 0;
      min-width: 180px;
      z-index: 100;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      display: none;
    }
    .context-menu.visible { display: block; }
    .context-menu-item {
      padding: 4px 16px;
      cursor: pointer;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .context-menu-item:hover {
      background: var(--vscode-menu-selectionBackground);
      color: var(--vscode-menu-selectionForeground);
    }
    .context-menu-separator {
      height: 1px;
      background: var(--vscode-menu-separatorBackground);
      margin: 4px 0;
    }
    .pending-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      background: var(--vscode-statusBarItem-warningBackground);
      color: var(--vscode-statusBarItem-warningForeground);
      font-size: 12px;
      flex-shrink: 0;
    }
    .pending-bar.hidden { display: none; }
    .export-dropdown { position: relative; display: inline-block; }
    .export-dropdown .dropdown-menu {
      display: none;
      position: absolute;
      right: 0;
      top: 100%;
      margin-top: 2px;
      background: var(--vscode-menu-background);
      border: 1px solid var(--vscode-menu-border);
      border-radius: 4px;
      min-width: 160px;
      z-index: 200;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      padding: 4px 0;
    }
    .export-dropdown .dropdown-menu.visible { display: block; }
    .export-dropdown .dropdown-item {
      padding: 4px 16px;
      cursor: pointer;
      font-size: 12px;
    }
    .export-dropdown .dropdown-item:hover {
      background: var(--vscode-menu-selectionBackground);
      color: var(--vscode-menu-selectionForeground);
    }
    .export-dropdown .dropdown-separator {
      height: 1px;
      background: var(--vscode-menu-separatorBackground);
      margin: 2px 0;
    }
    .submenu-container {
      position: relative;
    }
    .submenu-container .context-submenu {
      display: none;
      position: absolute;
      left: 100%;
      top: 0;
      background: var(--vscode-menu-background);
      border: 1px solid var(--vscode-menu-border);
      border-radius: 4px;
      min-width: 170px;
      z-index: 101;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      padding: 4px 0;
    }
    .submenu-container:hover .context-submenu {
      display: block;
    }
    .row-num {
      color: var(--vscode-descriptionForeground);
      text-align: center;
      min-width: 40px !important;
      width: 40px;
      user-select: none;
      background: var(--vscode-sideBar-background);
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button onclick="refreshData()" title="Refresh">&#x21bb; Refresh</button>
    <button onclick="addRow()" title="Add Row">+ Row</button>
    <button id="commitBtn" class="primary hidden" onclick="commitChanges()" title="Apply Changes">
      Apply Changes (<span id="pendingCount">0</span>)
    </button>
    <button id="cancelBtn" class="hidden" onclick="cancelChanges()" title="Cancel Changes">Cancel</button>
    <span class="spacer"></span>
    <span id="rowCount" style="font-size:12px;color:var(--vscode-descriptionForeground)"></span>
    <div class="export-dropdown">
      <button onclick="event.stopPropagation(); toggleDropdown('exportMenu')" title="Export">Export &#x25BE;</button>
      <div class="dropdown-menu" id="exportMenu">
        <div class="dropdown-item" onclick="closeDropdown('exportMenu'); exportCSV()">Export as CSV</div>
        <div class="dropdown-item" onclick="closeDropdown('exportMenu'); exportJSON()">Export as JSON</div>
        <div class="dropdown-item" onclick="closeDropdown('exportMenu'); exportMarkdown()">Export as Markdown</div>
        <div class="dropdown-separator"></div>
        <div class="dropdown-item" onclick="closeDropdown('exportMenu'); exportExcel()">Export as Excel</div>
      </div>
    </div>
  </div>
  <div id="pendingBar" class="pending-bar hidden">
    <span id="pendingMsg"></span>
  </div>
  <div class="table-wrapper">
    <table id="dataTable">
      <thead><tr id="headerRow"></tr></thead>
      <tbody id="tableBody"></tbody>
    </table>
  </div>
  <div class="pagination">
    <button id="prevBtn" onclick="prevPage()" disabled>Previous</button>
    <span id="pageInfo">-</span>
    <button id="nextBtn" onclick="nextPage()" disabled>Next</button>
  </div>
  <div id="contextMenu" class="context-menu"></div>

  <script>
    const vscode = acquireVsCodeApi();
    let columns = [];
    let rows = [];
    let totalRows = 0;
    let currentOffset = 0;
    let pageSize = 100;
    let pendingChanges = new Map();
    let pendingInserts = [];
    let pendingDeletes = new Set();
    let selectedCell = null;
    let contextRow = null;
    let contextColIndex = null;
    let modifiedCells = new Set();
    let insertedRows = new Set();

    window.addEventListener('message', (e) => {
      const msg = e.data;
      switch (msg.type) {
        case 'columns':
          columns = msg.columns;
          renderHeaders();
          break;
        case 'data':
          rows = msg.rows;
          totalRows = msg.total;
          currentOffset = msg.offset;
          pageSize = msg.limit;
          renderRows();
          updatePagination();
          updateRowCount();
          break;
        case 'updateSuccess':
        case 'insertSuccess':
        case 'deleteSuccess':
          pendingChanges.clear();
          pendingInserts = [];
          pendingDeletes.clear();
          modifiedCells.clear();
          insertedRows.clear();
          updatePendingUI();
          refreshData();
          break;
        case 'error':
          alert(msg.message);
          break;
      }
    });

    vscode.postMessage({ type: 'fetchColumns' });

    function renderHeaders() {
      const headerRow = document.getElementById('headerRow');
      headerRow.innerHTML = '<th class="row-num">#</th>';
      columns.forEach((col) => {
        let classes = '';
        if (col.columnKey === 'PRI') classes += ' pk';
        if (col.isNullable) classes += ' nullable';
        headerRow.innerHTML += '<th class="' + classes + '" title="' +
          col.name + ' (' + col.dataType + ')' +
          (col.comment ? ' - ' + col.comment : '') +
          '">' + col.name + '</th>';
      });
    }

    function renderRows() {
      const tbody = document.getElementById('tableBody');
      tbody.innerHTML = '';
      rows.forEach((row, idx) => {
        const tr = document.createElement('tr');
        const isInserted = insertedRows.has(row._rowIndex);
        if (isInserted) tr.classList.add('row-modified');

        tr.innerHTML = '<td class="row-num">' + (row._rowIndex + 1) + '</td>';

        columns.forEach((col, colIdx) => {
          const td = document.createElement('td');
          const value = row[col.name];
          const cellKey = row._rowIndex + ':' + col.name;

          if (value === null) {
            td.textContent = 'NULL';
            td.classList.add('null-cell');
          } else if (typeof value === 'object' && value instanceof Date) {
            td.textContent = formatDateTime(value);
          } else {
            td.textContent = value !== undefined ? String(value) : '';
          }

          if (modifiedCells.has(cellKey)) {
            td.classList.add('modified');
          }
          if (isInserted) {
            td.classList.add('modified');
          }

          td.dataset.colIndex = colIdx;
          td.dataset.rowIndex = row._rowIndex;
          td.dataset.colName = col.name;

          td.addEventListener('click', (e) => selectCell(td, row, col, colIdx, e));
          td.addEventListener('dblclick', () => startEdit(td, row, col));
          td.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showContextMenu(e, row, col, colIdx);
          });

          tr.appendChild(td);
        });

        tbody.appendChild(tr);
      });
    }

    function selectCell(td, row, col, colIdx, event) {
      document.querySelectorAll('td.selected').forEach(el => el.classList.remove('selected'));
      td.classList.add('selected');
      selectedCell = { td, row, col, colIdx };
    }

    function startEdit(td, row, col) {
      if (td.classList.contains('editing')) return;

      const currentValue = row[col.name];

      if (col.isEnum) {
        td.innerHTML = '';
        td.classList.add('editing');
        const select = document.createElement('select');
        select.innerHTML = '<option value="__NULL__" ' + (currentValue === null ? 'selected' : '') + '>[NULL]</option>';
        col.enumValues.forEach((v) => {
          select.innerHTML += '<option value="' + escapeHtml(v) + '" ' +
            (currentValue === v ? 'selected' : '') + '>' + escapeHtml(v) + '</option>';
        });
        select.addEventListener('blur', () => finishEdit(td, row, col, select.value === '__NULL__' ? null : select.value));
        select.addEventListener('change', () => finishEdit(td, row, col, select.value === '__NULL__' ? null : select.value));
        td.appendChild(select);
        select.focus();
      } else {
        td.innerHTML = '';
        td.classList.add('editing');
        const input = document.createElement('input');
        input.value = currentValue === null ? '' : String(currentValue);
        if (currentValue === null) {
          input.placeholder = 'NULL';
        }
        input.addEventListener('blur', () => {
          const val = input.value.trim();
          finishEdit(td, row, col, val === '' ? null : val);
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            const val = input.value.trim();
            finishEdit(td, row, col, val === '' ? null : val);
          }
          if (e.key === 'Escape') {
            cancelEdit(td, row, col);
          }
        });
        td.appendChild(input);
        input.focus();
        input.select();
      }
    }

    function finishEdit(td, row, col, newValue) {
      td.classList.remove('editing');
      td.textContent = '';
      if (newValue === null) {
        td.textContent = 'NULL';
        td.classList.add('null-cell');
      } else {
        td.textContent = String(newValue);
        td.classList.remove('null-cell');
      }

      const oldValue = row[col.name];
      if (String(oldValue) !== String(newValue)) {
        row[col.name] = newValue;
        const cellKey = row._rowIndex + ':' + col.name;
        modifiedCells.add(cellKey);
        td.classList.add('modified');

        if (insertedRows.has(row._rowIndex)) {
          const insIdx = pendingInserts.findIndex((p) => p._rowIndex === row._rowIndex);
          if (insIdx >= 0) {
            if (newValue !== null) {
              pendingInserts[insIdx].values[col.name] = newValue;
            }
            return;
          }
        }

        const changeKey = JSON.stringify(getPrimaryKeys(row));
        if (!pendingChanges.has(changeKey)) {
          pendingChanges.set(changeKey, { primaryKeys: getPrimaryKeys(row), updates: {} });
        }
        pendingChanges.get(changeKey).updates[col.name] = newValue;
        updatePendingUI();
      }
    }

    function cancelEdit(td, row, col) {
      td.classList.remove('editing');
      td.textContent = '';
      const value = row[col.name];
      if (value === null) {
        td.textContent = 'NULL';
        td.classList.add('null-cell');
      } else {
        td.textContent = String(value);
      }
    }

    function getPrimaryKeys(row) {
      const pks = {};
      columns.forEach((col) => {
        if (col.columnKey === 'PRI') {
          pks[col.name] = row._original[col.name];
        }
      });
      if (Object.keys(pks).length === 0) {
        columns.forEach((col) => {
          pks[col.name] = row._original[col.name];
        });
      }
      return pks;
    }

    function addRow() {
      const newRowIndex = -1 - pendingInserts.length;
      const newRow = { _rowIndex: newRowIndex };
      columns.forEach((col) => {
        newRow[col.name] = null;
      });
      newRow._original = {};
      columns.forEach((col) => {
        newRow._original[col.name] = null;
      });

      pendingInserts.push({ _rowIndex: newRowIndex, values: {} });
      insertedRows.add(newRowIndex);

      rows.push(newRow);
      renderRows();
      updatePendingUI();
    }

    function duplicateRow() {
      if (!contextRow) return;
      const newRowIndex = -1 - pendingInserts.length;
      const newRow = { ...contextRow };
      newRow._rowIndex = newRowIndex;
      newRow._original = {};
      columns.forEach((col) => {
        if (col.columnKey === 'PRI' && col.extra.includes('auto_increment')) {
          newRow[col.name] = null;
        }
        newRow._original[col.name] = newRow[col.name];
      });

      const values = {};
      columns.forEach((col) => {
        if (!(col.columnKey === 'PRI' && col.extra.includes('auto_increment'))) {
          if (newRow[col.name] !== null) {
            values[col.name] = newRow[col.name];
          }
        }
      });

      pendingInserts.push({ _rowIndex: newRowIndex, values });
      insertedRows.add(newRowIndex);

      rows.push(newRow);
      renderRows();
      updatePendingUI();
    }

    function deleteRow() {
      if (!contextRow) return;
      const rowId = contextRow._rowIndex;

      if (insertedRows.has(rowId)) {
        insertedRows.delete(rowId);
        pendingInserts = pendingInserts.filter((p) => p._rowIndex !== rowId);
        rows = rows.filter((r) => r._rowIndex !== rowId);
      } else {
        const pks = getPrimaryKeys(contextRow);
        pendingDeletes.add(JSON.stringify(pks));
        rows = rows.filter((r) => r._rowIndex !== rowId);
      }

      renderRows();
      updatePendingUI();
    }

    function setNull() {
      if (!contextRow || contextColIndex === null) return;
      const col = columns[contextColIndex];
      const row = contextRow;

      row[col.name] = null;
      const cellKey = row._rowIndex + ':' + col.name;
      modifiedCells.add(cellKey);

      if (insertedRows.has(row._rowIndex)) {
        const insIdx = pendingInserts.findIndex((p) => p._rowIndex === row._rowIndex);
        if (insIdx >= 0) {
          delete pendingInserts[insIdx].values[col.name];
        }
      } else {
        const changeKey = JSON.stringify(getPrimaryKeys(row));
        if (!pendingChanges.has(changeKey)) {
          pendingChanges.set(changeKey, { primaryKeys: getPrimaryKeys(row), updates: {} });
        }
        pendingChanges.get(changeKey).updates[col.name] = null;
      }

      renderRows();
      updatePendingUI();
    }

    function setNow() {
      if (!contextRow || contextColIndex === null) return;
      const col = columns[contextColIndex];
      const row = contextRow;

      const now = formatDateTime(new Date());
      row[col.name] = now;
      const cellKey = row._rowIndex + ':' + col.name;
      modifiedCells.add(cellKey);

      if (insertedRows.has(row._rowIndex)) {
        const insIdx = pendingInserts.findIndex((p) => p._rowIndex === row._rowIndex);
        if (insIdx >= 0) {
          pendingInserts[insIdx].values[col.name] = now;
        }
      } else {
        const changeKey = JSON.stringify(getPrimaryKeys(row));
        if (!pendingChanges.has(changeKey)) {
          pendingChanges.set(changeKey, { primaryKeys: getPrimaryKeys(row), updates: {} });
        }
        pendingChanges.get(changeKey).updates[col.name] = now;
      }

      renderRows();
      updatePendingUI();
    }

    function copyValue() {
      if (!contextRow || contextColIndex === null) return;
      const col = columns[contextColIndex];
      const value = contextRow[col.name];
      navigator.clipboard.writeText(value === null ? 'NULL' : String(value));
    }

    function commitChanges() {
      for (const [, change] of pendingChanges) {
        vscode.postMessage({ type: 'updateRow', primaryKeys: change.primaryKeys, updates: change.updates });
      }
      for (const ins of pendingInserts) {
        vscode.postMessage({ type: 'insertRow', values: ins.values });
      }
      for (const delStr of pendingDeletes) {
        vscode.postMessage({ type: 'deleteRow', primaryKeys: JSON.parse(delStr) });
      }
    }

    function updatePendingUI() {
      const count = pendingChanges.size + pendingInserts.length + pendingDeletes.size;
      document.getElementById('pendingCount').textContent = count;
      const commitBtn = document.getElementById('commitBtn');
      const cancelBtn = document.getElementById('cancelBtn');
      const pendingBar = document.getElementById('pendingBar');
      if (count > 0) {
        commitBtn.classList.remove('hidden');
        cancelBtn.classList.remove('hidden');
        pendingBar.classList.remove('hidden');
        document.getElementById('pendingMsg').textContent =
          'Pending: ' + pendingChanges.size + ' update(s), ' +
          pendingInserts.length + ' insert(s), ' + pendingDeletes.size + ' delete(s)';
      } else {
        commitBtn.classList.add('hidden');
        cancelBtn.classList.add('hidden');
        pendingBar.classList.add('hidden');
      }
    }

    function cancelChanges() {
      pendingChanges.clear();
      pendingInserts = [];
      pendingDeletes.clear();
      modifiedCells.clear();
      insertedRows.clear();
      updatePendingUI();
      refreshData();
    }

    function showContextMenu(e, row, col, colIdx) {
      contextRow = row;
      contextColIndex = colIdx;

      const menu = document.getElementById('contextMenu');
      menu.innerHTML = '';

      const temporalTypes = ['datetime', 'timestamp', 'date', 'time'];
      const isTemporal = temporalTypes.includes(col.dataType);

      addMenuItem(menu, 'Set NULL', () => setNull());
      if (isTemporal) {
        addMenuItem(menu, 'Set NOW()', () => setNow());
      }
      addSeparator(menu);
      addMenuItem(menu, 'Copy Value', () => copyValue());
      addSeparator(menu);
      addSubMenuItem(menu, 'Advanced Copy \u25B8', [
        { label: 'Copy as CSV', action: () => copyAsCSV() },
        { label: 'Copy as JSON', action: () => copyAsJSON() },
        { label: 'Copy as Markdown', action: () => copyAsMarkdown() },
      ]);
      addSeparator(menu);
      addMenuItem(menu, 'Duplicate Row', () => duplicateRow());
      addMenuItem(menu, 'Delete Row', () => deleteRow(), 'danger');

      menu.style.left = e.clientX + 'px';
      menu.style.top = e.clientY + 'px';
      menu.classList.add('visible');

      const closeMenu = () => {
        menu.classList.remove('visible');
        document.removeEventListener('click', closeMenu);
      };
      setTimeout(() => document.addEventListener('click', closeMenu), 0);
    }

    function addMenuItem(menu, label, action, cls) {
      const item = document.createElement('div');
      item.className = 'context-menu-item' + (cls ? ' ' + cls : '');
      item.textContent = label;
      item.addEventListener('click', () => {
        menu.classList.remove('visible');
        action();
      });
      menu.appendChild(item);
    }

    function addSeparator(menu) {
      const sep = document.createElement('div');
      sep.className = 'context-menu-separator';
      menu.appendChild(sep);
    }

    function addSubMenuItem(menu, label, items) {
      const container = document.createElement('div');
      container.className = 'context-menu-item submenu-container';
      container.innerHTML = '<span>' + label + '</span>';
      const submenu = document.createElement('div');
      submenu.className = 'context-submenu';
      items.forEach((item) => {
        const child = document.createElement('div');
        child.className = 'context-menu-item';
        child.textContent = item.label;
        child.addEventListener('click', () => {
          hideAllMenus();
          item.action();
        });
        submenu.appendChild(child);
      });
      container.appendChild(submenu);
      menu.appendChild(container);
    }

    function hideAllMenus() {
      document.getElementById('contextMenu').classList.remove('visible');
      document.querySelectorAll('.dropdown-menu.visible').forEach((m) => m.classList.remove('visible'));
    }

    function toggleDropdown(id) {
      const menu = document.getElementById(id);
      const isVisible = menu.classList.contains('visible');
      document.querySelectorAll('.dropdown-menu.visible').forEach((m) => m.classList.remove('visible'));
      if (!isVisible) {
        menu.classList.add('visible');
      }
    }

    function closeDropdown(id) {
      document.getElementById(id).classList.remove('visible');
    }

    function updatePagination() {
      const totalPages = Math.ceil(totalRows / pageSize);
      const currentPage = Math.floor(currentOffset / pageSize) + 1;
      document.getElementById('pageInfo').textContent =
        'Page ' + currentPage + ' of ' + totalPages + ' (' + totalRows.toLocaleString() + ' rows)';
      document.getElementById('prevBtn').disabled = currentOffset <= 0;
      document.getElementById('nextBtn').disabled = currentOffset + pageSize >= totalRows;
    }

    function updateRowCount() {
      document.getElementById('rowCount').textContent = rows.length + ' rows loaded';
    }

    function prevPage() {
      currentOffset = Math.max(0, currentOffset - pageSize);
      vscode.postMessage({ type: 'fetchData', offset: currentOffset, limit: pageSize });
    }

    function nextPage() {
      currentOffset = currentOffset + pageSize;
      vscode.postMessage({ type: 'fetchData', offset: currentOffset, limit: pageSize });
    }

    function refreshData() {
      vscode.postMessage({ type: 'fetchData', offset: currentOffset, limit: pageSize });
    }

    function exportCSV() {
      let csv = columns.map((c) => escapeCsv(c.name)).join(',') + '\\n';
      rows.forEach((row) => {
        csv += columns.map((col) => {
          const v = row[col.name];
          if (v === null) return 'NULL';
          return escapeCsv(String(v));
        }).join(',') + '\\n';
      });

      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = '${this.table}.csv';
      a.click();
      URL.revokeObjectURL(url);
    }

    function exportExcel() {
      let html = '<table>';
      html += '<tr>' + columns.map((c) => '<th>' + escapeHtml(c.name) + '</th>').join('') + '</tr>';
      rows.forEach((row) => {
        html += '<tr>' + columns.map((col) => {
          const v = row[col.name];
          if (v === null) return '<td>NULL</td>';
          return '<td>' + escapeHtml(String(v)) + '</td>';
        }).join('') + '</tr>';
      });
      html += '</table>';

      const blob = new Blob([html], { type: 'application/vnd.ms-excel' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = '${this.table}.xls';
      a.click();
      URL.revokeObjectURL(url);
    }

    function exportJSON() {
      const data = rows.map((row) => {
        const obj = {};
        columns.forEach((col) => {
          obj[col.name] = row[col.name];
        });
        return obj;
      });
      download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), '${this.table}.json');
    }

    function exportMarkdown() {
      let md = '| ' + columns.map((c) => c.name).join(' | ') + ' |\\n';
      md += '| ' + columns.map(() => '---').join(' | ') + ' |\\n';
      rows.forEach((row) => {
        md += '| ' + columns.map((col) => {
          const v = row[col.name];
          if (v === null) return 'NULL';
          return String(v).replace(/\\|/g, '\\\\|').replace(/\\n/g, ' ');
        }).join(' | ') + ' |\\n';
      });
      download(new Blob([md], { type: 'text/markdown' }), '${this.table}.md');
    }

    function download(blob, name) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; a.click();
      URL.revokeObjectURL(url);
    }

    function copyAsCSV() {
      let csv = columns.map((c) => escapeCsv(c.name)).join(',') + '\\n';
      rows.forEach((row) => {
        csv += columns.map((col) => {
          const v = row[col.name];
          if (v === null) return 'NULL';
          return escapeCsv(String(v));
        }).join(',') + '\\n';
      });
      navigator.clipboard.writeText(csv);
    }

    function copyAsJSON() {
      const data = rows.map((row) => {
        const obj = {};
        columns.forEach((col) => {
          obj[col.name] = row[col.name];
        });
        return obj;
      });
      navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    }

    function copyAsMarkdown() {
      let md = '| ' + columns.map((c) => c.name).join(' | ') + ' |\\n';
      md += '| ' + columns.map(() => '---').join(' | ') + ' |\\n';
      rows.forEach((row) => {
        md += '| ' + columns.map((col) => {
          const v = row[col.name];
          if (v === null) return 'NULL';
          return String(v).replace(/\\|/g, '\\\\|').replace(/\\n/g, ' ');
        }).join(' | ') + ' |\\n';
      });
      navigator.clipboard.writeText(md);
    }

    function escapeCsv(str) {
      if (str.includes(',') || str.includes('"') || str.includes('\\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    }

    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function formatDateTime(date) {
      const d = new Date(date);
      const pad = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' +
        pad(d.getMonth() + 1) + '-' +
        pad(d.getDate()) + ' ' +
        pad(d.getHours()) + ':' +
        pad(d.getMinutes()) + ':' +
        pad(d.getSeconds());
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' && contextRow && !document.querySelector('td.editing')) {
        deleteRow();
      }
      if (e.key === 'Enter' && selectedCell) {
        startEdit(selectedCell.td, selectedCell.row, selectedCell.col);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (pendingChanges.size + pendingInserts.length + pendingDeletes.size > 0) {
          commitChanges();
        }
      }
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.export-dropdown')) {
        document.querySelectorAll('.dropdown-menu.visible').forEach((m) => m.classList.remove('visible'));
      }
    });
  </script>
</body>
</html>`;
  }
}
