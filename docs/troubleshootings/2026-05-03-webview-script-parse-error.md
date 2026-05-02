# Webview Script Parse Error: Template Literal Line Break in JS String

**Date:** 2026-05-03

**Symptom:** Table data not rendering at all in webview panel. No errors shown but table body remains empty. Tested both `TableViewProvider` (tree double-click) and `QueryResultProvider` (SQL execution).

**Root Cause:**
In TypeScript source, `\n` inside a template literal (backtick) is compiled to an **actual newline character**. When that string is embedded into a `<script>` tag in the generated HTML, it produces a **JavaScript syntax error**:

```typescript
// Wrong: \n becomes real newline in generated JS
'You are about to PERMANENTLY DELETE ' + n + ' row(s).\n\n' +
'Are you sure?'
```

This compiles to JS containing literal newlines mid-string, breaking script parsing entirely. Since the script tag is at the end of the HTML, the entire webview fails to render.

**Solution:**
Double-escape `\\n\\n` so it remains a literal `\n` in the generated JavaScript:

```typescript
// Correct: \\n\\n stays as \n\n in generated JS
'You are about to PERMANENTLY DELETE ' + n + ' row(s).\\n\\n' +
'Are you sure?'
```

**Verification:**
After compile, parse the generated `<script>` content with `new Function()` to detect syntax errors before runtime:

```bash
node - <<'NODE'
const { TableViewProvider } = require('./dist/webview/TableViewProvider.js');
const html = new TableViewProvider({}, 'conn', 'db', 'table', {}).getHtml();
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
new Function(script); // throws on parse error
console.log('OK');
NODE
```

**Affected Files:**
- `src/webview/TableViewProvider.ts` — `deleteSelectedRows()` and `commitChanges()` confirm dialogs
- `src/webview/QueryResultProvider.ts` — `deleteSelected()` confirm dialog

**Key Takeaway:**
When writing JavaScript string literals that contain `\n` inside TypeScript template literals embedded in HTML script tags, always use `\\n`. Otherwise the compiled output contains illegal line breaks in JavaScript string literals, causing the entire webview script to fail silently.
