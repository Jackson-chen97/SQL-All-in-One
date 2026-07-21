import * as vscode from 'vscode';
import { BaseWebviewPanel, type WebviewPanelConfig } from '../BaseWebviewPanel';
import type { IConnectionService, ISchemaService } from '../../application/ports';
import type { MaterializedViewInfo } from '../../database/adapters/IDatabaseAdapter';
import { handleError, ErrorCategory } from '../../core/errorHandler';
import { getLanguage } from '../../i18n';
import { getTokenColors } from '../../utils/themeColors';
import { formatEditorText } from '../../utils/formatEditorText';
import { createConfig } from '../../core/configManager';

function formatDdlOutput(ddl: string): string {
    try {
        const extensionSettings = vscode.workspace.getConfiguration('SQL-All-in-One');
        const formattingOptions: vscode.FormattingOptions = {
            tabSize: extensionSettings.get<number>('format.tabSize', 2),
            insertSpaces: extensionSettings.get<boolean>('format.useTabs', false) === false,
        };
        const config = createConfig(extensionSettings, formattingOptions, 'starrocks');
        return formatEditorText(ddl, config);
    } catch {
        // Fallback to basic formatting if shared formatter fails
        return ddl.replace(/\s+/g, ' ').trim();
    }
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