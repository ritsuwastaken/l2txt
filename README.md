# l2txt

Linter for L2 script files, reports problems as LSP diagnostics. Supports C1 and C2 only.

## VS Code

```typescript
import * as vscode from "vscode";
import { watch } from "l2txt/vscode";

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(watch(vscode));
}
```

## Monaco

```typescript
import { validateModel } from "l2txt/monaco";

const client = validateModel(monaco, model);
model.onDidChangeContent(() => validateModel(monaco, model));
```
