import * as vscode from 'vscode';
import { BaseWebviewPanel, type WebviewPanelConfig } from '../BaseWebviewPanel';
import type { IConnectionService, ISchemaService } from '../../application/ports';
import type { MaterializedViewInfo } from '../../database/adapters/IDatabaseAdapter';
import { handleError, ErrorCategory } from '../../core/errorHandler';
import { getLanguage } from '../../i18n';
import { getTokenColors } from '../../utils/themeColors';

function formatColumnDefs(ddl: string): string {
    const viewMatch = ddl.match(/^CREATE\s+(?:MATERIALIZED\s+)?VIEW\s+`[^`]+`\s*\(/i);
    if (!viewMatch) return ddl;
    const startIdx = viewMatch.index! + viewMatch[0].length - 1;
    let depth = 1;
    let i = startIdx + 1;
    let inQuote = false;
    let quoteChar = '';
    while (i < ddl.length && depth > 0) {
        const ch = ddl[i];
        if (inQuote) {
            if (ch === quoteChar && ddl[i - 1] !== '\\') { inQuote = false; }
            i++;
            continue;
        }
        if (ch === '"' || ch === "'") { inQuote = true; quoteChar = ch; i++; continue; }
        if (ch === '(') { depth++; i++; continue; }
        if (ch === ')') { depth--; if (depth === 0) break; i++; continue; }
        i++;
    }
    if (depth !== 0) return ddl;
    const endIdx = i;
    const inner = ddl.substring(startIdx + 1, endIdx);
    const cols = splitColumnDefs(inner);
    if (cols.length <= 1) return ddl;
    return ddl.substring(0, startIdx + 1) + '\n  ' + cols.join(',\n  ') + '\n' + ddl.substring(endIdx);
}

function splitColumnDefs(content: string): string[] {
    const items: string[] = [];
    let current = '';
    let depth = 0;
    let inQuote = false;
    let quoteChar = '';
    for (let i = 0; i < content.length; i++) {
        const ch = content[i];
        if (inQuote) {
            current += ch;
            if (ch === quoteChar && content[i - 1] !== '\\') { inQuote = false; }
            continue;
        }
        if (ch === '"' || ch === "'") { inQuote = true; quoteChar = ch; current += ch; continue; }
        if (ch === '(') { depth++; current += ch; continue; }
        if (ch === ')') { depth--; current += ch; continue; }
        if (ch === ',' && depth === 0) {
            const trimmed = current.trim();
            if (trimmed) items.push(trimmed);
            current = '';
            continue;
        }
        current += ch;
    }
    const trimmed = current.trim();
    if (trimmed) items.push(trimmed);
    return items;
}

function splitProperties(content: string): string[] {
    const items: string[] = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';
    for (let i = 0; i < content.length; i++) {
        const ch = content[i];
        if (inQuote) {
            current += ch;
            if (ch === quoteChar && content[i - 1] !== '\\') { inQuote = false; }
            continue;
        }
        if (ch === '"' || ch === "'") { inQuote = true; quoteChar = ch; current += ch; continue; }
        if (ch === ',' && !inQuote) {
            const trimmed = current.trim();
            if (trimmed) items.push(trimmed);
            current = '';
            continue;
        }
        current += ch;
    }
    const trimmed = current.trim();
    if (trimmed) items.push(trimmed);
    return items;
}

/**
 * Format a SQL body (SELECT/FROM/WHERE etc.) with depth-aware indentation.
 * Adds line breaks at depth 0 (top level), respecting nested parentheses.
 */
function formatSqlBody(sql: string, baseIndent: string): string {
    if (!sql || !sql.trim()) return '';

    let result = '';
    let i = 0;
    let currentToken = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let parenDepth = 0;
    const len = sql.length;

    const topKeywords = /^(SELECT|FROM|WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|UNION(?:\s+ALL)?|LEFT\s+(?:OUTER\s+)?JOIN|RIGHT\s+(?:OUTER\s+)?JOIN|INNER\s+JOIN|CROSS\s+JOIN|JOIN)\b/i;
    const joinCondKeywords = /^(ON|AND|OR)\b/i;

    // Check if current position is at a word boundary (not inside an identifier)
    function isWordBoundary(): boolean {
        if (i === 0) return true;
        const prevCh = sql[i - 1];
        return !/[a-zA-Z0-9_]/.test(prevCh);
    }

    function flushToken(): void {
        const t = currentToken;
        if (t) result += t;
        currentToken = '';
    }

    function addLine(): void {
        if (result.length === 0) {
            // First keyword - just add indent, no leading newline
            result += baseIndent;
            return;
        }
        // Avoid double newlines - check if result already ends with newline+indent
        if (result.endsWith('\n' + baseIndent)) {
            return;
        }
        if (result.endsWith('\n')) {
            result += baseIndent;
        } else {
            result += '\n' + baseIndent;
        }
    }

    function peekKeyword(pattern: RegExp): string | null {
        if (!isWordBoundary()) return null;
        const remaining = sql.substring(i);
        const m = remaining.match(pattern);
        if (m && m.index === 0) return m[0];
        return null;
    }

    while (i < len) {
        const ch = sql[i];

        if (inSingleQuote) {
            currentToken += ch;
            if (ch === "'" && (i + 1 >= len || sql[i + 1] !== "'")) { inSingleQuote = false; }
            i++;
            continue;
        }
        if (inDoubleQuote) {
            currentToken += ch;
            if (ch === '"' && (i + 1 >= len || sql[i + 1] !== '"')) { inDoubleQuote = false; }
            i++;
            continue;
        }
        if (ch === "'") { inSingleQuote = true; currentToken += ch; i++; continue; }
        if (ch === '"') { inDoubleQuote = true; currentToken += ch; i++; continue; }

        if (ch === '(') { parenDepth++; currentToken += ch; i++; continue; }
        if (ch === ')') { parenDepth--; currentToken += ch; i++; continue; }

        // At depth 0, check for top-level keywords
        if (parenDepth === 0) {
            const kw = peekKeyword(topKeywords);
            if (kw) {
                flushToken();
                i += kw.length;
                addLine();
                result += kw;
                continue;
            }
        }

        // At depth 0, handle commas
        if (parenDepth === 0 && ch === ',') {
            flushToken();
            result += ',';
            i++;
            addLine();
            continue;
        }

        // At depth 0, handle ON/AND/OR (join conditions) with extra indent
        if (parenDepth === 0) {
            const kw2 = peekKeyword(joinCondKeywords);
            if (kw2) {
                flushToken();
                i += kw2.length;
                result += '\n' + baseIndent + '    ' + kw2;
                continue;
            }
        }

        currentToken += ch;
        i++;
    }

    flushToken();
    return result;
}

/**
 * Post-process: recursively format subqueries inside parentheses.
 * Finds (SELECT ...) patterns and formats them with increased indent.
 */
function formatSubqueries(sql: string, baseIndent: string): string {
    let result = sql;
    let changed = true;
    let iterations = 0;
    while (changed && iterations < 5) {
        changed = false;
        iterations++;
        let newResult = '';
        let j = 0;
        while (j < result.length) {
            if (result[j] === '(') {
                // Check if preceded by FROM/JOIN/IN keywords (real subqueries)
                const before = result.substring(0, j).trimEnd();
                const isSubqueryContext = /\b(FROM|JOIN|IN|EXISTS)\s*$/i.test(before);
                // Skip if it's a CTE body (preceded by AS) or at start
                if (isSubqueryContext) {
                    const afterParen = result.substring(j + 1);
                    const selectMatch = afterParen.match(/^\s*(?:__MV_COMMENT_\d+__\s*)?(?:--\s*[^\n]*\s*)?SELECT\b/i);
                    if (selectMatch) {
                        let pDepth = 0;
                        let inQ = false;
                        let qCh = '';
                        let closeIdx = -1;
                        for (let k = j; k < result.length; k++) {
                            const c = result[k];
                            if (inQ) {
                                if (c === qCh && result[k - 1] !== '\\') { inQ = false; }
                                continue;
                            }
                            if (c === '"' || c === "'") { inQ = true; qCh = c; continue; }
                            if (c === '(') { pDepth++; }
                            if (c === ')') { pDepth--; if (pDepth === 0) { closeIdx = k; break; } }
                        }
                        if (closeIdx !== -1) {
                            const inner = result.substring(j + 1, closeIdx).trim();
                            if ((/^SELECT\b/i.test(inner) || /^__MV_COMMENT_\d+__\s*SELECT\b/i.test(inner))
                                && !inner.includes('\n')) {
                                const formatted = formatSqlBody(inner, baseIndent + '    ');
                                newResult += '(' + formatted.trim() + ')';
                                j = closeIdx + 1;
                                changed = true;
                                continue;
                            }
                        }
                    }
                }
            }
            newResult += result[j];
            j++;
        }
        result = newResult;
    }
    return result;
}

interface CommentSlot {
    placeholder: string;
    text: string;
    isOwnLine: boolean;
    indent: string;
}

function stripComments(sql: string): { text: string; comments: CommentSlot[] } {
    const comments: CommentSlot[] = [];
    let counter = 0;
    let result = '';
    let i = 0;
    let inSingleQuote = false;
    let inDoubleQuote = false;

    while (i < sql.length) {
        const ch = sql[i];
        const nextCh = i + 1 < sql.length ? sql[i + 1] : undefined;

        if (inSingleQuote) {
            result += ch;
            if (ch === "'" && nextCh !== "'") { inSingleQuote = false; }
            i++;
            continue;
        }
        if (inDoubleQuote) {
            result += ch;
            if (ch === '"' && nextCh !== '"') { inDoubleQuote = false; }
            i++;
            continue;
        }
        if (ch === "'") { inSingleQuote = true; result += ch; i++; continue; }
        if (ch === '"') { inDoubleQuote = true; result += ch; i++; continue; }

        if (ch === '-' && nextCh === '-') {
            const start = i;
            let lineStart = start;
            while (lineStart > 0 && sql[lineStart - 1] !== '\n') { lineStart--; }
            const lineBefore = sql.substring(lineStart, start).trim();
            const isOwnLine = lineBefore.length === 0;

            let indent = '';
            for (let j = lineStart; j < start; j++) {
                if (sql[j] === ' ' || sql[j] === '\t') { indent += sql[j]; }
                else { break; }
            }

            i += 2;
            while (i < sql.length && sql[i] !== '\n') { i++; }
            const commentText = sql.substring(start, i);
            const placeholder = `__MV_COMMENT_${counter++}__`;
            comments.push({ placeholder, text: commentText, isOwnLine, indent });

            if (isOwnLine) {
                result = result.substring(0, result.length - (start - lineStart));
                result += placeholder + '\n';
            } else {
                result += placeholder;
            }
            continue;
        }

        if (ch === '/' && nextCh === '*') {
            const start = i;
            i += 2;
            while (i < sql.length) {
                if (sql[i] === '*' && i + 1 < sql.length && sql[i + 1] === '/') {
                    i += 2;
                    break;
                }
                i++;
            }
            const commentText = sql.substring(start, i);
            const placeholder = `__MV_COMMENT_${counter++}__`;
            comments.push({ placeholder, text: commentText, isOwnLine: false, indent: '' });
            result += placeholder;
            continue;
        }

        result += ch;
        i++;
    }

    return { text: result, comments };
}

function restoreComments(sql: string, comments: CommentSlot[]): string {
    let result = sql;
    for (const c of comments) {
        // Simple placeholder replacement - the SQL formatter handles indentation
        result = result.replace(c.placeholder, c.text);
    }
    return result;
}

function formatDdlOutput(ddl: string): string {
    // Step 1: Strip comments before formatting
    const { text: rawSql, comments } = stripComments(ddl);

    // Step 2: Collapse whitespace
    let s = rawSql.replace(/\s+/g, ' ').trim();

    // Step 3: Format column definitions
    s = formatColumnDefs(s);
    s = s.replace(/\)\s+(COMMENT\s)/i, ')\n$1');
    s = s.replace(/\)\s+(DISTRIBUTED\b)/i, ')\n$1');
    s = s.replace(/\)\s+(REFRESH\b)/i, ')\n$1');
    s = s.replace(/\)\s+(PROPERTIES\s*\()/i, ')\n$1');
    s = s.replace(/"\s+(DISTRIBUTED\b)/g, '"\n$1');
    s = s.replace(/"\s+(REFRESH\b)/g, '"\n$1');
    s = s.replace(/"\s+(PROPERTIES\s*\()/g, '"\n$1');

    // Step 4: Format PROPERTIES
    s = s.replace(
        /PROPERTIES\s*\(([^)]+)\)/i,
        (_m: string, inner: string) => {
            const items = splitProperties(inner);
            return 'PROPERTIES (\n  ' + items.join(',\n  ') + '\n)';
        }
    );

    // Step 5: Handle AS WITH ... SELECT (CTE) by finding the boundary via paren tracking
    const asWithMatch = s.match(/\bAS\s+WITH\b/i);
    if (asWithMatch) {
        const asWithIdx = asWithMatch.index!;
        const afterWith = asWithIdx + asWithMatch[0].length;

        // Scan from after WITH, tracking paren depth, to find final SELECT at depth 0
        let pDepth = 0;
        let inQ = false;
        let qCh = '';
        let finalSelectIdx = -1;
        for (let si = afterWith; si < s.length; si++) {
            const ch = s[si];
            if (inQ) {
                if (ch === qCh && s[si - 1] !== '\\') { inQ = false; }
                continue;
            }
            if (ch === '"' || ch === "'") { inQ = true; qCh = ch; continue; }
            if (ch === '(') { pDepth++; }
            if (ch === ')') {
                pDepth--;
                if (pDepth === 0) {
                    // Check if SELECT follows after this closing paren
                    const tail = s.substring(si + 1).trimStart();
                    if (/^SELECT\b/i.test(tail)) {
                        finalSelectIdx = si + 1 + (s.substring(si + 1).length - s.substring(si + 1).trimStart().length);
                        break;
                    }
                }
            }
        }

        if (finalSelectIdx !== -1) {
            const cteBlock = s.substring(afterWith, finalSelectIdx).trim();
            const afterSelect = s.substring(finalSelectIdx).trimStart();

            // Split CTE block by top-level commas
            const ctes: string[] = [];
            let cur = '';
            let cd = 0;
            let ciQ = false;
            let cqCh = '';
            for (let k = 0; k < cteBlock.length; k++) {
                const ch = cteBlock[k];
                if (ciQ) {
                    cur += ch;
                    if (ch === cqCh && cteBlock[k - 1] !== '\\') { ciQ = false; }
                    continue;
                }
                if (ch === '"' || ch === "'") { ciQ = true; cqCh = ch; cur += ch; continue; }
                if (ch === '(') { cd++; cur += ch; continue; }
                if (ch === ')') { cd--; cur += ch; continue; }
                if (ch === ',' && cd === 0) {
                    ctes.push(cur.trim());
                    cur = '';
                    continue;
                }
                cur += ch;
            }
            if (cur.trim()) ctes.push(cur.trim());

            // Format each CTE
            const formattedCtes = ctes.map(cte => {
                let cteBody = cte;
                if (cteBody.toUpperCase().startsWith('WITH ')) {
                    cteBody = cteBody.substring(5).trim();
                }
                // Extract and strip leading comment placeholders
                let leadingComment = '';
                const commentMatch = cteBody.match(/^(__MV_COMMENT_\d+__)\s*/);
                if (commentMatch) {
                    // Find the actual comment text
                    const placeholder = commentMatch[1];
                    const comment = comments.find(c => c.placeholder === placeholder);
                    if (comment) {
                        leadingComment = comment.text;
                    }
                    cteBody = cteBody.substring(commentMatch[0].length);
                }
                const nameMatch = cteBody.match(/^(\w+)\s+AS\s*\(/is);
                if (!nameMatch) return (leadingComment ? '    ' + leadingComment + '\n' : '') + '    ' + cteBody;

                const cteName = nameMatch[1];
                const parenStart = nameMatch[0].length;
                let pd = 1; // Start at 1 because we're inside the CTE's opening paren
                let bodyEnd = -1;
                let bq = false;
                let bqc = '';
                for (let bi = parenStart; bi < cteBody.length; bi++) {
                    const bc = cteBody[bi];
                    if (bq) {
                        if (bc === bqc && cteBody[bi - 1] !== '\\') { bq = false; }
                        continue;
                    }
                    if (bc === '"' || bc === "'") { bq = true; bqc = bc; continue; }
                    if (bc === '(') { pd++; }
                    if (bc === ')') { pd--; if (pd === 0) { bodyEnd = bi; break; } }
                }
                if (bodyEnd === -1) return '    ' + cteBody;
                const body = cteBody.substring(parenStart, bodyEnd);

                const formattedBody = formatSubqueries(formatSqlBody(body.trim(), '        '), '        ');
                const commentLine = leadingComment ? '    ' + leadingComment + '\n' : '';
                return commentLine + '    ' + cteName + ' AS (\n' + formattedBody + '\n    )';
            });

            // Format the final SELECT
            let finalSelect = afterSelect;
            const semiIdx = finalSelect.indexOf(';');
            if (semiIdx !== -1) finalSelect = finalSelect.substring(0, semiIdx);
            const formattedFinal = formatSubqueries(formatSqlBody(finalSelect.trim(), '    '), '    ');

            s = s.substring(0, asWithIdx) +
                'AS\nWITH\n' +
                formattedCtes.join(',\n\n') +
                '\n' + formattedFinal.trimStart();
        }
    } else {
        // No CTE: plain AS SELECT
        s = s.replace(
            /\bAS\s+SELECT\b/i,
            'AS\nSELECT'
        );
    }

    // Step 6: Restore comments
    s = restoreComments(s, comments);

    return s;
}

export interface MaterializedViewDesign {
    viewName: string;
    database: string;
    mode: 'create' | 'alter';
    ddl: string;
    originalDDL: string;
    refreshType: string;
    activeStatus?: string;
    originalActiveStatus?: string;
    originalView?: MaterializedViewInfo;
}

interface DesignerMessage {
    command: string;
    data?: MaterializedViewDesign;
    viewName?: string;
    sql?: string;
}

export class MaterializedViewDesignerPanel extends BaseWebviewPanel {
    public static readonly viewType = 'sqlAllInOneMaterializedViewDesigner';

    protected readonly panelConfig: WebviewPanelConfig = {
        viewType: MaterializedViewDesignerPanel.viewType,
        htmlFileName: 'materialized-view-designer.html',
        cssFileName: 'materialized-view-designer.css',
        jsFileName: 'materialized-view-designer.js',
    };

    private _mode: 'create' | 'alter' = 'create';
    private _database = '';
    private _viewName = '';
    private _refreshType = 'ASYNC';
    private readonly _connectionService: IConnectionService;
    private readonly _schemaService: ISchemaService;

    public static createOrShow(
        extensionUri: vscode.Uri,
        _context: vscode.ExtensionContext,
        connectionService: IConnectionService,
        schemaService: ISchemaService,
    ): MaterializedViewDesignerPanel {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (MaterializedViewDesignerPanel.revealExisting(MaterializedViewDesignerPanel.viewType, column)) {
            return MaterializedViewDesignerPanel.getExistingInstance<MaterializedViewDesignerPanel>(
                MaterializedViewDesignerPanel.viewType,
            )!;
        }

        const panel = MaterializedViewDesignerPanel.createWebviewPanel(
            MaterializedViewDesignerPanel.viewType,
            'Materialized View Designer',
            extensionUri,
        );

        const instance = new MaterializedViewDesignerPanel(panel, extensionUri, connectionService, schemaService);
        MaterializedViewDesignerPanel.registerInstance(instance);
        return instance;
    }

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        connectionService: IConnectionService,
        schemaService: ISchemaService,
    ) {
        super(panel, extensionUri);
        this._connectionService = connectionService;
        this._schemaService = schemaService;
        this._initialize();
    }

    private async _initialize(): Promise<void> {
        this._disposables.push(
            vscode.window.onDidChangeActiveColorTheme(async (theme) => {
                this._panel.webview.postMessage({
                    type: 'themeChange',
                    data: { kind: theme.kind, tokenColors: await getTokenColors() },
                });
            })
        );

        const monacoLoaderUri = this._panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'monaco', 'vs', 'loader.js')
        );
        const monacoBaseUri = this._panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'monaco', 'vs')
        );

        const configData = {
            mode: this._mode,
            database: this._database,
            viewName: this._viewName,
            monacoBasePath: monacoBaseUri.toString(),
            themeKind: vscode.window.activeColorTheme.kind,
            tokenColors: await getTokenColors(),
            lang: getLanguage(),
        };
        const configJson = JSON.stringify(configData).replace(/<\/script>/gi, '<\\/script>');
        const configScript = '<script>window.__MATERIALIZED_VIEW_DESIGNER_CONFIG__ = ' + configJson + ';</script>';

        await this.initializeHtml([
            { placeholder: '{{MONACO_LOADER_URI}}', value: monacoLoaderUri.toString() },
            { placeholder: '{{CONFIG_INJECT}}', value: configScript },
        ]);

        this._setupMessageHandling();
    }

    public async openForCreate(database: string): Promise<void> {
        this._mode = 'create';
        this._database = database;
        this._viewName = '';
        this._refreshType = 'ASYNC';

        const activeConn = this._connectionService.getActiveConnection();
        if (!activeConn) {
            vscode.window.showErrorMessage('No active connection');
            return;
        }

        const adapter = this._connectionService.getAdapter(activeConn.id);
        if (!adapter) {
            vscode.window.showErrorMessage('No adapter found for connection');
            return;
        }

        const defaultDDL = `CREATE MATERIALIZED VIEW \`\`\nAS\nSELECT *\nFROM ;`;

        this._panel.title = `New Materialized View - ${database}`;
        this._panel.webview.postMessage({
            type: 'materializedViewStructure',
            data: {
                viewName: '',
                database,
                mode: 'create',
                ddl: defaultDDL,
                originalDDL: '',
                refreshType: 'ASYNC',
                activeStatus: 'ACTIVE',
            },
        });
    }

    public async openForEdit(database: string, viewName: string): Promise<void> {
        this._mode = 'alter';
        this._database = database;
        this._viewName = viewName;

        const activeConn = this._connectionService.getActiveConnection();
        if (!activeConn) {
            vscode.window.showErrorMessage('No active connection');
            return;
        }

        const adapter = this._connectionService.getAdapter(activeConn.id);
        if (!adapter) {
            vscode.window.showErrorMessage('No adapter found for connection');
            return;
        }

        try {
            const rawDdl = await adapter.schemaAdapter.getMaterializedViewDDL(database, viewName);
            const ddl = formatDdlOutput(rawDdl);

            const refreshMatch = ddl.match(/REFRESH\s+(ASYNC|SYNC|MANUAL)/i);
            this._refreshType = refreshMatch ? refreshMatch[1].toUpperCase() : 'ASYNC';

            let activeStatus = 'ACTIVE';
            try {
                const mvResult = await adapter.queryAdapter.execute(
                    `SHOW MATERIALIZED VIEWS FROM \`${database}\``
                );
                if (mvResult.status === 'success' && mvResult.rows.length > 0) {
                    const row = mvResult.rows.find((r: Record<string, unknown>) => {
                        return String(r.name || r.Name || r.TABLE_NAME || '').toLowerCase() === viewName.toLowerCase();
                    });
                    if (row) {
                        const isActive = row.is_active ?? row.active ?? row.IS_ACTIVE;
                        if (isActive !== undefined && isActive !== null) {
                            const activeBool = isActive === true || isActive === 'true' || isActive === 'TRUE' || isActive === 1 || isActive === '1';
                            if (!activeBool) {
                                activeStatus = 'INACTIVE';
                            }
                        }
                    }
                }
            } catch {
                // ignore query failures; default to ACTIVE
            }

            this._panel.title = `Edit Materialized View - ${viewName}`;
            this._panel.webview.postMessage({
                type: 'materializedViewStructure',
                data: {
                    viewName,
                    database,
                    mode: 'alter',
                    ddl,
                    originalDDL: ddl,
                    refreshType: this._refreshType,
                    activeStatus,
                },
            });
        } catch (error) {
            handleError(error, 'openForEdit', ErrorCategory.SUB_ITEM);
            vscode.window.showErrorMessage(`Failed to load materialized view: ${error}`);
        }
    }

    private _setupMessageHandling(): void {
        this._panel.webview.onDidReceiveMessage(
            async (message: DesignerMessage) => {
                try {
                    switch (message.command) {
                        case 'save':
                            if (message.data) {
                                await this._handleSave(message.data);
                            }
                            break;
                        case 'refresh':
                            if (message.viewName) {
                                await this._handleRefresh(message.viewName);
                            }
                            break;
                        case 'exportSql':
                            if (message.sql) {
                                await this._handleExportSql(message.sql);
                            }
                            break;
                        case 'close':
                            this.dispose();
                            break;
                        case 'ready':
                            if (this._mode === 'create') {
                                await this.openForCreate(this._database);
                            } else {
                                await this.openForEdit(this._database, this._viewName);
                            }
                            break;
                    }
                } catch (error) {
                    handleError(error, 'setupMessageHandling', ErrorCategory.FEATURE);
                    this._panel.webview.postMessage({
                        type: 'error',
                        message: `Operation failed: ${error}`,
                    });
                }
            },
            null,
            this._disposables,
        );
    }

    private async _handleSave(data: MaterializedViewDesign): Promise<void> {
        const validationError = this._validateDesign(data);
        if (validationError) {
            this._panel.webview.postMessage({
                type: 'queryError',
                data: { message: validationError },
            });
            return;
        }

        try {
            const activeConn = this._connectionService.getActiveConnection();
            if (!activeConn) {
                throw new Error('No active connection');
            }

            const adapter = this._connectionService.getAdapter(activeConn.id);
            if (!adapter) {
                throw new Error('No adapter found for connection');
            }

            const hasDdlChanges = data.mode === 'create' || data.ddl !== data.originalDDL;
            const hasStatusChanges = data.mode === 'alter' && data.activeStatus !== data.originalActiveStatus;

            if (!hasDdlChanges && !hasStatusChanges) {
                this._panel.webview.postMessage({
                    type: 'querySuccess',
                    data: { message: 'No changes to save' },
                });
                return;
            }

            const statements: string[] = [];

            if (hasDdlChanges) {
                if (data.mode === 'create') {
                    statements.push(data.ddl);
                } else {
                    const tempViewName = `${data.viewName}_tmp_${Date.now()}`;
                    let tempDDL = data.ddl.replace(
                        new RegExp(`CREATE\\s+MATERIALIZED\\s+VIEW\\s+\`?${data.viewName}\`?`, 'i'),
                        `CREATE MATERIALIZED VIEW \`${tempViewName}\``
                    );
                    statements.push(tempDDL);
                    statements.push(`ALTER MATERIALIZED VIEW \`${data.viewName}\` SWAP WITH \`${tempViewName}\``);
                    statements.push(`DROP MATERIALIZED VIEW IF EXISTS \`${tempViewName}\``);
                }
            }

            if (hasStatusChanges) {
                const statusCmd = data.activeStatus === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE';
                statements.push(`ALTER MATERIALIZED VIEW \`${data.viewName}\` ${statusCmd}`);
            }

            const sqlToExecute = statements.join(';\n');

            const confirmed = await vscode.window.showWarningMessage(
                `Confirm execution of the following SQL?\n\n${sqlToExecute}`,
                { modal: true },
                'Execute',
                'Cancel',
            );

            if (confirmed !== 'Execute') {
                return;
            }

            const execStatements = sqlToExecute.split(';').map(s => s.trim()).filter(s => s);

            this._panel.webview.postMessage({
                type: 'queryStart',
                data: { sql: execStatements[0] || '' }
            });

            let allSuccess = true;
            let lastError = '';
            for (let i = 0; i < execStatements.length; i++) {
                const stmt = execStatements[i];
                const result = await adapter.queryAdapter.execute(stmt);
                if (result.status === 'error' && result.error) {
                    allSuccess = false;
                    lastError = result.error.message || 'Unknown error';
                    break;
                }
            }

            if (allSuccess) {
                this._panel.webview.postMessage({
                    type: 'querySuccess',
                    data: { message: 'Query executed successfully' }
                });
            } else {
                this._panel.webview.postMessage({
                    type: 'queryError',
                    data: { message: lastError }
                });
            }

            if (allSuccess) {
                this._schemaService.invalidate(activeConn.id, 'materializedView', this._database);
            }

            if (data.mode === 'alter' && allSuccess) {
                const newDDL = await adapter.schemaAdapter.getMaterializedViewDDL(data.database, data.viewName);
                const formattedDDL = formatDdlOutput(newDDL);
                this._panel.webview.postMessage({
                    type: 'updateOriginalDDL',
                    data: { originalDDL: formattedDDL, originalActiveStatus: data.activeStatus },
                });
            }
        } catch (error: any) {
            handleError(error, 'handleSave', ErrorCategory.SUB_ITEM);
            const errorMsg = error?.message || String(error);
            this._panel.webview.postMessage({
                type: 'queryError',
                data: { message: errorMsg },
            });
        }
    }

    private async _handleRefresh(viewName: string): Promise<void> {
        try {
            const activeConn = this._connectionService.getActiveConnection();
            if (!activeConn) {
                throw new Error('No active connection');
            }

            const adapter = this._connectionService.getAdapter(activeConn.id);
            if (!adapter) {
                throw new Error('No adapter found for connection');
            }

            const sql = `REFRESH MATERIALIZED VIEW \`${this._database}\`.\`${viewName}\``;
            await adapter.queryAdapter.execute(sql);

            vscode.window.showInformationMessage(`Materialized view ${viewName} refresh initiated`);
        } catch (error) {
            handleError(error, 'handleRefresh', ErrorCategory.SUB_ITEM);
            vscode.window.showErrorMessage(`Failed to refresh materialized view: ${error}`);
        }
    }

    private async _handleExportSql(sql: string): Promise<void> {
        const document = await vscode.workspace.openTextDocument({
            content: sql,
            language: 'sql',
        });
        await vscode.window.showTextDocument(document);
    }

    private _validateDesign(data: MaterializedViewDesign): string | null {
        if (!data.viewName || data.viewName.trim() === '') {
            return 'View name is required';
        }

        if (!data.ddl || data.ddl.trim() === '') {
            return 'DDL is required';
        }

        return null;
    }

    public override dispose(): void {
        MaterializedViewDesignerPanel.unregisterInstance(MaterializedViewDesignerPanel.viewType);
        super.dispose();
    }
}