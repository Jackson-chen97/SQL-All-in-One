import * as vscode from 'vscode';
import type { IConnectionService, ISchemaService } from '../../application/ports';
import { MaterializedViewDesignerPanel } from './MaterializedViewDesignerPanel';
import { handleError, ErrorCategory } from '../../core/errorHandler';
import type { MaterializedViewTreeNode } from '../databaseExplorer/treeNodes';
import { formatEditorText } from '../../utils/formatEditorText';
import { createConfig } from '../../core/configManager';

export function registerMaterializedViewDesignerCommands(
    context: vscode.ExtensionContext,
    connectionService: IConnectionService,
    schemaService: ISchemaService,
): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = [];

    disposables.push(
        vscode.commands.registerCommand(
            'sqlAllInOne.createMaterializedView',
            async (node?: MaterializedViewTreeNode) => {
                try {
                    const database = node?.databaseName ?? (await askForDatabase(connectionService));
                    if (!database) {
                        return;
                    }

                    const panel = MaterializedViewDesignerPanel.createOrShow(
                        context.extensionUri,
                        context,
                        connectionService,
                        schemaService,
                    );
                    await panel.openForCreate(database);
                } catch (error) {
                    handleError(error, 'createMaterializedView', ErrorCategory.FEATURE);
                }
            },
        ),
    );

    disposables.push(
        vscode.commands.registerCommand(
            'sqlAllInOne.editMaterializedView',
            async (node?: MaterializedViewTreeNode) => {
                try {
                    if (!node) {
                        vscode.window.showErrorMessage('No materialized view selected');
                        return;
                    }

                    const panel = MaterializedViewDesignerPanel.createOrShow(
                        context.extensionUri,
                        context,
                        connectionService,
                        schemaService,
                    );
                    await panel.openForEdit(node.databaseName, node.mvName);
                } catch (error) {
                    handleError(error, 'editMaterializedView', ErrorCategory.FEATURE);
                }
            },
        ),
    );

    disposables.push(
        vscode.commands.registerCommand(
            'sqlAllInOne.dropMaterializedView',
            async (node?: MaterializedViewTreeNode) => {
                try {
                    if (!node) {
                        vscode.window.showErrorMessage('No materialized view selected');
                        return;
                    }

                    const activeConn = connectionService.getActiveConnection();
                    if (!activeConn) {
                        vscode.window.showErrorMessage('No active connection');
                        return;
                    }

                    const sql = `DROP MATERIALIZED VIEW \`${node.databaseName}\`.\`${node.mvName}\``;

                    await vscode.commands.executeCommand(
                        'hive-formatter.setQueryResultPanelCallbacks',
                        activeConn.id,
                        node.databaseName,
                    );

                    await vscode.commands.executeCommand(
                        'hive-formatter.setQueryResultPanelSql',
                        sql,
                        true,
                    );

                    schemaService.invalidate(activeConn.id, 'materializedView', node.databaseName);
                } catch (error) {
                    handleError(error, 'dropMaterializedView', ErrorCategory.SUB_ITEM);
                    vscode.window.showErrorMessage(`Failed to drop materialized view: ${error}`);
                }
            },
        ),
    );

    disposables.push(
        vscode.commands.registerCommand(
            'sqlAllInOne.refreshMaterializedView',
            async (node?: MaterializedViewTreeNode) => {
                try {
                    if (!node) {
                        vscode.window.showErrorMessage('No materialized view selected');
                        return;
                    }

                    const activeConn = connectionService.getActiveConnection();
                    if (!activeConn) {
                        vscode.window.showErrorMessage('No active connection');
                        return;
                    }

                    const sql = `REFRESH MATERIALIZED VIEW \`${node.databaseName}\`.\`${node.mvName}\``;

                    await vscode.commands.executeCommand(
                        'hive-formatter.setQueryResultPanelCallbacks',
                        activeConn.id,
                        node.databaseName,
                    );

                    await vscode.commands.executeCommand(
                        'hive-formatter.setQueryResultPanelSql',
                        sql,
                        true,
                    );
                } catch (error) {
                    handleError(error, 'refreshMaterializedView', ErrorCategory.SUB_ITEM);
                    vscode.window.showErrorMessage(`Failed to refresh materialized view: ${error}`);
                }
            },
        ),
    );

    disposables.push(
        vscode.commands.registerCommand(
            'sqlAllInOne.viewMaterializedViewDDL',
            async (node?: MaterializedViewTreeNode) => {
                try {
                    if (!node) {
                        vscode.window.showErrorMessage('No materialized view selected');
                        return;
                    }

                    const activeConn = connectionService.getActiveConnection();
                    if (!activeConn) {
                        vscode.window.showErrorMessage('No active connection');
                        return;
                    }

                    const adapter = connectionService.getAdapter(activeConn.id);
                    if (!adapter) {
                        vscode.window.showErrorMessage('No adapter found for connection');
                        return;
                    }

                    const rawDdl = await adapter.schemaAdapter.getMaterializedViewDDL(
                        node.databaseName,
                        node.mvName,
                    );

                    // Format the DDL using the shared formatter
                    let ddl = rawDdl;
                    try {
                        const extensionSettings = vscode.workspace.getConfiguration('SQL-All-in-One');
                        const formattingOptions: vscode.FormattingOptions = {
                            tabSize: extensionSettings.get<number>('format.tabSize', 2),
                            insertSpaces: extensionSettings.get<boolean>('format.useTabs', false) === false,
                        };
                        const config = createConfig(extensionSettings, formattingOptions, 'starrocks');
                        ddl = formatEditorText(rawDdl, config);
                    } catch {
                        // Use raw DDL if formatting fails
                        ddl = rawDdl;
                    }

                    const document = await vscode.workspace.openTextDocument({
                        content: ddl,
                        language: 'sql',
                    });
                    await vscode.window.showTextDocument(document);
                } catch (error) {
                    handleError(error, 'viewMaterializedViewDDL', ErrorCategory.SUB_ITEM);
                    vscode.window.showErrorMessage(`Failed to get materialized view DDL: ${error}`);
                }
            },
        ),
    );

    disposables.push(
        vscode.commands.registerCommand(
            'sqlAllInOne.setMaterializedViewActive',
            async (node?: MaterializedViewTreeNode) => {
                try {
                    if (!node) {
                        vscode.window.showErrorMessage('No materialized view selected');
                        return;
                    }

                    const activeConn = connectionService.getActiveConnection();
                    if (!activeConn) {
                        vscode.window.showErrorMessage('No active connection');
                        return;
                    }

                    const sql = `ALTER MATERIALIZED VIEW \`${node.databaseName}\`.\`${node.mvName}\` ACTIVE`;

                    await vscode.commands.executeCommand(
                        'hive-formatter.setQueryResultPanelCallbacks',
                        activeConn.id,
                        node.databaseName,
                    );

                    await vscode.commands.executeCommand(
                        'hive-formatter.setQueryResultPanelSql',
                        sql,
                        true,
                    );

                    schemaService.invalidate(activeConn.id, 'materializedView', node.databaseName);
                } catch (error) {
                    handleError(error, 'setMaterializedViewActive', ErrorCategory.SUB_ITEM);
                    vscode.window.showErrorMessage(`Failed to activate materialized view: ${error}`);
                }
            },
        ),
    );

    disposables.push(
        vscode.commands.registerCommand(
            'sqlAllInOne.setMaterializedViewInactive',
            async (node?: MaterializedViewTreeNode) => {
                try {
                    if (!node) {
                        vscode.window.showErrorMessage('No materialized view selected');
                        return;
                    }

                    const activeConn = connectionService.getActiveConnection();
                    if (!activeConn) {
                        vscode.window.showErrorMessage('No active connection');
                        return;
                    }

                    const sql = `ALTER MATERIALIZED VIEW \`${node.databaseName}\`.\`${node.mvName}\` INACTIVE`;

                    await vscode.commands.executeCommand(
                        'hive-formatter.setQueryResultPanelCallbacks',
                        activeConn.id,
                        node.databaseName,
                    );

                    await vscode.commands.executeCommand(
                        'hive-formatter.setQueryResultPanelSql',
                        sql,
                        true,
                    );

                    schemaService.invalidate(activeConn.id, 'materializedView', node.databaseName);
                } catch (error) {
                    handleError(error, 'setMaterializedViewInactive', ErrorCategory.SUB_ITEM);
                    vscode.window.showErrorMessage(`Failed to deactivate materialized view: ${error}`);
                }
            },
        ),
    );

    return disposables;
}

async function askForDatabase(connectionService: IConnectionService): Promise<string | undefined> {
    const activeConn = connectionService.getActiveConnection();
    if (!activeConn) {
        vscode.window.showErrorMessage('No active connection');
        return undefined;
    }

    const adapter = connectionService.getAdapter(activeConn.id);
    if (!adapter) {
        vscode.window.showErrorMessage('No adapter found for connection');
        return undefined;
    }

    const databases = await adapter.metadataAdapter.listDatabases();
    if (databases.length === 0) {
        vscode.window.showErrorMessage('No databases found');
        return undefined;
    }

    if (databases.length === 1) {
        return databases[0].name;
    }

    return vscode.window.showQuickPick(
        databases.map((db) => db.name),
        { placeHolder: 'Select database' },
    );
}