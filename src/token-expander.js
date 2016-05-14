import { List } from 'immutable';
import { enforestExpr, Enforester } from "./enforester";
import TermExpander from "./term-expander.js";
import BindingMap from "./binding-map.js";
import Env from "./env";
import Reader from "./shift-reader";
import * as _ from "ramda";
import Term, {
  isEOF, isBindingIdentifier, isBindingPropertyProperty, isBindingPropertyIdentifier, isObjectBinding, isArrayBinding, isFunctionDeclaration, isFunctionExpression,
  isFunctionTerm, isFunctionWithName, isSyntaxDeclaration, isSyntaxrecDeclaration, isVariableDeclaration,
  isVariableDeclarationStatement, isImport, isExport, isPragma, isExportSyntax
} from "./terms";
import { Maybe } from 'ramda-fantasy';
import { gensym } from './symbol';
import { VarBindingTransform, CompiletimeTransform } from './transforms';
import { expect, assert } from "./errors";
import { evalCompiletimeValue } from './load-syntax';
import { Scope, freshScope } from "./scope";
import Syntax, { ALL_PHASES } from './syntax';

const Just = Maybe.Just;
const Nothing = Maybe.Nothing;

const registerSyntax = (stx, context) => {
  let newBinding = gensym(stx.val());
  context.env.set(newBinding.toString(), new VarBindingTransform(stx));
  context.bindings.add(stx, {
    binding: newBinding,
    phase: context.phase,
    // skip dup because js allows variable redeclarations
    // (technically only for `var` but we can let later stages of the pipeline
    // handle incorrect redeclarations of `const` and `let`)
    skipDup: true
  });
};

let registerBindings = _.cond([
  [isBindingIdentifier, ({name}, context) => {
    registerSyntax(name, context);
  }],
  [isBindingPropertyIdentifier, ({binding}, context) => {
    registerBindings(binding, context);
  }],
  [isBindingPropertyProperty, ({binding}, context) => {
    registerBindings(binding, context);
  }],
  [isArrayBinding, ({elements, restElement}, context) => {
    if (restElement != null) {
      registerBindings(restElement, context);
    }
    elements.forEach(el => {
      if (el != null) {
        registerBindings(el, context);
      }
    });
  }],
  [isObjectBinding, ({properties}, context) => {
    // properties.forEach(prop => registerBindings(prop, context));
  }],
  [_.T, binding => assert(false, "not implemented yet for: " + binding.type)]
]);

let removeScope = _.cond([
  [isBindingIdentifier, ({name}, scope, phase) => new Term('BindingIdentifier', {
    name: name.removeScope(scope, phase)
  })],
  [isArrayBinding, ({elements, restElement}, scope, phase) => {
    return new Term('ArrayBinding', {
      elements: elements.map(el => el == null ? null : removeScope(el, scope, phase)),
      restElement: restElement == null ? null : removeScope(restElement, scope, phase)
    });
  }],
  [isBindingPropertyIdentifier, ({binding, init}, scope, phase) => new Term('BindingPropertyIdentifier', {
    binding: removeScope(binding, scope, phase),
    init
  })],
  [isBindingPropertyProperty, ({binding, name}, scope, phase) => new Term('BindingPropertyProperty', {
    binding: removeScope(binding, scope, phase), name
  })],
  [isObjectBinding, ({properties}, scope, phase) => new Term('ObjectBinding', {
    properties: properties.map(prop => removeScope(prop, scope, phase))
  })],
  [_.T, binding => assert(false, "not implemented yet for: " + binding.type)]
]);

function findNameInExports(name, exp) {
  let foundNames = exp.reduce((acc, e) => {
    if (e.declaration) {
      return acc.concat(e.declaration.declarators.reduce((acc, decl) => {
        if (decl.binding.name.val() === name.val()) {
          return acc.concat(decl.binding.name);
        }
        return acc;
      }, List()));
    }
    return acc;
  }, List());
  assert(foundNames.size <= 1, 'expecting no more than 1 matching name in exports');
  return foundNames.get(0);
}

function removeNames(impTerm, names) {
  return new Term(impTerm.type, {
    moduleSpecifier: impTerm.moduleSpecifier,
    defaultBinding: impTerm.defaultBinding,
    forSyntax: impTerm.forSyntax,
    namedImports: impTerm.namedImports.filter(specifier => !names.contains(specifier.binding.name))
  });
}

function bindAllSyntaxExports(exModule, toSynth, context) {
  let phase = context.phase;
  exModule.exportEntries.forEach(ex => {
    if (isExportSyntax(ex)) {
      ex.declaration.declarators.forEach(decl => {
        let name = decl.binding.name;
        let newBinding = gensym(name.val());
        let storeName = exModule.moduleSpecifier + ":" + name.val() + ":" + phase;
        let synthStx = Syntax.fromIdentifier(name.val(), toSynth);
        let storeStx = Syntax.fromIdentifier(storeName, toSynth);
        context.bindings.addForward(synthStx, storeStx, newBinding, phase);
      });
    }
  });
}

