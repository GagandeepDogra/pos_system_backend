// Lets a plain `node` child process load the TypeScript sources (used by the
// kill -9 chaos test, which needs a real process to kill).
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

const shared = path.resolve(__dirname, '../../../../packages/shared/src/index.ts');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === '@dhaba/shared' ? shared : resolve.call(this, request, ...rest);
};
require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2021,
      esModuleInterop: true,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
    },
  });
  module._compile(outputText, filename);
};
