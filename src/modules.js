import { List } from 'immutable';
import Env from "./env";
import Store from "./store";
import Reader from "./shift-reader";
import * as _ from "ramda";
import TokenExpander from './token-expander.js';
import BindingMap from "./binding-map.js";
import Term, {
  isEOF, isBindingIdentifier, isFunctionDeclaration, isFunctionExpression,
  isFunctionTerm, isFunctionWithName, isSyntaxDeclaration, isSyntaxrecDeclaration, isVariableDeclaration,
  isVariableDeclarationStatement, isImport, isExport, isExportSyntax, isSyntaxDeclarationStatement,
  isPragma
} from "./terms";
import { evalCompiletimeValue, evalRuntimeValues } from './load-syntax';
import Compiler from "./compiler";
import { VarBindingTransform, CompiletimeTransform } from './transforms';
import { Scope, freshScope } from "./scope";

export class Module {
  constructor(moduleSpecifier, importEntries, exportEntries, pragmas, body) {
    this.moduleSpecifier = moduleSpecifier;
    this.importEntries = importEntries;
    this.exportEntries = exportEntries;
    this.pragmas = pragmas;
    this.body = body;
  }
}

const pragmaRegep = /^\s*#\w*/;

export class Modules {
  constructor(context) {
    this.compiledModules = new Map();
    this.context = context;
    this.context.modules = this;
  }

  load(path) {
    // TODO resolve and we need to carry the cwd through correctly
    let mod = this.context.moduleLoader(path);
    if (!pragmaRegep.test(mod)) {
      return List();
    }
    return new Reader(mod).read();
  }

  compile(stxl, path) {
    // the expander starts at phase 0, with an empty environment and store
    let scope = freshScope('top');
    let compiler = new Compiler(0, new Env(), new Store(), _.merge(this.context, {
      currentScope: [scope]
    }));
    let terms = compiler.compile(stxl.map(s => s.addScope(scope, this.context.bindings, 0)));

    let importEntries = [];
    let exportEntries = [];
    let pragmas = [];
    let filteredTerms = terms.reduce((acc, t) => {
      return _.cond([
        [isImport, t => { importEntries.push(t); return acc.concat(t); } ],
        [isExport, t => { exportEntries.push(t); return acc.concat(t); } ],
        [isPragma, t => { pragmas.push(t); return acc; } ],
        [_.T, t => acc.concat(t) ]
      ])(t);
    }, List());
    return new Module(
      path,
      List(importEntries),
      List(exportEntries),
      List(pragmas),
      filteredTerms
    );
  }

  loadAndCompile(rawPath) {
    let path = this.context.moduleResolver(rawPath, this.context.cwd);
    if (!this.compiledModules.has(path)) {
      this.compiledModules.set(path, this.compile(this.load(path), path));
    }
    return this.compiledModules.get(path);
  }

  visit(mod, phase, store) {
    mod.body.forEach(term => {
      if (isSyntaxDeclarationStatement(term) || isExportSyntax(term)) {
        term.declaration.declarators.forEach(({binding, init}) => {
          let val = evalCompiletimeValue(init.gen(), _.merge(this.context, {
            store, phase: phase + 1
          }));
          // binding for imports
          store.set(mod.moduleSpecifier + ":" + binding.name.val() + ":" + phase, new CompiletimeTransform(val));
          // module local binding
          store.set(binding.name.resolve(phase), new CompiletimeTransform(val));
        });
      }
    });
    return store;
  }

  invoke(mod, phase, store) {
    let body = mod.body.map(term => term.gen());
    let exportsObj = evalRuntimeValues(body, _.merge(this.context, {
      store, phase
    }));
    for (let key of Object.keys(exportsObj)) {
      store.set(mod.moduleSpecifier + ":" + key + ":" + phase, new CompiletimeTransform(exportsObj[key]));
    }
    return store;
  }
}
