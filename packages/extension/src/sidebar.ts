import * as vscode from 'vscode';
import {
  OPEN_DIAGRAM_COMMAND,
  SHOW_REQUEST_FLOW_COMMAND,
  SHOW_SEQUENCE_COMMAND,
  SHOW_TRAIT_MAP_COMMAND,
} from './constants';
import type { EntryPoint } from '@codeflow/shared';
import { getEntryCatalog, groupEntries } from './entryCatalog';
import { renderSidebarHtml } from './html';
import { createNonce } from './nonce';
import { getSavedFlows } from './savedFlows';
import { isSidebarToExtensionMessage } from './sidebarMessage';

const ENTRY_DEBOUNCE_MS = 50;

export class SidebarProvider implements vscode.WebviewViewProvider {
  public constructor(private readonly onOpen?: () => void) {}
  private static active: SidebarProvider | undefined;
  private static lastEntries: readonly EntryPoint[] = [];

  /** Entries last posted to the side panel, for the extension test host. */
  public static postedEntries(): readonly EntryPoint[] {
    return SidebarProvider.lastEntries;
  }

  /** Delivers a message as if the side panel had posted it. */
  public static deliver(message: unknown): void {
    SidebarProvider.active?.handleMessage(message);
  }

  private view: vscode.WebviewView | undefined;
  private listener: vscode.Disposable | undefined;
  private catalogListener: { dispose(): void } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flowListener: { dispose(): void } | undefined;

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.onOpen?.();
    SidebarProvider.active = this;
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = renderSidebarHtml({
      nonce: createNonce(),
      cspSource: webviewView.webview.cspSource,
    });

    this.listener?.dispose();
    this.listener = webviewView.webview.onDidReceiveMessage((message: unknown) => {
      this.handleMessage(message);
    });

    this.catalogListener?.dispose();
    this.catalogListener = getEntryCatalog().onChanged(() => {
      this.scheduleEntries();
    });
    this.flowListener?.dispose();
    this.flowListener = getSavedFlows()?.onDidChange(() => {
      this.postFlows();
    });
    this.postEntries();
    this.postFlows();

    webviewView.onDidDispose(() => {
      this.listener?.dispose();
      this.listener = undefined;
      this.catalogListener?.dispose();
      this.catalogListener = undefined;
      this.flowListener?.dispose();
      this.flowListener = undefined;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = undefined;
      }
      if (this.view === webviewView) {
        this.view = undefined;
      }
      if (SidebarProvider.active === this) {
        SidebarProvider.active = undefined;
      }
    });
  }

  private handleMessage(message: unknown): void {
    if (!isSidebarToExtensionMessage(message)) {
      return;
    }
    if (message.type === 'showRequestFlow') {
      void vscode.commands.executeCommand(SHOW_REQUEST_FLOW_COMMAND, message.entryId);
      return;
    }
    if (message.type === 'showSequence') {
      void vscode.commands.executeCommand(SHOW_SEQUENCE_COMMAND, message.entryId);
      return;
    }
    if (message.type === 'revealEntry') {
      this.revealEntry(message.entryId);
      return;
    }
    if (message.type === 'openSavedFlow') {
      void getSavedFlows()?.open(message.id);
      return;
    }
    if (message.type === 'renameSavedFlow') {
      void getSavedFlows()?.rename(message.id);
      return;
    }
    if (message.type === 'deleteSavedFlow') {
      void getSavedFlows()?.remove(message.id);
      return;
    }
    void vscode.commands.executeCommand(
      message.type === 'showTraitMap' ? SHOW_TRAIT_MAP_COMMAND : OPEN_DIAGRAM_COMMAND,
    );
  }

  private scheduleEntries(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.postEntries();
    }, ENTRY_DEBOUNCE_MS);
  }

  private postEntries(): void {
    const view = this.view;
    if (!view) {
      return;
    }
    const entries = groupEntries(getEntryCatalog().list()).flatMap((group) => [...group.entries]);
    SidebarProvider.lastEntries = entries;
    void view.webview.postMessage({ type: 'entries', entries });
  }

  private postFlows(): void {
    const view = this.view;
    if (!view) {
      return;
    }
    void view.webview.postMessage({ type: 'savedFlows', flows: getSavedFlows()?.list() ?? [] });
  }

  private revealEntry(entryId: string): void {
    const entry = getEntryCatalog().get(entryId);
    if (!entry) {
      return;
    }
    const uri = vscode.Uri.parse(entry.handlerUri);
    const selection = new vscode.Range(
      entry.handlerRange.start.line,
      entry.handlerRange.start.character,
      entry.handlerRange.end.line,
      entry.handlerRange.end.character,
    );
    void vscode.window.showTextDocument(uri, { selection, preview: true });
  }
}
