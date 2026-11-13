import type { DiagramTheme } from '@codeflow/shared';
import * as vscode from 'vscode';

export function diagramThemeFromColorTheme(kind: vscode.ColorThemeKind): DiagramTheme {
  switch (kind) {
    case vscode.ColorThemeKind.Light:
      return 'light';
    case vscode.ColorThemeKind.Dark:
      return 'dark';
    case vscode.ColorThemeKind.HighContrast:
      return 'high-contrast';
    case vscode.ColorThemeKind.HighContrastLight:
      return 'high-contrast-light';
    default:
      return 'dark';
  }
}
