/**
 * When the cursor moves in a supported editor, highlight that symbol in the
 * open diagram. The diagram's own reveal is ignored so the two do not loop.
 */

import * as vscode from 'vscode';
import { findSymbolAt } from './analyzers/typescript/findSymbol';
import { isRustSourcePath } from './analyzers/rust/extensions';
import { isSupportedSourcePath } from './analyzers/typescript/extensions';
import {
  CURSOR_FOLLOW_DEBOUNCE_MS,
  CURSOR_REVEAL_GUARD_MS,
  EDITOR_LANGUAGE_IDS,
} from './constants';
import { createCursorFollow } from './cursorFollow';
import type { CursorPoint } from './cursorFollow';
import { DiagramPanel } from './diagramPanel';
import { readFollowCursor } from './editorSettings';
import { nodesInFile } from './focusQuery';
import { setRevealGuard } from './revealGuard';
import { getWorkspaceGraph } from './workspaceGraph';

const languages = new Set<string>(EDITOR_LANGUAGE_IDS);

export function startEditorSync(): vscode.Disposable {
  const follow = createCursorFollow({
    debounceMs: CURSOR_FOLLOW_DEBOUNCE_MS,
    guardMs: CURSOR_REVEAL_GUARD_MS,
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      return { cancel: () => clearTimeout(timer) };
    },
    follow: (point) => {
      highlight(point);
    },
  });
  setRevealGuard((location) => {
    follow.noteReveal({
      uri: location.uri,
      startLine: location.range.start.line,
      startCharacter: location.range.start.character,
      endLine: location.range.end.line,
      endCharacter: location.range.end.character,
    });
  });
  const subscription = vscode.window.onDidChangeTextEditorSelection((event) => {
    if (!readFollowCursor()) {
      return;
    }
    const editor = event.textEditor;
    if (!isFollowedDocument(editor.document)) {
      return;
    }
    const selection = editor.selection;
    follow.onCursor(
      {
        uri: editor.document.uri.toString(),
        line: selection.active.line,
        character: selection.active.character,
      },
      {
        uri: editor.document.uri.toString(),
        startLine: selection.start.line,
        startCharacter: selection.start.character,
        endLine: selection.end.line,
        endCharacter: selection.end.character,
      },
    );
  });
  return new vscode.Disposable(() => {
    subscription.dispose();
    follow.dispose();
    setRevealGuard(undefined);
  });
}

function highlight(point: CursorPoint): void {
  if (!readFollowCursor()) {
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.toString() !== point.uri) {
    return;
  }
  const position = editor.selection.active;
  const nodes = nodesInFile(getWorkspaceGraph(), editor.document.uri.fsPath);
  const symbol = findSymbolAt(nodes, position.line, position.character);
  DiagramPanel.highlightCursor(symbol?.id);
}

function isFollowedDocument(document: vscode.TextDocument): boolean {
  if (document.uri.scheme !== 'file') {
    return false;
  }
  if (languages.has(document.languageId)) {
    return true;
  }
  return isSupportedSourcePath(document.uri.fsPath) || isRustSourcePath(document.uri.fsPath);
}
