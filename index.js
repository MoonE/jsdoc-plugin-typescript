const path = require('path');
const fs = require('fs');
const env = require('jsdoc/env');

const config = env.conf.typescript;
if (!config) {
  throw new Error('Configuration "typescript" for jsdoc-plugin-typescript missing.');
}
if (!'moduleRoot' in config) {
  throw new Error('Configuration "typescript.moduleRoot" for jsdoc-plugin-typescript missing.');
}
const moduleRoot = config.moduleRoot;
const moduleRootAbsolute = path.join(process.cwd(), moduleRoot);
if (!fs.existsSync(moduleRootAbsolute)) {
  throw new Error('Directory "' + moduleRootAbsolute + '" does not exist. Check the "typescript.moduleRoot" config option for jsdoc-plugin-typescript');
}

const importRegEx = /(typeof )?import\("([^"]*)"\)\.([^ \.\|\}><,\)=\n]*)([ \.\|\}><,\)=\n])/g;
const typedefRegEx = /@typedef \{[^\}]*\} ([^ \r?\n?]*)/;

const moduleInfos = {};
const fileNodes = {};

function getModuleInfo(moduleId, parser) {
  if (!moduleInfos[moduleId]) {
    const moduleInfo = moduleInfos[moduleId] = {
      namedExports: {}
    };
    if (!fileNodes[moduleId]) {
      const classDeclarations = {};
      const absolutePath = path.join(process.cwd(), moduleRoot, moduleId + '.js');
      const file = fs.readFileSync(absolutePath, 'UTF-8');
      const node = fileNodes[moduleId] = parser.astBuilder.build(file, absolutePath);
      if (node.program && node.program.body) {
        const nodes = node.program.body;
        for (let i = 0, ii = nodes.length; i < ii; ++i) {
          const node = nodes[i];
          if (node.type === 'ClassDeclaration') {
            classDeclarations[node.id.name] = node;
          } else if (node.type === 'ExportDefaultDeclaration') {
            const classDeclaration = classDeclarations[node.declaration.name];
            if (classDeclaration) {
              moduleInfo.defaultExport = classDeclaration.id.name;
            }
          } else if (node.type === 'ExportNamedDeclaration' && node.declaration && node.declaration.type === 'ClassDeclaration') {
            moduleInfo.namedExports[node.declaration.id.name] = true;
          }
        }
      }
    }
  }
  return moduleInfos[moduleId];
}

function getDefaultExportName(moduleId, parser) {
  return getModuleInfo(moduleId, parser).defaultExport;
}

function getDelimiter(moduleId, symbol, parser) {
  return getModuleInfo(moduleId, parser).namedExports[symbol] ? '.' : '~'
}

exports.astNodeVisitor = {

  visitNode: function(node, e, parser, currentSourceName) {
    if (node.type === 'File') {
      const relPath = path.relative(process.cwd(), currentSourceName);
      const modulePath = path.relative(path.join(process.cwd(), moduleRoot), currentSourceName).replace(/\.js$/, '');
      fileNodes[modulePath] = node;
      const identifiers = {};
      if (node.program && node.program.body) {
        const nodes = node.program.body;
        for (let i = 0, ii = nodes.length; i < ii; ++i) {
          let node = nodes[i];
          if (node.type === 'ExportNamedDeclaration' && node.declaration) {
            node = node.declaration;
          }
          if (node.type === 'ImportDeclaration') {
            node.specifiers.forEach(specifier => {
              let defaultImport = false;
              switch (specifier.type) {
                case 'ImportDefaultSpecifier':
                  defaultImport = true;
                  // fallthrough
                case 'ImportSpecifier':
                  identifiers[specifier.local.name] = {
                    defaultImport,
                    value: node.source.value
                  };
                  break;
                default:
              }
            });
          } else if (node.type === 'ClassDeclaration') {
            if (node.id && node.id.name) {
              identifiers[node.id.name] = {
                value: path.basename(currentSourceName)
              };
            }

            // Add class inheritance information because JSDoc does not honor
            // the ES6 class's `extends` keyword
            if (node.superClass && node.leadingComments) {
              const leadingComment = node.leadingComments[node.leadingComments.length - 1];
              const lines = leadingComment.value.split(/\r?\n/);
              lines.push(lines[lines.length - 1]);
              const identifier = identifiers[node.superClass.name];
              if (identifier) {
                const absolutePath = path.resolve(path.dirname(currentSourceName), identifier.value);
                const moduleId = path.relative(path.join(process.cwd(), moduleRoot), absolutePath).replace(/\.js$/, '');
                const exportName = identifier.defaultImport ? getDefaultExportName(moduleId, parser) : node.superClass.name;
                const delimiter = identifier.defaultImport ? '~' : getDelimiter(moduleId, exportName, parser);
                lines[lines.length - 2] = ' * @extends ' + `module:${moduleId}${exportName ? delimiter + exportName : ''}`;
              } else {
                lines[lines.length - 2] = ' * @extends ' + node.superClass.name;
              }
              leadingComment.value = lines.join('\n');
            }

          }
        }
      }
      if (node.comments) {
        node.comments.forEach(comment => {
          //TODO Handle typeof, to indicate that a constructor instead of an
          // instance is needed.
          comment.value = comment.value.replace(/typeof /g, '');

          // Convert `import("path/to/module").export` to
          // `module:path/to/module~Name`
          let importMatch;
          while ((importMatch = importRegEx.exec(comment.value))) {
            importRegEx.lastIndex = 0;
            let replacement;
            if (importMatch[2].charAt(0) !== '.') {
              // simplified replacement for external packages
              replacement = `module:${importMatch[2]}${importMatch[3] === 'default' ? '' : '~' + importMatch[3]}`;
            } else {
              const rel = path.resolve(path.dirname(currentSourceName), importMatch[2]);
              const importModule = path.relative(path.join(process.cwd(), moduleRoot), rel).replace(/\.js$/, '');
              const exportName = importMatch[3] === 'default' ? getDefaultExportName(importModule, parser) : importMatch[3];
              const delimiter = importMatch[3] === 'default' ? '~': getDelimiter(importModule, exportName, parser);
              replacement = `module:${importModule}${exportName ? delimiter + exportName : ''}`;
            }
            comment.value = comment.value.replace(importMatch[0], replacement + importMatch[4]);
          }

          // Treat `@typedef`s like named exports
          const typedefMatch = comment.value.replace(/\r?\n?\s*\*\s/g, ' ').match(typedefRegEx);
          if (typedefMatch) {
            identifiers[typedefMatch[1]] = {
              value: path.basename(currentSourceName)
            };
          }

          // Replace local types with the full `module:` path
          Object.keys(identifiers).forEach(key => {
            const regex = new RegExp(`(@fires |[\{<\|,] ?)${key}`, 'g');
            if (regex.test(comment.value)) {
              const identifier = identifiers[key];
              const absolutePath = path.resolve(path.dirname(currentSourceName), identifier.value);
              const moduleId = path.relative(path.join(process.cwd(), moduleRoot), absolutePath).replace(/\.js$/, '');
              const exportName = identifier.defaultImport ? getDefaultExportName(moduleId, parser) : key;
              const delimiter = identifier.defaultImport ? '~' : getDelimiter(moduleId, exportName, parser);
              const replacement = `module:${moduleId}${exportName ? delimiter + exportName : ''}`;
              comment.value = comment.value.replace(regex, '$1' + replacement);
            }
          });
        });
      }
    }
  }

};
