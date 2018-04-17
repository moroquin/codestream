'user strict';
import { commands, TextDocumentShowOptions, TextEditor, Uri, ViewColumn, window, workspace } from 'vscode';
import { Logger } from './logger';

export enum BuiltInCommands {
    CloseActiveEditor = 'workbench.action.closeActiveEditor',
    CloseAllEditors = 'workbench.action.closeAllEditors',
    CursorMove = 'cursorMove',
    Diff = 'vscode.diff',
    EditorScroll = 'editorScroll',
    ExecuteDocumentSymbolProvider = 'vscode.executeDocumentSymbolProvider',
    ExecuteCodeLensProvider = 'vscode.executeCodeLensProvider',
    Open = 'vscode.open',
    NextEditor = 'workbench.action.nextEditor',
    PreviewHtml = 'vscode.previewHtml',
    RevealLine = 'revealLine',
    SetContext = 'setContext',
    ShowReferences = 'editor.action.showReferences'
}

export enum ContextKeys {
    LiveShareInstalled = 'codestream:liveShareInstalled',
    Status = 'codestream:status'
}

export async function openEditor(uri: Uri, options: TextDocumentShowOptions & { rethrow?: boolean } = {}): Promise<TextEditor | undefined> {
    const { rethrow, ...opts } = options;
    try {
        const document = await workspace.openTextDocument(uri);
        return window.showTextDocument(document, {
            preserveFocus: false,
            preview: true,
            viewColumn: ViewColumn.Active,
            ...opts
        });
    }
    catch (ex) {
        const msg = ex.toString();
        if (msg.includes('File seems to be binary and cannot be opened as text')) {
            await commands.executeCommand(BuiltInCommands.Open, uri);

            return undefined;
        }

        if (rethrow) throw ex;

        Logger.error(ex, 'openEditor');
        return undefined;
    }
}

export function setContext(key: ContextKeys | string, value: any) {
    return commands.executeCommand('setContext', key, value);
}
