import * as vscode from 'vscode';
import type { ConnectionManager } from '../db/ConnectionManager';
import { toDisplayValue } from '../utils';
import { cspMetaTag, escapeHtml, toSafeJson } from './webviewSecurity';

/** 그리드에서 인라인 편집을 막을 컬럼 타입(값이 Buffer/객체로 와서 문자열 편집 시 훼손됨). */
const READONLY_COLUMN_TYPES = new Set([
  'blob',
  'tinyblob',
  'mediumblob',
  'longblob',
  'binary',
  'varbinary',
  'json',
  'geometry',
  'point',
  'linestring',
  'polygon',
  'multipoint',
  'multilinestring',
  'multipolygon',
  'geometrycollection',
]);

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
        case 'confirmDelete': {
          const result = await vscode.window.showWarningMessage(
            message.message,
            { modal: true },
            'Delete',
          );
          if (result === 'Delete') {
            for (const target of message.targets) {
              if (Object.keys(target.primaryKeys).length > 0) {
                await this.manager.deleteRow(this.database, this.table, target.primaryKeys);
              }
            }
            this.postMessage({
              type: 'deleteSuccess',
              indices: message.targets.map((t: any) => t.index)
            });
          }
          break;
        }
        case 'confirmCommitDeletes': {
          const result = await vscode.window.showWarningMessage(
            message.message,
            { modal: true },
            'Delete',
          );
          if (result === 'Delete') {
            this.postMessage({ type: 'doCommit' });
          }
          break;
        }
        case 'error':
          vscode.window.showErrorMessage(message.message);
          break;
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
        readonly: READONLY_COLUMN_TYPES.has(col.DATA_TYPE),
      };
    });
    this.postMessage({ type: 'columns', columns: processed });

    const pageSize = vscode.workspace.getConfiguration('simpleRdb').get('pageSize', 100);
    await this.fetchData(0, pageSize);
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
        formatted[key] = toDisplayValue(row[key]);
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
    const cspSource = this.panel!.webview.cspSource;
    const maxBulkDelete = vscode.workspace.getConfiguration('simpleRdb').get('maxBulkDelete', 100);
    const title = escapeHtml(`${this.database}.${this.table}`);
    // 파일명은 <script> 안의 JS 문자열로 들어가므로 toSafeJson으로 </script> 조기 종료도 차단
    const csvName = toSafeJson(`${this.table}.csv`);
    const xlsName = toSafeJson(`${this.table}.xls`);
    const jsonName = toSafeJson(`${this.table}.json`);
    const mdName = toSafeJson(`${this.table}.md`);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  ${cspMetaTag(cspSource)}
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
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
      cursor: pointer;
    }
    .row-num:hover {
      background: var(--vscode-list-hoverBackground);
      color: var(--vscode-list-hoverForeground);
    }
    .row-num.selected {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    tr.row-selected td:not(.row-num) {
      background: var(--vscode-list-activeSelectionBackground, rgba(0, 122, 204, 0.12));
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
      <button onclick="event.stopPropagation(); toggleDropdown('exportMenu')" title="Export">Export <span style="font-size:9px;opacity:0.7;margin-left:2px;">&#x25BE;</span></button>
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
    let selectedRows = new Set();
    let anchorRow = null;
    // 다중 셀 선택: 키는 "rowIndex#colIdx"(rowIndex는 insert 시 음수 가능). colName의 ':' 충돌을 피해 '#' 사용.
    let selectedCells = new Set();
    let cellAnchor = null; // { rowIndex, colIdx } - 범위 선택/붙여넣기 기준점
    let isDragging = false;

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
          pendingChanges.clear();
          pendingInserts = [];
          pendingDeletes.clear();
          modifiedCells.clear();
          insertedRows.clear();
          selectedRows.clear();
          anchorRow = null;
          clearCellSelection();
          updatePendingUI();
          refreshData();
          break;
        case 'deleteSuccess': {
          // 즉시 삭제는 이미 커밋됨. 삭제된 행과 그 pending만 제거하고 나머지 편집 버퍼는 보존한다(M-22).
          const deleted = new Set(msg.indices || []);
          for (const ri of deleted) {
            pendingInserts = pendingInserts.filter((p) => p._rowIndex !== ri);
            insertedRows.delete(ri);
            const row = rows.find((r) => r._rowIndex === ri);
            if (row) {
              pendingChanges.delete(JSON.stringify(getPrimaryKeys(row)));
            }
            for (const k of [...modifiedCells]) {
              if (k.startsWith(ri + ':')) modifiedCells.delete(k);
            }
          }
          selectedRows.clear();
          anchorRow = null;
          if (pendingChanges.size + pendingInserts.length > 0) {
            // 편집 버퍼가 남아 있으면 재조회로 덮어쓰지 않고 로컬에서만 삭제를 반영한다.
            rows = rows.filter((r) => !deleted.has(r._rowIndex));
            totalRows = Math.max(0, totalRows - deleted.size);
            updatePendingUI();
            renderRows();
            updatePagination();
            updateRowCount();
          } else {
            updatePendingUI();
            refreshData();
          }
          break;
        }
        case 'error':
          vscode.postMessage({ type: 'error', message: msg.message });
          break;
        case 'doCommit':
          // Re-trigger commit without checks
          for (const [, change] of pendingChanges) {
            vscode.postMessage({ type: 'updateRow', primaryKeys: change.primaryKeys, updates: change.updates });
          }
          for (const ins of pendingInserts) {
            vscode.postMessage({ type: 'insertRow', values: ins.values });
          }
          for (const delStr of pendingDeletes) {
            vscode.postMessage({ type: 'deleteRow', primaryKeys: JSON.parse(delStr) });
          }
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
        const title = escapeHtml(
          col.name + ' (' + col.dataType + ')' + (col.comment ? ' - ' + col.comment : ''),
        );
        headerRow.innerHTML +=
          '<th class="' + classes + '" title="' + title + '">' + escapeHtml(col.name) + '</th>';
      });
    }

    function renderRows() {
      const tbody = document.getElementById('tableBody');
      tbody.innerHTML = '';
      if (rows.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = columns.length + 1;
        td.textContent = 'No rows';
        td.style.textAlign = 'center';
        td.style.padding = '16px';
        td.style.color = 'var(--vscode-descriptionForeground)';
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
      }
      rows.forEach((row, idx) => {
        const tr = document.createElement('tr');
        const isInserted = insertedRows.has(row._rowIndex);
        if (isInserted) tr.classList.add('row-modified');
        if (selectedRows.has(row._rowIndex)) tr.classList.add('row-selected');

        const rowNumTd = document.createElement('td');
        rowNumTd.className = 'row-num';
        if (selectedRows.has(row._rowIndex)) rowNumTd.classList.add('selected');
        rowNumTd.textContent = String(row._rowIndex + 1);
        rowNumTd.addEventListener('click', (e) => toggleRowSelection(row._rowIndex, e));
        rowNumTd.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          if (!selectedRows.has(row._rowIndex)) {
            selectedRows.clear();
            selectedRows.add(row._rowIndex);
            anchorRow = row._rowIndex;
            renderRows();
          }
          contextRow = row;
          contextColIndex = null;
          showContextMenu(e, row, null, null);
        });
        tr.appendChild(rowNumTd);

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
          if (selectedCells.has(row._rowIndex + '#' + colIdx)) {
            td.classList.add('selected');
          }

          td.dataset.colIndex = colIdx;
          td.dataset.rowIndex = row._rowIndex;
          td.dataset.colName = col.name;

          td.addEventListener('mousedown', (e) => {
            if (e.button !== 0 || td.classList.contains('editing')) return;
            if (e.shiftKey) {
              selectCellRangeTo(row._rowIndex, colIdx);
            } else if (e.ctrlKey || e.metaKey) {
              toggleCell(row, colIdx);
            } else {
              selectSingleCell(row, colIdx);
              isDragging = true;
            }
            applyCellSelectionClasses();
            e.preventDefault();
          });
          td.addEventListener('mouseover', () => {
            if (isDragging) {
              selectCellRangeTo(row._rowIndex, colIdx);
              applyCellSelectionClasses();
            }
          });
          td.addEventListener('dblclick', () => startEdit(td, row, col));
          td.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (!selectedCells.has(row._rowIndex + '#' + colIdx)) {
              selectSingleCell(row, colIdx);
              applyCellSelectionClasses();
            }
            showContextMenu(e, row, col, colIdx);
          });

          tr.appendChild(td);
        });

        tbody.appendChild(tr);
      });
    }

    function cellKeyOf(rowIndex, colIdx) {
      return rowIndex + '#' + colIdx;
    }

    function applyCellSelectionClasses() {
      document.querySelectorAll('#tableBody td.selected:not(.row-num)').forEach((el) => el.classList.remove('selected'));
      document.querySelectorAll('#tableBody td[data-col-index]').forEach((td) => {
        if (selectedCells.has(td.dataset.rowIndex + '#' + td.dataset.colIndex)) {
          td.classList.add('selected');
        }
      });
    }

    function selectSingleCell(row, colIdx) {
      selectedCells.clear();
      selectedCells.add(cellKeyOf(row._rowIndex, colIdx));
      cellAnchor = { rowIndex: row._rowIndex, colIdx };
      selectedCell = { row, col: columns[colIdx], colIdx };
    }

    function toggleCell(row, colIdx) {
      const key = cellKeyOf(row._rowIndex, colIdx);
      if (selectedCells.has(key)) {
        selectedCells.delete(key);
      } else {
        selectedCells.add(key);
      }
      cellAnchor = { rowIndex: row._rowIndex, colIdx };
      selectedCell = { row, col: columns[colIdx], colIdx };
    }

    function selectCellRangeTo(rowIndex, colIdx) {
      if (!cellAnchor) {
        cellAnchor = { rowIndex, colIdx };
      }
      const posOf = (ri) => rows.findIndex((r) => r._rowIndex === ri);
      const ra = posOf(cellAnchor.rowIndex);
      const rb = posOf(rowIndex);
      if (ra < 0 || rb < 0) return;
      const rlo = Math.min(ra, rb), rhi = Math.max(ra, rb);
      const clo = Math.min(cellAnchor.colIdx, colIdx), chi = Math.max(cellAnchor.colIdx, colIdx);
      selectedCells.clear();
      for (let r = rlo; r <= rhi; r++) {
        for (let c = clo; c <= chi; c++) {
          selectedCells.add(cellKeyOf(rows[r]._rowIndex, c));
        }
      }
    }

    function clearCellSelection() {
      selectedCells.clear();
      cellAnchor = null;
      selectedCell = null;
    }

    function toggleRowSelection(rowIndex, event) {
      if (event.shiftKey && anchorRow !== null) {
        const rowsInView = rows.filter((r) => !insertedRows.has(r._rowIndex)).map((r) => r._rowIndex);
        const anchorIdx = rowsInView.indexOf(anchorRow);
        const targetIdx = rowsInView.indexOf(rowIndex);
        if (anchorIdx === -1 || targetIdx === -1) return;
        const start = Math.min(anchorIdx, targetIdx);
        const end = Math.max(anchorIdx, targetIdx);
        selectedRows.clear();
        for (let i = start; i <= end; i++) { selectedRows.add(rowsInView[i]); }
      } else if (event.ctrlKey || event.metaKey) {
        if (selectedRows.has(rowIndex)) {
          selectedRows.delete(rowIndex);
        } else {
          selectedRows.add(rowIndex);
          anchorRow = rowIndex;
        }
      } else {
        // 이미 이 행만 선택돼 있으면 다시 클릭 시 해제(토글)한다.
        const wasOnlySelected = selectedRows.size === 1 && selectedRows.has(rowIndex);
        selectedRows.clear();
        if (wasOnlySelected) {
          anchorRow = null;
        } else {
          selectedRows.add(rowIndex);
          anchorRow = rowIndex;
        }
      }
      renderRows();
    }

    function startEdit(td, row, col) {
      if (td.classList.contains('editing')) return;
      if (col.readonly) {
        vscode.postMessage({ type: 'error', message: '이 컬럼(BLOB/JSON/이진 타입)은 그리드에서 편집할 수 없습니다.' });
        return;
      }

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
          finishEdit(td, row, col, input.value);
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            finishEdit(td, row, col, input.value);
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
      // NULL 셀을 열었다 빈 값으로 나가면 NULL→'' 변경으로 오인해 큐잉하지 않는다
      if (row[col.name] === null && newValue === '') {
        td.textContent = 'NULL';
        td.classList.add('null-cell');
        return;
      }
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

    function hasPrimaryKey() {
      return columns.some((col) => col.columnKey === 'PRI');
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

    function deleteSelectedRows() {
      const MAX_DELETE = ${maxBulkDelete};
      let targets = [];
      if (selectedRows.size > 0) {
        targets = [...selectedRows].map((ri) => rows.find((r) => r._rowIndex === ri)).filter(Boolean);
      } else if (contextRow) {
        targets = [contextRow];
      }
      if (targets.length === 0) return;
      const existingTargets = targets.filter((r) => !insertedRows.has(r._rowIndex));
      if (existingTargets.length > 0 && !hasPrimaryKey()) {
        vscode.postMessage({ type: 'error', message: 'Cannot delete rows: this table has no primary key.' });
        return;
      }
      if (existingTargets.length > MAX_DELETE) {
        vscode.postMessage({ type: 'error', message: 'Cannot delete more than ' + MAX_DELETE + ' rows at once.' });
        return;
      }

      if (existingTargets.length > 0) {
        vscode.postMessage({
          type: 'confirmDelete',
          message: 'Delete ' + existingTargets.length + ' row(s)? This cannot be undone.',
          targets: targets.map(r => ({
            index: r._rowIndex,
            primaryKeys: r._rowIndex < 0 ? {} : getPrimaryKeys(r)
          }))
        });
      } else {
        // Only pending inserts selected, can delete immediately
        for (const row of targets) {
          const rowId = row._rowIndex;
          insertedRows.delete(rowId);
          pendingInserts = pendingInserts.filter((p) => p._rowIndex !== rowId);
          rows = rows.filter((r) => r._rowIndex !== rowId);
        }
        selectedRows.clear();
        anchorRow = null;
        renderRows();
        updatePendingUI();
      }
    }

    function deleteRow() {
      // This function seems redundant now that deleteSelectedRows handles contextRow
      deleteSelectedRows();
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

    /** 셀 값 하나를 편집 버퍼(pending)에 반영한다. 값이 실제로 바뀌었으면 true. */
    function commitCellValue(row, col, newValue) {
      if (col.readonly) return false;
      const oldValue = row[col.name];
      if (oldValue === null && newValue === null) return false;
      if (oldValue !== null && newValue !== null && String(oldValue) === String(newValue)) return false;

      row[col.name] = newValue;
      modifiedCells.add(row._rowIndex + ':' + col.name);

      if (insertedRows.has(row._rowIndex)) {
        const insIdx = pendingInserts.findIndex((p) => p._rowIndex === row._rowIndex);
        if (insIdx >= 0) {
          if (newValue === null) {
            delete pendingInserts[insIdx].values[col.name];
          } else {
            pendingInserts[insIdx].values[col.name] = newValue;
          }
        }
      } else {
        const changeKey = JSON.stringify(getPrimaryKeys(row));
        if (!pendingChanges.has(changeKey)) {
          pendingChanges.set(changeKey, { primaryKeys: getPrimaryKeys(row), updates: {} });
        }
        pendingChanges.get(changeKey).updates[col.name] = newValue;
      }
      return true;
    }

    /** 클립보드 텍스트를 2차원 배열로. 개행=행, 탭=열. */
    function parseClipboardGrid(text) {
      const normalized = String(text)
        .replace(/\\r\\n/g, '\\n')
        .replace(/\\r/g, '\\n')
        .replace(/\\n$/, '');
      return normalized.split('\\n').map((line) => line.split('\\t'));
    }

    async function pasteFromClipboard() {
      let text;
      try {
        text = await navigator.clipboard.readText();
      } catch {
        vscode.postMessage({ type: 'error', message: '클립보드를 읽을 수 없습니다.' });
        return;
      }
      if (text === '' || text == null) return;
      if (selectedCells.size === 0) return;

      const grid = parseClipboardGrid(text);
      const isSingle = grid.length === 1 && grid[0].length === 1;
      let changed = false;

      if (isSingle) {
        // 단일 값: 선택된 모든 셀에 동일하게 채운다.
        const val = grid[0][0];
        for (const key of selectedCells) {
          const [riStr, ciStr] = key.split('#');
          const row = rows.find((r) => r._rowIndex === Number(riStr));
          const col = columns[Number(ciStr)];
          if (row && col && commitCellValue(row, col, val)) changed = true;
        }
      } else {
        // 블록: 선택 영역의 좌상단을 기준으로 행/열 방향으로 붙여넣는다.
        let minPos = Infinity, minCol = Infinity;
        for (const key of selectedCells) {
          const [riStr, ciStr] = key.split('#');
          const pos = rows.findIndex((r) => r._rowIndex === Number(riStr));
          if (pos >= 0 && pos < minPos) minPos = pos;
          const c = Number(ciStr);
          if (c < minCol) minCol = c;
        }
        if (!isFinite(minPos) || !isFinite(minCol)) return;
        const affected = [];
        for (let ri = 0; ri < grid.length; ri++) {
          for (let ci = 0; ci < grid[ri].length; ci++) {
            const pos = minPos + ri;
            const colIdx = minCol + ci;
            if (pos >= rows.length || colIdx >= columns.length) continue;
            const row = rows[pos];
            const col = columns[colIdx];
            if (commitCellValue(row, col, grid[ri][ci])) changed = true;
            affected.push(cellKeyOf(row._rowIndex, colIdx));
          }
        }
        selectedCells = new Set(affected);
      }

      if (changed) updatePendingUI();
      renderRows();
      applyCellSelectionClasses();
    }

    /** 선택 셀들을 TSV로 클립보드에 복사(엑셀/그리드 호환). */
    function copySelectedCells() {
      const withPos = [...selectedCells]
        .map((k) => k.split('#').map(Number))
        .map(([ri, ci]) => [rows.findIndex((r) => r._rowIndex === ri), ci])
        .filter(([p]) => p >= 0);
      if (withPos.length === 0) return;
      const minR = Math.min(...withPos.map((s) => s[0]));
      const maxR = Math.max(...withPos.map((s) => s[0]));
      const minC = Math.min(...withPos.map((s) => s[1]));
      const maxC = Math.max(...withPos.map((s) => s[1]));
      const has = new Set(withPos.map(([p, c]) => p + '#' + c));
      let tsv = '';
      for (let r = minR; r <= maxR; r++) {
        const line = [];
        for (let c = minC; c <= maxC; c++) {
          let v = '';
          if (has.has(r + '#' + c)) {
            const val = rows[r][columns[c].name];
            v = val === null ? 'NULL' : String(val);
          }
          line.push(v.includes('\\t') || v.includes('\\n') ? '"' + v.replace(/"/g, '""') + '"' : v);
        }
        tsv += line.join('\\t') + (r < maxR ? '\\n' : '');
      }
      navigator.clipboard.writeText(tsv);
    }

    function commitChanges() {
      const pendingDeletesCount = pendingDeletes.size;
      if (pendingDeletesCount > 100) {
        vscode.postMessage({ type: 'error', message: 'Cannot commit more than 100 deletes at once.' });
        return;
      }
      
      const proceed = () => {
        for (const [, change] of pendingChanges) {
          vscode.postMessage({ type: 'updateRow', primaryKeys: change.primaryKeys, updates: change.updates });
        }
        for (const ins of pendingInserts) {
          vscode.postMessage({ type: 'insertRow', values: ins.values });
        }
        for (const delStr of pendingDeletes) {
          vscode.postMessage({ type: 'deleteRow', primaryKeys: JSON.parse(delStr) });
        }
      };

      if (pendingDeletesCount > 0) {
        vscode.postMessage({
          type: 'confirmCommitDeletes',
          message: 'Delete ' + pendingDeletesCount + ' row(s)? Are you sure?'
        });
      } else {
        proceed();
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
      selectedRows.clear();
      anchorRow = null;
      clearCellSelection();
      updatePendingUI();
      refreshData();
    }

    function showContextMenu(e, row, col, colIdx) {
      contextRow = row;
      contextColIndex = colIdx;

      const menu = document.getElementById('contextMenu');
      menu.innerHTML = '';

      if (col) {
        const temporalTypes = ['datetime', 'timestamp', 'date', 'time'];
        const isTemporal = temporalTypes.includes(col.dataType);

        addMenuItem(menu, 'Set NULL', () => setNull());
        if (isTemporal) {
          addMenuItem(menu, 'Set NOW()', () => setNow());
        }
        addSeparator(menu);
        addMenuItem(menu, 'Copy Value', () => copyValue());
        if (selectedCells.size > 1) {
          addMenuItem(menu, 'Copy Cells (' + selectedCells.size + ')', () => copySelectedCells());
        }
        addMenuItem(menu, 'Paste', () => pasteFromClipboard());
        addSeparator(menu);
        addSubMenuItem(menu, 'Advanced Copy', [
          { label: 'Copy as CSV', action: () => copyAsCSV() },
          { label: 'Copy as JSON', action: () => copyAsJSON() },
          { label: 'Copy as Markdown', action: () => copyAsMarkdown() },
        ]);
        addSeparator(menu);
      } else if (selectedRows.size > 0) {
        addSubMenuItem(menu, 'Copy Row(s)', [
          { label: 'Copy as CSV', action: () => copySelectedRowsAsCSV() },
          { label: 'Copy as JSON', action: () => copySelectedRowsAsJSON() },
          { label: 'Copy as Markdown', action: () => copySelectedRowsAsMarkdown() },
        ]);
        addSeparator(menu);
      }

      addMenuItem(menu, 'Duplicate Row', () => duplicateRow());
      addMenuItem(menu, 'Delete Row', () => deleteSelectedRows(), 'danger');

      menu.style.left = e.clientX + 'px';
      menu.style.top = e.clientY + 'px';
      menu.classList.add('visible');

      const closeMenu = () => {
        menu.classList.remove('visible');
        // 메뉴가 닫히면 컨텍스트 대상도 비워, Delete 키가 과거 우클릭 행을 삭제하지 않게 한다(M-20)
        contextRow = null;
        contextColIndex = null;
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
      container.innerHTML = '<span>' + label + '</span><span style="margin-left:auto;font-size:10px;opacity:0.7;">\u203A</span>';
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
      // 빈 테이블에서 'Page 1 of 0'로 표시되지 않도록 최소 1페이지로 보정(M-30)
      const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
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
      a.download = ${csvName};
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
      a.download = ${xlsName};
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
      download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), ${jsonName});
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
      download(new Blob([md], { type: 'text/markdown' }), ${mdName});
    }

    function download(blob, name) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; a.click();
      URL.revokeObjectURL(url);
    }

    function copySelectedRowsAsCSV() {
      const sortedIdx = [...selectedRows].sort((a, b) => a - b);
      const targets = sortedIdx.map(ri => rows.find(r => r._rowIndex === ri)).filter(Boolean);
      let csv = columns.map(c => escapeCsv(c.name)).join(',') + '\\n';
      targets.forEach(row => {
        csv += columns.map(col => escapeCsv(row[col.name] === null ? 'NULL' : String(row[col.name]))).join(',') + '\\n';
      });
      navigator.clipboard.writeText(csv);
    }

    function copySelectedRowsAsJSON() {
      const sortedIdx = [...selectedRows].sort((a, b) => a - b);
      const targets = sortedIdx.map(ri => rows.find(r => r._rowIndex === ri)).filter(Boolean);
      const data = targets.map(row => {
        const obj = {};
        columns.forEach(col => {
          obj[col.name] = row[col.name];
        });
        return obj;
      });
      navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    }

    function copySelectedRowsAsMarkdown() {
      const sortedIdx = [...selectedRows].sort((a, b) => a - b);
      const targets = sortedIdx.map(ri => rows.find(r => r._rowIndex === ri)).filter(Boolean);
      let md = '| ' + columns.map(c => c.name).join(' | ') + ' |\\n';
      md += '| ' + columns.map(() => '---').join(' | ') + ' |\\n';
      targets.forEach(row => {
        md += '| ' + columns.map(col => {
          const v = row[col.name];
          return (v === null ? 'NULL' : String(v)).replace(/\\|/g, '\\\\|').replace(/\\n/g, ' ');
        }).join(' | ') + ' |\\n';
      });
      navigator.clipboard.writeText(md);
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
      str = String(str);
      // CSV 수식 주입 방지: =, +, -, @, 탭, CR로 시작하면 작은따옴표로 무력화
      if (/^[=+\\-@\\t\\r]/.test(str)) {
        str = "'" + str;
      }
      if (str.includes(',') || str.includes('"') || str.includes('\\n') || str.includes('\\r')) {
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

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });

    document.addEventListener('keydown', (e) => {
      const editing = !!document.querySelector('td.editing');
      if (e.key === 'Delete' && !editing) {
        deleteSelectedRows();
      }
      if (e.key === 'Escape' && !editing && (selectedCells.size > 0 || selectedRows.size > 0)) {
        clearCellSelection();
        selectedRows.clear();
        anchorRow = null;
        renderRows();
      }
      if (e.key === 'Enter' && !editing && selectedCell) {
        const td = document.querySelector(
          '#tableBody td[data-row-index="' + selectedCell.row._rowIndex + '"][data-col-index="' + selectedCell.colIdx + '"]',
        );
        if (td) startEdit(td, selectedCell.row, selectedCell.col);
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C') && !editing && selectedCells.size > 0) {
        e.preventDefault();
        copySelectedCells();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V') && !editing && selectedCells.size > 0) {
        e.preventDefault();
        pasteFromClipboard();
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
