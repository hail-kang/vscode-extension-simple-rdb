import * as vscode from 'vscode';
import { toDisplayValue } from '../utils';
import { cspMetaTag, toSafeJson } from './webviewSecurity';

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
          case 'confirmDelete': {
            const result = await vscode.window.showWarningMessage(
              message.message,
              { modal: true },
              'Delete',
            );
            if (result === 'Delete') {
              for (const target of message.targets) {
                await editContext.manager.deleteRow(
                  editContext.database,
                  editContext.table,
                  target.primaryKeys,
                );
              }
              this.panel?.webview.postMessage({ 
                type: 'deleteSuccess', 
                indices: message.targets.map((t: any) => t.index) 
              });
            }
            break;
          }
          case 'error':
            vscode.window.showErrorMessage(message.message);
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
    const cspSource = this.panel!.webview.cspSource;
    const maxBulkDelete = vscode.workspace.getConfiguration('simpleRdb').get('maxBulkDelete', 100);
    // Buffer/JSON 등 복합 타입을 표시용 문자열로 변환('[object Object]' 방지)
    const displayRows = rows.map((row) => {
      const out: Record<string, any> = {};
      for (const col of columns) {
        out[col] = toDisplayValue(row[col]);
      }
      return out;
    });
    // `<script>`에 직접 삽입하므로 toSafeJson으로 </script> 조기 종료(주입)를 차단한다.
    const columnsJson = toSafeJson(columns);
    const rowsJson = toSafeJson(displayRows);
    const pkJson = toSafeJson(editContext?.primaryKeys ?? []);

    const editableJs = editable
      ? `
    function startEdit(td, row, col, idx) {
      if (td.classList.contains('editing')) return;
      td.innerHTML = '';
      td.classList.add('editing');
      const input = document.createElement('input');
      input.value = row[col] === null ? '' : String(row[col]);
      input.addEventListener('blur', () => {
        finishEdit(td, row, col, idx, input.value);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          finishEdit(td, row, col, idx, input.value);
        }
        if (e.key === 'Escape') cancelEdit(td, row, col);
      });
      td.appendChild(input);
      input.focus(); input.select();
    }

    function finishEdit(td, row, col, idx, newVal) {
      td.classList.remove('editing');
      // NULL 셀을 열었다 빈 값으로 나가면 NULL→'' 변경으로 오인해 큐잉하지 않는다
      if (row[col] === null && newVal === '') {
        td.textContent = 'NULL';
        td.classList.add('null-cell');
        return;
      }
      if (newVal === null) { td.textContent = 'NULL'; td.classList.add('null-cell'); }
      else { td.textContent = String(newVal); td.classList.remove('null-cell'); }

      if (String(row[col]) !== String(newVal)) {
        row[col] = newVal;
        modifiedCells.add(idx + ':' + col);
        td.classList.add('modified');

        const pkObj = getOriginalPk(idx);
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
      console.log('Delete selected clicked. Count:', selectedRows.size);
      let targets = [];
      if (selectedRows.size > 0) {
        const sorted = [...selectedRows].sort((a, b) => b - a);
        for (const idx of sorted) {
          targets.push({ index: idx, primaryKeys: getOriginalPk(idx) });
        }
      } else if (contextRow !== null) {
        const idx = contextRow;
        targets.push({ index: idx, primaryKeys: getOriginalPk(idx) });
      }

      if (targets.length === 0) {
        vscode.postMessage({ type: 'error', message: 'No row selected. Click the row number (#) column to select rows first.' });
        return;
      }
      if (pks.size === 0) {
        vscode.postMessage({ type: 'error', message: 'Cannot delete rows: no primary key found for this table.' });
        return;
      }
      const MAX_DELETE = ${maxBulkDelete};
      if (targets.length > MAX_DELETE) {
        vscode.postMessage({ type: 'error', message: 'Cannot delete more than ' + MAX_DELETE + ' rows at once.' });
        return;
      }

      vscode.postMessage({ 
        type: 'confirmDelete', 
        message: 'Delete ' + targets.length + ' row(s)? This cannot be undone.',
        targets: targets
      });
    }

    function updatePendingUI() {
      const count = pendingChanges.size;
      document.getElementById('pendingCount').textContent = count;
      const cancelBtn = document.getElementById('cancelBtn');
      const bar = document.getElementById('pendingBar');
      if (count > 0) {
        bar.classList.add('visible');
        cancelBtn.style.display = '';
        document.getElementById('pendingMsg').textContent = 'Pending: ' + count + ' change(s)';
      } else {
        bar.classList.remove('visible');
        cancelBtn.style.display = 'none';
      }
    }

    const originalRows = JSON.parse(JSON.stringify(rows));

    function setNull() {
      if (contextRow === null || contextColIndex === null) return;
      const col = columns[contextColIndex];
      const row = rows[contextRow];

      if (row[col] === null) return;

      row[col] = null;
      modifiedCells.add(contextRow + ':' + col);

      const pkObj = getOriginalPk(contextRow);
      const key = JSON.stringify(pkObj);
      if (!pendingChanges.has(key)) {
        pendingChanges.set(key, { primaryKeys: pkObj, updates: { [col]: null } });
      } else {
        pendingChanges.get(key).updates[col] = null;
      }
      
      updatePendingUI();
      renderRows();
    }

    function cancelChanges() {
      for (let i = 0; i < rows.length; i++) {
        for (const key of Object.keys(rows[i])) {
          rows[i][key] = originalRows[i][key];
        }
      }
      pendingChanges.clear();
      modifiedCells.clear();
      updatePendingUI();
      renderRows();
    }
    `
      : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  ${cspMetaTag(cspSource)}
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
      user-select: none;
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
    td { cursor: default; user-select: none; }
    td.null-cell { color: var(--vscode-descriptionForeground); font-style: italic; }
    td.modified { background: var(--vscode-diffEditor-insertedTextBackground); }
    td.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    td.editing { padding: 0; }
    td.editing input {
      width: 100%; border: 2px solid var(--vscode-focusBorder);
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      padding: 4px 8px; font-family: inherit; font-size: inherit; outline: none;
      user-select: text;
    }
    .pending-bar {
      padding: 6px 12px; background: var(--vscode-statusBarItem-warningBackground);
      color: var(--vscode-statusBarItem-warningForeground); font-size: 12px;
      flex-shrink: 0; display: none;
    }
    .pending-bar.visible { display: flex; align-items: center; gap: 8px; }
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
  <div class="sql-bar">${escapeHtml(sql)}</div>
  <div class="toolbar">
    <span class="row-count">${rows.length} row(s)</span>
    ${
      editable
        ? `
       <button id="commitBtn" class="primary" onclick="commitChanges()">Apply Changes (<span id="pendingCount">0</span>)</button>
       <button id="cancelBtn" onclick="cancelChanges()" style="display:none">Cancel</button>
    `
        : `
      <span class="readonly-badge">Read-only${readonlyReason ? ': ' + escapeHtml(readonlyReason) : ''}</span>
    `
    }
    <span class="spacer"></span>
    <div class="export-dropdown">
      <button onclick="event.stopPropagation(); toggleDropdown('exportMenu')" title="Export">Export <span style="font-size:9px;opacity:0.7;margin-left:2px;">&#x25BE;</span></button>
      <div class="dropdown-menu" id="exportMenu">
        <div class="dropdown-item" onclick="closeDropdown('exportMenu'); exportCSV()">Export as CSV</div>
        <div class="dropdown-item" onclick="closeDropdown('exportMenu'); exportJSON()">Export as JSON</div>
        <div class="dropdown-item" onclick="closeDropdown('exportMenu'); exportMarkdown()">Export as Markdown</div>
      </div>
    </div>
    ${editable ? '<button onclick="deleteSelected()" class="danger">Delete Row</button>' : ''}
  </div>
  <div id="pendingBar" class="pending-bar">
    <span id="pendingMsg"></span>
  </div>
  <div class="table-wrapper">
    <table>
      <thead><tr><th class="row-num">#</th>${columns.map((c) => `<th class="${pkSet.has(c) ? 'pk' : ''}">${escapeHtml(c)}</th>`).join('')}</tr></thead>
      <tbody id="tableBody"></tbody>
    </table>
  </div>
  <div id="contextMenu" class="context-menu"></div>
  <script>
    const vscode = acquireVsCodeApi();
    const columns = ${columnsJson};
    const rows = ${rowsJson};
    const pks = new Set(${pkJson});
    const editable = ${editable};

    // 각 행의 '원본' PK 값 스냅샷. PK 셀을 편집해도 WHERE는 항상 원본 PK로 만들어야
    // 엉뚱한 행을 덮어쓰지 않는다. 행 삭제 시 이 배열도 함께 splice로 동기화한다.
    const originalPk = rows.map((row) => {
      const o = {};
      pks.forEach((k) => { o[k] = row[k]; });
      return o;
    });
    function getOriginalPk(idx) {
      return { ...(originalPk[idx] || {}) };
    }

    let pendingChanges = new Map();
    let modifiedCells = new Set();
    let selectedRows = new Set();
    let selectedCells = new Set();
    let anchorCell = null;
    let anchorRowIdx = null;
    let contextRow = null;
    let contextColIndex = null;

    window.addEventListener('message', (e) => {
      if (e.data.type === 'deleteSuccess') {
        if (e.data.indices) {
          // Multiple rows deleted via confirmDelete
          const sorted = [...e.data.indices].sort((a, b) => b - a);
          for (const idx of sorted) {
            rows.splice(idx, 1);
            originalPk.splice(idx, 1);
            // 원본 스냅샷도 함께 정렬 유지 → 이후 Cancel이 엉뚱한 행을 복원하지 않음(M-11)
            if (typeof originalRows !== 'undefined') originalRows.splice(idx, 1);
          }
        }
        pendingChanges.clear();
        modifiedCells.clear();
        selectedRows.clear();
        anchorRowIdx = null;
        updatePendingUI();
        renderRows();
      } else if (e.data.type === 'updateSuccess') {
        // 커밋된 값을 원본 스냅샷에 반영 → 이후 Cancel이 커밋된 값을 되돌리지 않음(M-11)
        if (typeof originalRows !== 'undefined') {
          for (let i = 0; i < rows.length; i++) {
            for (const key of Object.keys(rows[i])) originalRows[i][key] = rows[i][key];
          }
        }
        pendingChanges.clear();
        modifiedCells.clear();
        selectedRows.clear();
        anchorRowIdx = null;
        updatePendingUI();
        renderRows();
      } else if (e.data.type === 'error') {
        vscode.postMessage({ type: 'error', message: e.data.message });
      }
    });

    renderRows();

    function renderRows() {
      const tbody = document.getElementById('tableBody');
      tbody.innerHTML = '';
      selectedCells.clear();
      anchorCell = null;
      rows.forEach((row, idx) => {
        const tr = document.createElement('tr');
        tr.dataset.rowIndex = idx;
        if (selectedRows.has(idx)) tr.classList.add('row-selected');

        const rowNumTd = document.createElement('td');
        rowNumTd.className = 'row-num';
        if (selectedRows.has(idx)) rowNumTd.classList.add('selected');
        rowNumTd.textContent = String(idx + 1);
        rowNumTd.addEventListener('click', (e) => toggleRowSelection(idx, e));
        rowNumTd.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          if (!selectedRows.has(idx)) {
            selectedRows.clear();
            selectedRows.add(idx);
            anchorRowIdx = idx;
            renderRows();
          }
          showContextMenu(e, idx, null);
        });
        tr.appendChild(rowNumTd);

        columns.forEach((col, colIdx) => {
          const td = document.createElement('td');
          td.dataset.rowIndex = idx;
          td.dataset.colIndex = colIdx;
          const v = row[col];
          const cellKey = idx + ':' + col;

          if (v === null) {
            td.textContent = 'NULL';
            td.classList.add('null-cell');
          } else {
            td.textContent = String(v);
          }

          if (modifiedCells.has(cellKey)) td.classList.add('modified');
          if (selectedCells.has(idx + ':' + colIdx)) td.classList.add('selected');

          td.addEventListener('click', (e) => {
            if (e.shiftKey && anchorCell) {
              selectRange(anchorCell.row, anchorCell.col, idx, colIdx);
            } else {
              selectedCells.clear();
              selectedCells.add(idx + ':' + colIdx);
              anchorCell = { row: idx, col: colIdx };
              reapplySelection();
            }
          });

          if (editable) {
            td.addEventListener('dblclick', () => startEdit(td, row, col, idx));
          }

          td.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (!selectedCells.has(idx + ':' + colIdx)) {
              selectedCells.clear();
              selectedCells.add(idx + ':' + colIdx);
              anchorCell = { row: idx, col: colIdx };
              reapplySelection();
            }
            showContextMenu(e, idx, colIdx);
          });

          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
    }

    function reapplySelection() {
      document.querySelectorAll('td.selected:not(.row-num)').forEach((td) => td.classList.remove('selected'));
      selectedCells.forEach((key) => {
        const [r, c] = key.split(':').map(Number);
        const td = document.querySelector('[data-row-index="' + r + '"][data-col-index="' + c + '"]');
        if (td) td.classList.add('selected');
      });
    }

    function toggleRowSelection(idx, event) {
      if (event.shiftKey && anchorRowIdx !== null) {
        const start = Math.min(anchorRowIdx, idx);
        const end = Math.max(anchorRowIdx, idx);
        selectedRows.clear();
        for (let i = start; i <= end; i++) { selectedRows.add(i); }
      } else if (event.ctrlKey || event.metaKey) {
        if (selectedRows.has(idx)) {
          selectedRows.delete(idx);
        } else {
          selectedRows.add(idx);
          anchorRowIdx = idx;
        }
      } else {
        selectedRows.clear();
        selectedRows.add(idx);
        anchorRowIdx = idx;
      }
      renderRows();
    }

    function selectRange(r1, c1, r2, c2) {
      selectedCells.clear();
      const minR = Math.min(r1, r2);
      const maxR = Math.max(r1, r2);
      const minC = Math.min(c1, c2);
      const maxC = Math.max(c1, c2);
      for (let r = minR; r <= maxR; r++) {
        for (let c = minC; c <= maxC; c++) {
          selectedCells.add(r + ':' + c);
        }
      }
      reapplySelection();
    }

    function getSelectedValue(r, c) {
      const col = columns[c];
      const row = rows[r];
      const v = row[col];
      return v === null ? 'NULL' : String(v);
    }

    function showContextMenu(e, rowIdx, colIdx) {
      contextRow = rowIdx;
      contextColIndex = colIdx;

      const menu = document.getElementById('contextMenu');
      menu.innerHTML = '';

      if (selectedCells.size > 0) {
        addSubMenuItem(menu, 'Advanced Copy', [
          { label: 'Copy as CSV', action: () => copySelectedAsCSV() },
          { label: 'Copy as JSON', action: () => copySelectedAsJSON() },
          { label: 'Copy as Markdown', action: () => copySelectedAsMarkdown() },
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

      if (colIdx !== null) {
        addMenuItem(menu, 'Copy Value', () => copySingleValue(rowIdx, colIdx));
      }

      if (editable) {
        if (colIdx !== null) {
          addSeparator(menu);
          addMenuItem(menu, 'Set NULL', () => setNull());
        }
        addSeparator(menu);
        addMenuItem(menu, 'Delete Row', () => deleteSelected(), 'danger');
      }

      menu.style.left = e.clientX + 'px';
      menu.style.top = e.clientY + 'px';
      menu.classList.add('visible');

      const closeMenu = () => {
        menu.classList.remove('visible');
        // 메뉴가 닫히면 컨텍스트 대상도 비워, 이후 Delete가 과거 우클릭 행을 삭제하지 않게 한다(M-20)
        contextRow = null;
        contextColIndex = null;
        document.removeEventListener('click', closeMenu);
      };
      setTimeout(() => document.addEventListener('click', closeMenu), 0);
    }

    function addMenuItem(menu, label, action) {
      const item = document.createElement('div');
      item.className = 'context-menu-item';
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

    function copySingleValue(r, c) {
      const col = columns[c];
      const row = rows[r];
      const v = row[col];
      navigator.clipboard.writeText(v === null ? 'NULL' : String(v));
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

    function copySelectedRowsAsCSV() {
      const sortedIdx = [...selectedRows].sort((a, b) => a - b);
      let csv = columns.map(escapeCsv).join(',') + '\\n';
      sortedIdx.forEach(idx => {
        csv += columns.map(col => escapeCsv(rows[idx][col] === null ? 'NULL' : String(rows[idx][col]))).join(',') + '\\n';
      });
      navigator.clipboard.writeText(csv);
    }

    function copySelectedRowsAsJSON() {
      const sortedIdx = [...selectedRows].sort((a, b) => a - b);
      const data = sortedIdx.map(idx => {
        const obj = {};
        columns.forEach(col => {
          obj[col] = rows[idx][col];
        });
        return obj;
      });
      navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    }

    function copySelectedRowsAsMarkdown() {
      const sortedIdx = [...selectedRows].sort((a, b) => a - b);
      let md = '| ' + columns.join(' | ') + ' |\\n';
      md += '| ' + columns.map(() => '---').join(' | ') + ' |\\n';
      sortedIdx.forEach(idx => {
        md += '| ' + columns.map(col => {
          const v = rows[idx][col];
          return (v === null ? 'NULL' : String(v)).replace(/\\|/g, '\\\\|').replace(/\\n/g, ' ');
        }).join(' | ') + ' |\\n';
      });
      navigator.clipboard.writeText(md);
    }

    function getSelectedRowsCols() {
      const sorted = [...selectedCells].map((k) => k.split(':').map(Number));
      sorted.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const minR = sorted[0][0];
      const maxR = sorted[sorted.length - 1][0];
      const minC = Math.min(...sorted.map((s) => s[1]));
      const maxC = Math.max(...sorted.map((s) => s[1]));
      const map = {};
      sorted.forEach(([r, c]) => {
        if (!map[r]) map[r] = {};
        map[r][c] = getSelectedValue(r, c);
      });
      return { minR, maxR, minC, maxC, map, sorted };
    }

    function copySelectedAsCSV() {
      if (selectedCells.size === 0) return;
      const { minR, maxR, minC, maxC, map } = getSelectedRowsCols();
      let csv = '';
      for (let c = minC; c <= maxC; c++) {
        csv += (c > minC ? ',' : '') + escapeCsv(columns[c]);
      }
      csv += '\\n';
      for (let r = minR; r <= maxR; r++) {
        const line = [];
        for (let c = minC; c <= maxC; c++) {
          const v = (map[r] && map[r][c] !== undefined) ? map[r][c] : '';
          line.push(escapeCsv(v));
        }
        csv += line.join(',') + '\\n';
      }
      navigator.clipboard.writeText(csv);
    }

    function copySelectedAsJSON() {
      if (selectedCells.size === 0) return;
      const { minR, maxR, minC, maxC, map } = getSelectedRowsCols();
      const data = [];
      for (let r = minR; r <= maxR; r++) {
        const obj = {};
        for (let c = minC; c <= maxC; c++) {
          const col = columns[c];
          // 표시 문자열이 아닌 원본 값을 사용해 null/숫자 등 타입을 보존한다(M-15)
          obj[col] = rows[r] ? rows[r][col] : null;
        }
        data.push(obj);
      }
      navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    }

    function copySelectedAsMarkdown() {
      if (selectedCells.size === 0) return;
      const { minR, maxR, minC, maxC, map } = getSelectedRowsCols();
      let md = '| ' + columns.slice(minC, maxC + 1).join(' | ') + ' |\\n';
      md += '| ' + columns.slice(minC, maxC + 1).map(() => '---').join(' | ') + ' |\\n';
      for (let r = minR; r <= maxR; r++) {
        md += '| ';
        for (let c = minC; c <= maxC; c++) {
          if (c > minC) md += ' | ';
          const v = (map[r] && map[r][c] !== undefined) ? map[r][c] : '';
          md += v.replace(/\\|/g, '\\\\|').replace(/\\n/g, ' ');
        }
        md += ' |\\n';
      }
      navigator.clipboard.writeText(md);
    }

    ${editableJs}

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        if (selectedCells.size === 0) return;
        copySelected();
        return;
      }
      if (${editable} && (e.ctrlKey || e.metaKey) && e.key === 'v') {
        e.preventDefault();
        pasteFromClipboard();
        return;
      }
      if (${editable} && (e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (pendingChanges.size > 0) commitChanges();
      }
    });

    function copySelected() {
      const sorted = [...selectedCells].map((k) => k.split(':').map(Number));
      sorted.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const minR = sorted[0][0];
      const maxR = sorted[sorted.length - 1][0];
      const minC = Math.min(...sorted.map((s) => s[1]));
      const maxC = Math.max(...sorted.map((s) => s[1]));

      const map = {};
      sorted.forEach(([r, c]) => {
        if (!map[r]) map[r] = {};
        map[r][c] = getSelectedValue(r, c);
      });

      let tsv = '';
      for (let r = minR; r <= maxR; r++) {
        const line = [];
        for (let c = minC; c <= maxC; c++) {
          const v = (map[r] && map[r][c] !== undefined) ? map[r][c] : '';
          line.push(v.includes('\\t') || v.includes('\\n') ? '"' + v.replace(/"/g, '""') + '"' : v);
        }
        tsv += line.join('\\t') + (r < maxR ? '\\n' : '');
      }
      navigator.clipboard.writeText(tsv);
    }

    async function pasteFromClipboard() {
      try {
        const text = await navigator.clipboard.readText();
        if (!text) return;
        const lines = parseTSV(text);
        if (lines.length === 0) return;
        const sorted = [...selectedCells].map((k) => k.split(':').map(Number));
        if (sorted.length === 0) return;
        sorted.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

        let startR = sorted[0][0];
        let startC = sorted[0][1];
        for (let ri = 0; ri < lines.length; ri++) {
          for (let ci = 0; ci < lines[ri].length; ci++) {
            const r = startR + ri;
            const c = startC + ci;
            if (r >= rows.length || c >= columns.length) continue;
            const col = columns[c];
            const oldVal = rows[r][col];
            const newVal = lines[ri][ci];
            if (String(oldVal) !== String(newVal)) {
              rows[r][col] = newVal;
              modifiedCells.add(r + ':' + col);
              const pkObj = getOriginalPk(r);
              const key = JSON.stringify(pkObj);
              if (!pendingChanges.has(key)) {
                pendingChanges.set(key, { primaryKeys: pkObj, updates: { [col]: newVal } });
              } else {
                pendingChanges.get(key).updates[col] = newVal;
              }
            }
          }
        }
        updatePendingUI();
        renderRows();
        selectRange(startR, startC, startR + lines.length - 1, startC + lines[0].length - 1);
      } catch {}
    }

    function parseTSV(text) {
      return text.split('\\n').filter((l) => l.length > 0).map((line) => {
        const cols = [];
        let cur = '';
        let inQuote = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (inQuote) {
            if (ch === '"') {
              if (i + 1 < line.length && line[i + 1] === '"') { cur += '"'; i++; }
              else inQuote = false;
            } else cur += ch;
          } else {
            if (ch === '"') inQuote = true;
            else if (ch === '\\t') { cols.push(cur); cur = ''; }
            else cur += ch;
          }
        }
        cols.push(cur);
        return cols;
      });
    }

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

    function exportJSON() {
      const data = rows.map((row) => {
        const obj = {};
        columns.forEach((col) => {
          obj[col] = row[col];
        });
        return obj;
      });
      download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), 'result.json');
    }

    function exportMarkdown() {
      let md = '| ' + columns.join(' | ') + ' |\\n';
      md += '| ' + columns.map(() => '---').join(' | ') + ' |\\n';
      rows.forEach((row) => {
        md += '| ' + columns.map((col) => {
          const v = row[col];
          if (v === null) return 'NULL';
          return String(v).replace(/\\|/g, '\\\\|').replace(/\\n/g, ' ');
        }).join(' | ') + ' |\\n';
      });
      download(new Blob([md], { type: 'text/markdown' }), 'result.md');
    }

    function download(blob, name) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; a.click();
      URL.revokeObjectURL(url);
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

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