function bindImports(impTerm, exModule, context) {
  let names = [];
  let phase = impTerm.forSyntax ? context.phase + 1 : context.phase;
  impTerm.namedImports.forEach(specifier => {
    let name = specifier.binding.name;
    let exportName = findNameInExports(name, exModule.exportEntries);
    if (exportName != null) {
      let newBinding = gensym(name.val());
      let storeName = exModule.moduleSpecifier + ":" + exportName.val() + ":" + phase;
      if (context.store.has(storeName)) {
        let storeStx = Syntax.fromIdentifier(storeName);
        context.bindings.addForward(name, storeStx, newBinding, phase);
        names.push(name);
      }
    }
  });
  return List(names);
}


export default class TokenExpander {
  constructor(context) {
    this.context = context;
  }

  expand(stxl) {
    let result = List();
    if (stxl.size === 0) {
      return result;
    }
    let prev = List();
    let enf = new Enforester(stxl, prev, this.context);
    let self = this;
    let phase = self.context.phase;
    let env = self.context.env;
    let store = self.context.store;

    let bindFunctionDeclaration = decl => {
      let newName = removeScope(decl.name, self.context.useScope, self.context.phase);
      registerBindings(newName, self.context);

      return new Term('FunctionDeclaration', {
        isGenerator: decl.isGenerator,
        name: newName,
        params: decl.params,
        body: decl.body
      });
    };

    let bindVariableDeclaration = declaration => {
      let declarators = declaration.declarators.map(decl => {
        let newDecl = new Term('VariableDeclarator', {
          // first, remove the use scope from each binding
          binding: removeScope(decl.binding, self.context.useScope, self.context.phase),
          init: decl.init
        });
        // mutate the binding map
        // TODO: make this functional
        registerBindings(newDecl.binding, self.context);
        return newDecl;
      });
      return new Term('VariableDeclaration', {
        kind: declaration.kind, declarators
      });
    };

    while (!enf.done) {

      let term = _.pipe(
        _.bind(enf.enforest, enf),
        _.cond([
          [isVariableDeclarationStatement, term => {
            term = new Term('VariableDeclarationStatement', {
              declaration: bindVariableDeclaration(term.declaration)
            });

            // syntax id^{a, b} = <init>^{a, b}
            // ->
            // syntaxrec id^{a,b,c} = function() { return <<id^{a}>> }
            // syntaxrec id^{a,b} = <init>^{a,b,c}
            if (isSyntaxDeclaration(term.declaration)) {
              let scope = freshScope('nonrec');
              term.declaration.declarators.forEach(decl => {
                let name = decl.binding.name;
                let nameAdded = name.addScope(scope, self.context.bindings, ALL_PHASES);
                let nameRemoved = name.removeScope(self.context.currentScope[self.context.currentScope.length - 1], self.context.phase);
                let newBinding = gensym(name.val());
                self.context.bindings.addForward(nameAdded, nameRemoved, newBinding, self.context.phase);
                decl.init = decl.init.addScope(scope, self.context.bindings, ALL_PHASES);
              });
            }

            // for syntax declarations we need to load the compiletime value
            // into the environment
            if (isSyntaxDeclaration(term.declaration) ||
                isSyntaxrecDeclaration(term.declaration)) {
              term.declaration.declarators.forEach(decl => {
                // each compiletime value needs to be expanded with a fresh
                // environment and in the next higher phase
                let syntaxExpander = new TermExpander(_.merge(self.context, {
                  phase: self.context.phase + 1,
                  env: new Env(),
                  store: self.context.store
                }));
                let init = syntaxExpander.expand(decl.init);
                let val = evalCompiletimeValue(init.gen(), _.merge(self.context, {
                  phase: self.context.phase + 1
                }));

                self.context.env.set(decl.binding.name.resolve(self.context.phase),
                                     new CompiletimeTransform(val));
              });
            }
            return term;
          }],
          [isFunctionWithName, term => {
            term.name = removeScope(term.name, self.context.useScope, self.context.phase);
            registerBindings(term.name, self.context);
            return term;
          }],
          [isImport, term => {
            let path = term.moduleSpecifier.val();
            let mod = self.context.modules.loadAndCompile(path);
            store = self.context.modules.visit(mod, phase, store);
            if (term.forSyntax) {
              store = self.context.modules.invoke(mod, phase + 1, store);
            }
            let boundNames = bindImports(term, mod, self.context);
            return removeNames(term, boundNames);
          }],
          [isPragma, term => {
            let pathStx = term.items.get(0);
            if (pathStx.val() === 'base') {
              return term;
            }
            let mod = self.context.modules.loadAndCompile(pathStx.val());
            store = self.context.modules.visit(mod, phase, store);
            bindAllSyntaxExports(mod, pathStx, self.context);
            return term;
          }],
          [_.T, term => term]
        ])
      )();

      result = result.concat(term);
    }
    return result;
  }
}
