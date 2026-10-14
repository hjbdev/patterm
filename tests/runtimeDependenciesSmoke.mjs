import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isBuiltin } from 'node:module';
import ts from 'typescript';

test('backend value imports remain available in production installs', () => {
  const { dependencies } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  function check(specifier, file) {
    if (specifier.startsWith('.') || isBuiltin(specifier) || specifier === 'electron') return;
    const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
    assert.ok(dependencies[name], `${file}: ${specifier} must be a production dependency`);
  }
  for (const directory of ['app', 'desktop', 'server', 'routes', 'database', 'scripts']) {
    for (const entry of fs.readdirSync(directory, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue;
      const file = path.join(entry.parentPath, entry.name);
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      function visit(node) {
        if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
          const bindings = node.importClause?.namedBindings;
          const typesOnly = !node.importClause?.name && bindings && ts.isNamedImports(bindings)
            && bindings.elements.every(element => element.isTypeOnly);
          if (!typesOnly) check(node.moduleSpecifier.text, file);
        }
        if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
          const typesOnly = node.exportClause && ts.isNamedExports(node.exportClause)
            && node.exportClause.elements.every(element => element.isTypeOnly);
          if (!typesOnly) check(node.moduleSpecifier.text, file);
        }
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
          || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
          && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) check(node.arguments[0].text, file);
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
});
