import * as _ from 'ramda';
import TermExpander from './term-expander';
import { List } from 'immutable';
import ParseReducer from './parse-reducer.js';
import reducer, { MonoidalReducer } from "shift-reducer";
import { makeDeserializer } from './serializer';
import Syntax from "./syntax";
import codegen, { FormattedCodeGen } from 'shift-codegen';
import { VarBindingTransform, CompiletimeTransform } from './transforms';
import Term, {
  isEOF, isBindingIdentifier, isFunctionDeclaration, isFunctionExpression,
  isFunctionTerm, isFunctionWithName, isSyntaxDeclaration, isVariableDeclaration,
  isVariableDeclarationStatement, isImport, isExport
} from "./terms";
import Reader from './shift-reader';

import { unwrap } from './macro-context';

import { replaceTemplate } from './template-processor';

import vm from "vm";

// indirect eval so in the global scope
let geval = eval;

export function sanitizeReplacementValues(values) {
  if (Array.isArray(values)) {
    return sanitizeReplacementValues(List(values));
  } else if (List.isList(values)) {
    return values.map(sanitizeReplacementValues);
  } else if (values == null) {
    throw new Error("replacement values for syntax template must not be null or undefined");
  } else if (typeof values.next === 'function') {
    return sanitizeReplacementValues(List(values));
  }
  return unwrap(values);
}

export function evalRuntimeValues(terms, context) {
  let parsed = reducer(new ParseReducer(context), new Term('Module', {
    directives: List(),
    items: terms
  }));

  let gen = codegen(parsed, new FormattedCodeGen);
  let result = context.transform(gen, {
    babelrc: true,
    filename: context.filename
  });

  let exportsObj = {};
  context.store.set('exports', exportsObj);

  let val = vm.runInContext(result.code, context.store.getNodeContext());
  return exportsObj;
}

// (Expression, Context) -> [function]
export function evalCompiletimeValue(expr, context) {
  let deserializer = makeDeserializer(context.bindings);
  let sandbox = {
    syntaxQuote: function (strings, ...values) {
      let ctx = deserializer.read(_.last(values));
      let reader = new Reader(strings, ctx, _.take(values.length - 1, values));
      return reader.read();
    },
    syntaxTemplate: function(str, ...values) {
      return replaceTemplate(deserializer.read(str), sanitizeReplacementValues(values));
    }
  };

  let sandboxKeys = List(Object.keys(sandbox));
  let sandboxVals = sandboxKeys.map(k => sandbox[k]).toArray();

  let parsed = reducer(new ParseReducer(context), new Term("Module", {
    directives: List(),
    items: List.of(new Term("ExpressionStatement", {
      expression: new Term("FunctionExpression", {
        isGenerator: false,
        name: null,
        params: new Term("FormalParameters", {
          items: sandboxKeys.map(param => {
            return new Term("BindingIdentifier", {
              name: Syntax.fromIdentifier(param)
            });
          }),
          rest: null
        }),
        body: new Term("FunctionBody", {
          directives: List.of(new Term('Directive', {
            rawValue: 'use strict'
          })),
          statements: List.of(new Term("ReturnStatement", {
            expression: expr
          }))
        })
      })
    }))
  }));

  let gen = codegen(parsed, new FormattedCodeGen);
  let result = context.transform(gen, {
    babelrc: true,
    filename: context.filename
  });

  let val = vm.runInContext(result.code, context.store.getNodeContext());
  return val.apply(undefined, sandboxVals);
}
