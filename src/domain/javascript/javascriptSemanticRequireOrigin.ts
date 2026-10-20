import * as t from "@babel/types";
import { isBuiltin } from "node:module";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";

import { BUILTIN_RESOURCE_METHODS } from "./javascriptBuiltinResourceMethods.js";
import type { JavaScriptModuleOrigin } from "./javascriptSemanticIr.js";
import {
  resolveSemanticBindingState,
  isUnmodifiedCommonJsWrapperBinding,
  isUnshadowedGlobal,
  commonJsWrapperBindingDeclaration,
  semanticResolutionBlocked,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
  type JavaScriptSemanticMemberEffect,
} from "./javascriptSemanticState.js";
import {
  isPrimitiveJavaScriptExpression,
  javaScriptExpressionValue,
  readExactJavaScriptLiteral,
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  semanticPropertyPathKeyMatches,
  SemanticPropertyPathCoverage,
  type JavaScriptSemanticPropertyPath,
} from "./javascriptSemanticPropertyPaths.js";
import { semanticObjectPropertyReferences } from "./javascriptSemanticObjectReferences.js";
import { createSemanticReturnedReferences } from "./javascriptSemanticReturnedReferences.js";
import {
  resolveLocalCallables,
  type LocalCallableResolution,
} from "./javascriptSemanticCallResolution.js";
import { createSemanticAmbientEffectQuery } from "./javascriptSemanticEffectQueries.js";
import { stringValue } from "./javascriptStaticAnalysisHelpers.js";
import {
  semanticBindingAtRead,
  semanticEffectTiming,
  semanticTopLevelEffectFollowsCapture,
} from "./javascriptSemanticMutationInitializers.js";
import { createSemanticModuleInterop } from "./javascriptModuleInterop.js";
import { electronMemberPath } from "./javascriptElectronMemberWrites.js";
import { semanticBranchMayBeSkipped } from "./javascriptSemanticEvaluationOrder.js";

export interface JavaScriptRequireOrigin {
  readonly origin: JavaScriptModuleOrigin;
  readonly call: t.CallExpression;
}

export type JavaScriptRequireLoaderFact =
  | "commonjs-loader"
  | "factory-loader"
  | "create-require"
  | "local"
  | "unknown";

/** Classify a bare `require(...)` using the shared lexical binding owner. */
export const semanticRequireLoaderAt = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  state: JavaScriptSemanticAnalysisState,
  factoryBindingIds: ReadonlySet<string>,
): JavaScriptRequireLoaderFact => {
  const callee = unwrapJavaScriptExpression(node.callee).node;
  const loader = t.isIdentifier(callee, { name: "require" })
    ? callee
    : (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
        ["resolve", "main"].includes(
          semanticStaticPropertyKey(callee.property, callee.computed) ?? "",
        ) &&
        t.isIdentifier(callee.object, { name: "require" })
      ? callee.object
      : undefined;
  if (loader === undefined) return "local";
  const binding = resolveSemanticBindingState(state, loader, "require");
  if (binding === undefined) {
    if (semanticResolutionBlocked(state, loader, "require")) return "unknown";
    return (state.ambientBindingWrites.get("require") ?? []).some(
      (write) => semanticEffectTiming(node, write, state) !== "after",
    )
      ? "unknown"
      : "commonjs-loader";
  }
  if (factoryBindingIds.has(binding.bindingId))
    return binding.initializers.length === 0 ? "factory-loader" : "unknown";
  if (
    binding.hostOrigin === "commonjs-wrapper" &&
    [...binding.declarationKinds].every((kind) => kind === "var")
  ) {
    if (binding.definitions.some(({ kind }) => kind === "function"))
      return "local";
    return commonJsWrapperBindingHasPriorWrite(node, binding, state)
      ? "unknown"
      : "commonjs-loader";
  }
  if (isWrapperRequireInitializerCall(binding, node, state))
    return "commonjs-loader";
  const wrapperBinding = commonJsWrapperBindingDeclaration(
    loader,
    "require",
    state,
  );
  if (
    wrapperBinding !== undefined &&
    !commonJsWrapperBindingHasPriorWrite(node, wrapperBinding, state)
  )
    return "commonjs-loader";
  if (isSemanticCreateRequireBinding(binding, state)) return "create-require";
  const initializer = semanticStableInitializer(binding, state)?.node;
  if (
    (binding.kind === "function" || binding.kind === "class") &&
    initializer !== undefined
  )
    return "local";
  if (
    binding.declarationKinds.size === 1 &&
    binding.declarationKinds.has("const") &&
    (t.isFunctionExpression(initializer) ||
      t.isArrowFunctionExpression(initializer))
  )
    return "local";
  return "unknown";
};

const commonJsWrapperBindingHasPriorWrite = (
  site: t.Node,
  binding: NonNullable<ReturnType<typeof resolveSemanticBindingState>>,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const writes = state.bindingWrites.get(binding.bindingId) ?? [];
  const declarationInitializers = binding.initializers
    .map(({ node }) => node)
    .filter(
      (initializer) =>
        !writes.some((write) => semanticNodeWithin(initializer, write, state)),
    );
  return (
    writes.some(
      (write) => semanticEffectTiming(site, write, state) !== "after",
    ) ||
    declarationInitializers.some(
      (initializer) =>
        semanticEffectTiming(site, initializer, state) !== "after",
    )
  );
};

const semanticNodeWithin = (
  node: t.Node,
  ancestor: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  let current: t.Node | undefined = node;
  while (current !== undefined) {
    if (current === ancestor) return true;
    current = state.parentsByNode.get(current);
  }
  return false;
};

/** Classify a call through an exact recovered factory-loader binding. */
export const semanticFactoryRequireLoaderAt = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  state: JavaScriptSemanticAnalysisState,
  bindingIds: ReadonlySet<string>,
): JavaScriptRequireLoaderFact | undefined => {
  const callee = unwrapJavaScriptExpression(node.callee).node;
  if (t.isIdentifier(callee))
    return semanticFactoryLoaderMemberAt(node, state, bindingIds, null);
  if (
    (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
    semanticStaticPropertyKey(callee.property, callee.computed) === "bind"
  )
    return semanticFactoryLoaderMemberAt(node, state, bindingIds, "bind");
  return undefined;
};

/** Classify an exact loader call by binding identity and expected member. */
export const semanticFactoryLoaderMemberAt = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  state: JavaScriptSemanticAnalysisState,
  bindingIds: ReadonlySet<string>,
  member: string | null,
): JavaScriptRequireLoaderFact | undefined => {
  const callee = unwrapJavaScriptExpression(node.callee).node;
  let loader: t.Identifier | undefined;
  if (member === null) {
    if (t.isIdentifier(callee)) loader = callee;
  } else if (
    (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
    semanticStaticPropertyKey(callee.property, callee.computed) === member
  ) {
    const root = unwrapJavaScriptExpression(callee.object).node;
    if (t.isIdentifier(root)) loader = root;
  }
  if (loader === undefined) return undefined;
  const binding = resolveSemanticBindingState(state, loader, loader.name);
  if (binding === undefined || !bindingIds.has(binding.bindingId))
    return undefined;
  return binding.initializers.length === 0 ? "factory-loader" : "unknown";
};

const isSemanticCreateRequireBinding = (
  binding: NonNullable<ReturnType<typeof resolveSemanticBindingState>>,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (binding.initializers.length !== 1) return false;
  const initializer = semanticStableInitializer(binding, state)?.node;
  if (!t.isCallExpression(initializer)) return false;
  const callee = unwrapJavaScriptExpression(initializer.callee).node;
  if (t.isIdentifier(callee)) {
    const origins = resolveSemanticBindingState(
      state,
      callee,
      callee.name,
    )?.directOrigins;
    if (origins?.length !== 1) return false;
    const [origin] = origins;
    return (
      origin?.importedPath.at(-1) === "createRequire" &&
      ["module", "node:module"].includes(origin.specifier)
    );
  }
  const chain = semanticMemberChain(callee);
  if (chain === undefined || chain.members.at(-1) !== "createRequire")
    return false;
  if (!t.isNode(chain.root)) return false;
  const root = unwrapJavaScriptExpression(chain.root).node;
  if (!t.isIdentifier(root)) return false;
  const origins = resolveSemanticBindingState(
    state,
    root,
    root.name,
  )?.directOrigins;
  if (origins?.length !== 1) return false;
  const [origin] = origins;
  return (
    origin?.importedPath.length === 0 &&
    ["module", "node:module"].includes(origin.specifier)
  );
};

/** The RHS call runs before its assignment replaces Node's wrapper loader. */
const isWrapperRequireInitializerCall = (
  binding: NonNullable<ReturnType<typeof resolveSemanticBindingState>>,
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const scope = state.scopesById.get(binding.scopeId);
  if (
    scope?.kind !== "program" ||
    binding.kind !== "variable" ||
    binding.declarationKinds.size !== 1 ||
    !binding.declarationKinds.has("var") ||
    binding.initializers.length !== 1 ||
    binding.initializers[0]?.node !== node
  )
    return false;
  const assignment = state.parentsByNode.get(node);
  if (
    !t.isAssignmentExpression(assignment) ||
    assignment.right !== node ||
    state.conditionallySkippedExpressions.has(node)
  )
    return false;
  const statement = state.parentsByNode.get(assignment);
  if (!t.isExpressionStatement(statement)) return false;
  if (state.parentsByNode.get(statement) !== state.program) return false;
  const target = unwrapJavaScriptExpression(assignment.left).node;
  return (
    t.isIdentifier(target, { name: "require" }) &&
    resolveSemanticBindingState(state, target, target.name) === binding
  );
};

// Ambient indexing finishes before these derived facts are consumed. Keep only
// replacement sites, rather than rescanning unrelated global member writes.
const globalProcessReplacements = new WeakMap<
  JavaScriptSemanticAnalysisState,
  readonly (t.Node | undefined)[]
>();
const moduleRequireWrites = new WeakMap<
  JavaScriptSemanticAnalysisState,
  readonly t.Node[]
>();

/** Member collection can discover stored module exposure after an earlier query. */
export const clearSemanticRequireWriteCache = (
  state: JavaScriptSemanticAnalysisState,
): void => {
  moduleRequireWrites.delete(state);
};

/** Resolve the CommonJS wrapper module identity through ordered aliases. */
export const semanticCommonJsModuleObjectAt = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  visited = new Set<string>(),
): boolean => {
  const value = unwrapJavaScriptExpression(node).node;
  if (!t.isIdentifier(value)) return false;
  if (value.name === "module")
    return resolveSemanticBindingState(state, value, "module") === undefined
      ? !semanticResolutionBlocked(state, value, "module")
      : isUnmodifiedCommonJsWrapperBinding(value, "module", state);
  const binding = resolveSemanticBindingState(state, value, value.name);
  if (binding === undefined || visited.has(binding.bindingId)) return false;
  const next = new Set(visited).add(binding.bindingId);
  const { initializers } = semanticBindingAtRead(
    binding,
    value,
    state.parentsByNode,
  ).binding;
  return (
    initializers.length > 0 &&
    initializers.every(
      ({ node: init, projection }) =>
        projection.length === 0 &&
        semanticCommonJsModuleObjectAt(init, state, next),
    )
  );
};

const writesModuleRequire = (
  state: JavaScriptSemanticAnalysisState,
): readonly t.Node[] => {
  const cached = moduleRequireWrites.get(state);
  if (cached !== undefined) return cached;
  // Interop invocation resolution may ask for require provenance while this
  // index is being built. Publish a temporary empty result to break that cycle.
  moduleRequireWrites.set(state, []);
  const writes: t.Node[] = [];
  const interop = createSemanticModuleInterop(state);
  const isSeparateReceiver = (
    node: t.Node,
    visited = new Set<string>(),
  ): boolean => {
    const expression = unwrapJavaScriptExpression(node).node;
    if (
      t.isSequenceExpression(expression) &&
      expression.expressions
        .slice(0, -1)
        .some((prefix) => exposesModule([prefix], prefix))
    )
      return false;
    const value = javaScriptExpressionValue(node);
    if (
      interop.isFreshObject(value) ||
      isPrimitiveJavaScriptExpression(expression) ||
      (t.isUnaryExpression(value) && !exposesModule([value.argument], value)) ||
      isUnshadowedGlobal(value, state, "undefined")
    )
      return true;
    const separateNamespace = (origin: JavaScriptModuleOrigin): boolean =>
      isBuiltin(origin.specifier) &&
      (origin.importedPath.length === 0 ||
        (origin.resolutionMode !== "require" &&
          origin.importedPath.length === 1 &&
          origin.importedPath[0] === "default"));
    const required = semanticRequireOrigin(value, state);
    if (required !== undefined && separateNamespace(required.origin))
      return true;
    if (!t.isIdentifier(value)) return false;
    const binding = resolveSemanticBindingState(state, value, value.name);
    if (binding === undefined || visited.has(binding.bindingId)) return false;
    const snapshot = semanticBindingAtRead(binding, value, state.parentsByNode);
    if (snapshot.status !== "ordered") return false;
    const { initializers, referenceInitializers, directOrigins } =
      snapshot.binding;
    if (referenceInitializers.length !== 0) return false;
    if (initializers.length === 0)
      return directOrigins.length > 0 && directOrigins.every(separateNamespace);
    const next = new Set(visited).add(binding.bindingId);
    return initializers.every(
      ({ node: source, projection }) =>
        projection.length === 0 && isSeparateReceiver(source, next),
    );
  };
  // Unknown keys, spread sources and accessors may all replace the delegate.
  const mayContainRequire = (source: t.Node | undefined): boolean =>
    !t.isObjectExpression(source) ||
    source.properties.some((property) => {
      if (t.isSpreadElement(property)) return true;
      const key = semanticStaticPropertyKey(property.key, property.computed);
      return key === null || key === "require";
    });
  // This index is built over a completed binding/ambient-write snapshot. Cache
  // only fully explored module-free node/projection pairs; a partial walk that
  // found exposure cannot establish anything about its other visited nodes.
  const moduleFree = new WeakMap<t.Node, SemanticPropertyPathCoverage>();
  const plainObject = (
    source: t.Node | undefined,
    seen = new Set<string>(),
  ): t.ObjectExpression | undefined => {
    if (source === undefined) return undefined;
    const value = unwrapJavaScriptExpression(source).node;
    if (t.isObjectExpression(value))
      return value.properties.every(t.isObjectProperty) ? value : undefined;
    if (!t.isIdentifier(value)) return undefined;
    const binding = resolveSemanticBindingState(state, value, value.name);
    if (
      binding === undefined ||
      seen.has(binding.bindingId) ||
      binding.memberWrites.length > 0 ||
      binding.escapedPaths.length > 0
    )
      return undefined;
    const initializer = semanticStableInitializer(binding, state);
    return initializer?.projection.length === 0
      ? plainObject(initializer.node, new Set(seen).add(binding.bindingId))
      : undefined;
  };
  // Member effects already own aliases, selected paths and ordering. Follow
  // their assigned values instead of treating every write as the wrapper.
  // Accessors and unproven descriptor/source maps remain conservative.
  const ambientEffectAt = createSemanticAmbientEffectQuery(state);
  const returnedReferences = createSemanticReturnedReferences(state);
  const callableById = new Map(
    state.callables.map((callable) => [callable.callableId, callable]),
  );
  const callableCache = new WeakMap<t.Identifier, LocalCallableResolution>();
  const inheritedDescriptorFieldChanged = (
    field: string,
    at: t.Node,
    consumedAt: t.Node,
  ): boolean => {
    // A deferred descriptor may run before this consumer, but a prototype write
    // ordered after the consumer cannot supply that earlier descriptor value.
    return ambientEffectAt(
      ["global", "Object", "prototype", field],
      at,
      consumedAt,
    );
  };
  const writtenValues = (
    mutation: t.Node | undefined,
    key: string,
    consumedAt = mutation,
  ):
    | readonly { node: t.Node; path: JavaScriptSemanticPropertyPath }[]
    | undefined => {
    if (t.isAssignmentExpression(mutation))
      return ["=", "||=", "&&=", "??="].includes(mutation.operator)
        ? [{ node: mutation.right, path: [] }]
        : undefined;
    if (!t.isCallExpression(mutation) && !t.isOptionalCallExpression(mutation))
      return undefined;
    const invocation = interop.intrinsicInvocation(mutation);
    const args = invocation?.arguments;
    if (
      invocation?.kind !== "known" ||
      args === undefined ||
      args.some(t.isSpreadElement)
    )
      return undefined;
    const operation = invocation.path.join(".");
    if (operation === "intrinsic.Reflect.set" && args[2] !== undefined)
      return [{ node: args[2], path: [] }];
    if (operation === "intrinsic.Object.assign")
      return args.slice(1).every((source) => plainObject(source) !== undefined)
        ? args.slice(1).map((node) => ({ node, path: [key] }))
        : undefined;
    let descriptor: t.Node | undefined;
    if (operation === "intrinsic.Object.defineProperties") {
      const properties = plainObject(args[1]);
      if (
        properties?.properties.some(
          (property) =>
            !t.isObjectProperty(property) ||
            semanticStaticPropertyKey(property.key, property.computed) === null,
        )
      )
        return undefined;
      const selected = properties?.properties.findLast(
        (property) =>
          t.isObjectProperty(property) &&
          semanticStaticPropertyKey(property.key, property.computed) === key,
      );
      if (t.isObjectProperty(selected)) descriptor = selected.value;
    } else if (
      [
        "intrinsic.Object.defineProperty",
        "intrinsic.Reflect.defineProperty",
      ].includes(operation)
    )
      descriptor = args[2];
    const data = plainObject(descriptor);
    if (
      data === undefined ||
      !data.properties.every(
        (property) =>
          t.isObjectProperty(property) &&
          ["value", "writable", "enumerable", "configurable"].includes(
            semanticStaticPropertyKey(property.key, property.computed) ?? "",
          ),
      )
    )
      return undefined;
    // ToPropertyDescriptor also reads inherited fields. An omitted value is
    // only module-free while its prototype lookup remains unmodified; own
    // fields shadow that lookup, and plainObject already excludes accessors.
    for (const field of [
      "value",
      "writable",
      "enumerable",
      "configurable",
      "get",
      "set",
    ])
      if (
        !data.properties.some(
          (property) =>
            t.isObjectProperty(property) &&
            semanticStaticPropertyKey(property.key, property.computed) ===
              field,
        ) &&
        inheritedDescriptorFieldChanged(field, mutation, consumedAt ?? mutation)
      )
        return undefined;
    return [{ node: data, path: ["value"] }];
  };
  // Resolve only ordered, exact literal allocations. Unknown aliases, getters,
  // conditional replacements and computed slots cannot prove distinct owners.
  const nativeDataDefinition = (node: t.Node | undefined): boolean => {
    if (!t.isCallExpression(node)) return false;
    const invocation = interop.intrinsicInvocation(node);
    if (
      invocation?.kind !== "known" ||
      ![
        "intrinsic.Object.defineProperty",
        "intrinsic.Reflect.defineProperty",
      ].includes(invocation.path.join("."))
    )
      return false;
    const descriptor = plainObject(invocation.arguments?.[2]);
    return (
      descriptor !== undefined &&
      descriptor.properties.some(
        (property) =>
          t.isObjectProperty(property) &&
          semanticStaticPropertyKey(property.key, property.computed) ===
            "value",
      ) &&
      descriptor.properties.every((property) => {
        if (!t.isObjectProperty(property)) return false;
        const key = semanticStaticPropertyKey(property.key, property.computed);
        return (
          key !== null &&
          key !== "get" &&
          key !== "set" &&
          (key !== "writable" ||
            t.isBooleanLiteral(property.value, { value: true }))
        );
      })
    );
  };
  const nativeReplacements = new WeakMap<t.Node, boolean>();
  const nativeReplacement = (node: t.Node | undefined): boolean => {
    if (!t.isCallExpression(node)) return false;
    const cached = nativeReplacements.get(node);
    if (cached !== undefined) return cached;
    nativeReplacements.set(node, false);
    const invocation = interop.intrinsicInvocation(node);
    const args = invocation?.arguments;
    if (
      invocation?.kind !== "known" ||
      args === undefined ||
      args.length < 3 ||
      args.some(t.isSpreadElement)
    )
      return false;
    let ancestor: t.Node | undefined = args[0];
    while (ancestor !== undefined && ancestor !== node)
      ancestor = state.parentsByNode.get(ancestor);
    if (ancestor === undefined) {
      // Normalized bound inputs retain their capture location. Compare the
      // complete target allocation, including member projections, rather than
      // only its root binding: holder.inner may change while holder does not.
      const captured = literalAllocation(args[0]!, [], args[0]!);
      if (
        captured === undefined ||
        captured !== literalAllocation(args[0]!, [], node)
      )
        return false;
    }
    const operation = invocation.path.join(".");
    if (operation === "intrinsic.Object.defineProperty") {
      const definite = nativeDataDefinition(node);
      nativeReplacements.set(node, definite);
      return definite;
    }
    if (
      operation !== "intrinsic.Reflect.set" &&
      (operation !== "intrinsic.Reflect.defineProperty" ||
        !nativeDataDefinition(node))
    )
      return false;
    const key = interop.staticPropertyKey(args[1]);
    if (key === undefined || key === "__proto__") return false;
    const target = literalAllocation(args[0]!, [], node);
    // A literal's own data slot starts writable. The allocation proof checks
    // prior escapes and every intervening write, rejecting descriptor changes
    // that could remove writability. Reflect can then complete this replacement.
    const ownData =
      t.isObjectExpression(target) &&
      target.properties.some(
        (property) =>
          t.isObjectProperty(property) &&
          semanticStaticPropertyKey(property.key, property.computed) === key,
      ) &&
      literalAllocation(args[0]!, [key], node) !== undefined;
    const sameReceiver =
      operation !== "intrinsic.Reflect.set" ||
      args[3] === undefined ||
      // Normalized arguments keep their original evaluation sites, including
      // bound receivers captured before a later member/root reassignment.
      literalAllocation(args[3], [], args[3]) === target;
    let compatible = true;
    if (operation === "intrinsic.Reflect.defineProperty") {
      const descriptor = plainObject(args[2]);
      // A writable data slot permits a value change and tightening configurable.
      // Relaxing configurable or specifying enumerable needs the original,
      // untouched literal descriptor (writable/enumerable/configurable=true).
      // Allocation identity alone cannot prove those flags after a definition.
      const untouched = () =>
        literalAllocation(args[0]!, [key], node, true) !== undefined;
      compatible =
        descriptor !== undefined &&
        descriptor.properties.every((property) => {
          if (!t.isObjectProperty(property)) return false;
          const field = semanticStaticPropertyKey(
            property.key,
            property.computed,
          );
          if (field !== "configurable" && field !== "enumerable") return true;
          if (!t.isBooleanLiteral(property.value)) return false;
          return (
            (field === "configurable" && !property.value.value) || untouched()
          );
        });
    }
    const definite = ownData && sameReceiver && compatible;
    nativeReplacements.set(node, definite);
    return definite;
  };
  const definiteReplacements = new WeakMap<t.Node, boolean>();
  const isDefiniteReplacement = (node: t.Node | undefined): boolean => {
    if (node === undefined) return false;
    const cached = definiteReplacements.get(node);
    if (cached !== undefined) return cached;
    // The member-effect index records possible writes, including a native
    // mutator's target when a different receiver is written, and descriptor
    // changes that can make a subsequent ordinary assignment fail. Such calls
    // cannot establish a completed replacement of the indexed slot.
    let definite =
      t.isAssignmentExpression(node, { operator: "=" }) ||
      nativeReplacement(node);
    let child = node;
    for (
      let parent = state.parentsByNode.get(child);
      definite && parent !== undefined && !t.isFunction(parent);
      parent = state.parentsByNode.get(child)
    ) {
      // A break or continue can bypass a replacement while the later read runs.
      // Use the same unconditional-body restriction as initializer projection.
      if (
        t.isLabeledStatement(parent) ||
        t.isLoop(parent) ||
        semanticBranchMayBeSkipped(parent, child)
      )
        definite = false;
      child = parent;
    }
    definiteReplacements.set(node, definite);
    return definite;
  };
  const allocationWriteIndices = new WeakMap<
    JavaScriptSemanticBindingState,
    {
      exact: Map<string, JavaScriptSemanticMemberEffect[]>;
      unknown: JavaScriptSemanticMemberEffect[];
    }
  >();
  const definitelyWritesPath = (
    effect: JavaScriptSemanticMemberEffect,
    owner: JavaScriptSemanticBindingState,
  ): boolean => {
    const mutation = effect.node;
    let source: t.Node | undefined;
    let path: readonly (string | number | null)[] = [];
    if (t.isAssignmentExpression(mutation)) source = mutation.left;
    else if (t.isCallExpression(mutation)) {
      const invocation = interop.intrinsicInvocation(mutation);
      source = invocation?.arguments?.[0];
      path = [interop.staticPropertyKey(invocation?.arguments?.[1]) ?? null];
    }
    const visited = new Set<string>();
    while (source !== undefined) {
      const { root, members } = electronMemberPath(
        javaScriptExpressionValue(source),
      );
      path = [...members, ...path];
      if (!t.isIdentifier(root) || path.includes(null)) return false;
      const binding = resolveSemanticBindingState(state, root, root.name);
      if (binding === owner)
        return (
          (visited.size === 0 ||
            semanticStableInitializer(owner, state) !== undefined) &&
          path.length === effect.path.length &&
          path.every((key, index) => key === effect.path[index])
        );
      if (binding === undefined || visited.has(binding.bindingId)) return false;
      visited.add(binding.bindingId);
      const read = semanticBindingAtRead(binding, root, state.parentsByNode);
      if (
        read.status !== "ordered" ||
        !read.hasDefiniteInitializer ||
        read.binding.initializers.length !== 1 ||
        read.binding.referenceInitializers.length !== 0
      )
        return false;
      const initializer = read.binding.initializers[0]!;
      source = initializer.node;
      path = [...initializer.projection, ...path];
    }
    return false;
  };
  const allocationWritesAtPath = (
    binding: JavaScriptSemanticBindingState,
    path: JavaScriptSemanticPropertyPath,
  ): readonly JavaScriptSemanticMemberEffect[] => {
    let index = allocationWriteIndices.get(binding);
    if (index === undefined) {
      index = { exact: new Map(), unknown: [] };
      for (const effect of binding.memberWrites) {
        if (effect.path.some((key) => key === null || typeof key === "object"))
          index.unknown.push(effect);
        else {
          const key = JSON.stringify(effect.path.map(String));
          const values = index.exact.get(key) ?? [];
          values.push(effect);
          index.exact.set(key, values);
        }
      }
      allocationWriteIndices.set(binding, index);
    }
    const effects = [...index.unknown];
    for (let length = 0; length <= path.length; length++)
      effects.push(
        ...(index.exact.get(
          JSON.stringify(path.slice(0, length).map(String)),
        ) ?? []),
      );
    return effects;
  };
  const literalAllocation = (
    source: t.Node,
    path: JavaScriptSemanticPropertyPath,
    at: t.Node,
    untouched = false,
  ): t.Node | undefined => {
    const seen = new Set<t.Node>();
    while (true) {
      const value = javaScriptExpressionValue(source);
      if (
        seen.has(value) ||
        path.some((key) => key === null || typeof key === "object")
      )
        return undefined;
      seen.add(value);
      if (t.isMemberExpression(value) || t.isOptionalMemberExpression(value)) {
        const key = semanticStaticPropertyKey(value.property, value.computed);
        if (key === null) return undefined;
        source = value.object;
        path = [key, ...path];
        continue;
      }
      if (t.isIdentifier(value)) {
        const binding = resolveSemanticBindingState(state, value, value.name);
        if (binding === undefined) return undefined;
        if (
          path.length > 0 &&
          binding.escapedPaths.some(
            (effect) =>
              effect.node !== at &&
              effect.path.length < path.length &&
              effect.path.every((key, index) =>
                semanticPropertyPathKeyMatches(key, String(path[index])),
              ) &&
              semanticEffectTiming(at, effect.node, state) !== "after" &&
              !nativeReplacement(effect.node),
          )
        )
          return undefined;
        let latest: JavaScriptSemanticMemberEffect | undefined;
        if (path.length > 0)
          for (const effect of allocationWritesAtPath(binding, path)) {
            // Allocation inputs are read before this invocation performs its
            // own write. This also bounds recursive native replacement proof.
            if (effect.node === at) continue;
            if (
              effect.path.length > path.length ||
              !effect.path.every((key, index) =>
                semanticPropertyPathKeyMatches(key, String(path[index])),
              )
            )
              continue;
            const timing = semanticEffectTiming(at, effect.node, state);
            if (timing === "after") continue;
            if (untouched) return undefined;
            if (
              timing !== "before" ||
              !isDefiniteReplacement(effect.node) ||
              !definitelyWritesPath(effect, binding) ||
              effect.path.some((key) => typeof key !== "string")
            )
              return undefined;
            if (latest === undefined) latest = effect;
            else {
              const order = semanticEffectTiming(
                latest.node!,
                effect.node,
                state,
              );
              if (order === "unknown") return undefined;
              if (order === "after") latest = effect;
            }
          }
        if (latest !== undefined) {
          const references = writtenValues(
            latest.node,
            String(latest.path.at(-1)),
          );
          if (references?.length !== 1) return undefined;
          const reference = references[0]!;
          source = reference.node;
          path = [...reference.path, ...path.slice(latest.path.length)];
          at = latest.node!;
          continue;
        }
        const snapshot = semanticBindingAtRead(
          binding,
          at,
          state.parentsByNode,
        );
        if (
          snapshot.status !== "ordered" ||
          snapshot.binding.initializers.length !== 1 ||
          snapshot.binding.referenceInitializers.length !== 0
        )
          return undefined;
        const initializer = snapshot.binding.initializers[0]!;
        const initial = unwrapJavaScriptExpression(initializer.node).node;
        // A saved child followed by another selection needs separate capture and
        // use clocks; leave that unresolved instead of assigning it a new owner.
        if (
          path.length > 0 &&
          (initializer.projection.length > 0 ||
            t.isMemberExpression(initial) ||
            t.isOptionalMemberExpression(initial))
        )
          return undefined;
        source = initializer.node;
        if (path.length === 0) at = initializer.node;
        path = [...initializer.projection, ...path];
        continue;
      }
      if (t.isObjectExpression(value)) {
        if (path.length === 0) return value;
        if (
          !value.properties.every(
            (property) =>
              t.isObjectProperty(property) &&
              semanticStaticPropertyKey(property.key, property.computed) !==
                null,
          )
        )
          return undefined;
        const property = value.properties.findLast(
          (property) =>
            t.isObjectProperty(property) &&
            semanticStaticPropertyKey(property.key, property.computed) ===
              String(path[0]),
        );
        if (!t.isObjectProperty(property)) return undefined;
        source = property.value;
        path = path.slice(1);
        continue;
      }
      if (t.isArrayExpression(value) && path.length === 0) return value;
      return undefined;
    }
  };
  const writesSeparateChild = (
    source: t.Node,
    path: JavaScriptSemanticPropertyPath,
    capturedAt: t.Node,
    effect: JavaScriptSemanticMemberEffect,
  ): boolean => {
    if (
      path.length === 0 ||
      effect.path.length <= path.length ||
      effect.path.some((key) => typeof key !== "string")
    )
      return false;
    const mutation = effect.node;
    let receiver: t.Node | undefined;
    if (
      t.isAssignmentExpression(mutation) &&
      (t.isMemberExpression(mutation.left) ||
        t.isOptionalMemberExpression(mutation.left))
    )
      receiver = mutation.left.object;
    else if (
      t.isCallExpression(mutation) ||
      t.isOptionalCallExpression(mutation)
    ) {
      const invocation = interop.intrinsicInvocation(mutation);
      if (
        invocation?.kind === "known" &&
        [
          "intrinsic.Object.assign",
          "intrinsic.Object.defineProperty",
          "intrinsic.Object.defineProperties",
          "intrinsic.Reflect.defineProperty",
        ].includes(invocation.path.join("."))
      )
        receiver = invocation.arguments?.[0];
    }
    for (
      let remaining = effect.path.length - path.length - 1;
      remaining > 0 && receiver !== undefined;
      remaining--
    ) {
      const value = unwrapJavaScriptExpression(receiver).node;
      receiver =
        t.isMemberExpression(value) || t.isOptionalMemberExpression(value)
          ? value.object
          : undefined;
    }
    if (receiver === undefined) return false;
    const saved = literalAllocation(source, path, capturedAt);
    const written = literalAllocation(receiver, [], receiver);
    return saved !== undefined && written !== undefined && saved !== written;
  };
  const exposesModule = (nodes: readonly t.Node[], call: t.Node): boolean => {
    const pending: {
      node: t.Node;
      path: JavaScriptSemanticPropertyPath;
      readAt?: t.Node;
      // Discharging a recorded write requires a positive module-free proof;
      // unknown call results and closures must retain the original uncertainty.
      written?: true;
    }[] = nodes.map((node) => ({ node, path: [] }));
    const visited = new WeakMap<
      t.Node,
      Map<t.Node, SemanticPropertyPathCoverage>
    >();
    const writtenVisited = new WeakMap<
      t.Node,
      Map<t.Node, SemanticPropertyPathCoverage>
    >();
    let timeDependent = false;
    const examined: { node: t.Node; path: JavaScriptSemanticPropertyPath }[] =
      [];
    while (pending.length > 0) {
      const {
        node: source,
        path,
        readAt: capturedAt,
        written,
      } = pending.pop()!;
      const value = unwrapJavaScriptExpression(source).node;
      const readAt = capturedAt ?? value;
      const traversal = written ? writtenVisited : visited;
      const captures =
        traversal.get(value) ?? new Map<t.Node, SemanticPropertyPathCoverage>();
      const coverage =
        captures.get(readAt) ?? new SemanticPropertyPathCoverage();
      if (coverage.covers(path)) continue;
      coverage.retain(path);
      captures.set(readAt, coverage);
      traversal.set(value, captures);
      const binding = t.isIdentifier(value)
        ? resolveSemanticBindingState(state, value, value.name)
        : undefined;
      for (const effect of binding?.memberWrites ?? []) {
        if (
          !effect.path.slice(0, path.length).every((key, index) => {
            const selected = path[index];
            return (
              selected === null ||
              typeof selected === "object" ||
              semanticPropertyPathKeyMatches(key, String(selected))
            );
          })
        )
          continue;
        // A saved object's contents remain shared through this call; replacing
        // its selected parent slot is checked at the earlier capture instead.
        // Such timing-dependent proofs cannot be reused at
        // another alias use merely because they reached the same initializer.
        timeDependent = true;
        if (
          effect.node !== call &&
          effect.node !== state.parentsByNode.get(readAt) &&
          semanticEffectTiming(
            effect.path.length > path.length ? call : readAt,
            effect.node,
            state,
          ) !== "after" &&
          !writesSeparateChild(value, path, readAt, effect)
        ) {
          const key = effect.path.at(-1);
          const values =
            effect.path.every((part) => typeof part === "string") &&
            typeof key === "string"
              ? writtenValues(effect.node, key, call)
              : undefined;
          if (values === undefined) return true;
          for (const reference of values)
            pending.push({
              node: reference.node,
              path: [...reference.path, ...path.slice(effect.path.length)],
              readAt,
              written: true,
            });
        }
      }
      if (!written && moduleFree.get(value)?.covers(path)) continue;
      examined.push({ node: value, path });
      for (const reference of interop.intrinsicValueReferences(value))
        pending.push({
          node: reference.node,
          path: [...reference.path, ...path],
          readAt: reference.node,
          ...(written ? { written } : {}),
        });
      if (semanticCommonJsModuleObjectAt(value, state)) {
        if (path.length === 0) return true;
        const first = path[0];
        if (
          typeof first === "string" &&
          ["id", "filename", "loaded"].includes(first) &&
          !state.ambientWrites.covers(["commonjs-module", first])
        )
          continue;
        return true;
      }
      if (t.isIdentifier(value)) {
        if (
          written &&
          (binding === undefined || binding.initializers.length === 0) &&
          !isUnshadowedGlobal(value, state, "undefined")
        )
          return true;
        if (binding !== undefined) {
          // Initializers do not prove a subsequently changed property module-free.
          // Consume the alias-aware effect owner, preserving unrelated slots,
          // earlier saved values and the current call's own argument exposure.
          for (const initializer of semanticBindingAtRead(
            binding,
            value,
            state.parentsByNode,
          ).binding.initializers)
            pending.push({
              node: initializer.node,
              readAt:
                initializer.projection.length > 0 && path.length === 0
                  ? initializer.node
                  : readAt,
              path: [
                ...initializer.projection.map((key) =>
                  key === null ? null : String(key),
                ),
                ...path,
              ],
              ...(written ? { written } : {}),
            });
        }
      } else if (t.isSpreadElement(value))
        pending.push({
          node: value.argument,
          path,
          readAt,
          ...(written ? { written } : {}),
        });
      else if (t.isArrayExpression(value)) {
        const [key, ...remaining] = path;
        const shifted = value.elements.some(t.isSpreadElement);
        for (let index = 0; index < value.elements.length; index++) {
          const element = value.elements[index];
          if (
            element !== null &&
            element !== undefined &&
            (key === undefined ||
              shifted ||
              semanticPropertyPathKeyMatches(key, String(index)) ||
              t.isSpreadElement(element))
          )
            pending.push({
              node: element,
              path: key === undefined ? [] : remaining,
              readAt,
              ...(written ? { written } : {}),
            });
        }
      } else if (t.isObjectExpression(value)) {
        pending.push(
          ...semanticObjectPropertyReferences(value, path, state).map(
            (reference) => ({
              ...reference,
              readAt,
              ...(written ? { written } : {}),
            }),
          ),
        );
      } else if (
        t.isMemberExpression(value) ||
        t.isOptionalMemberExpression(value)
      ) {
        pending.push({
          node: value.object,
          readAt: path.length === 0 ? value : readAt,
          path: [
            semanticStaticPropertyKey(value.property, value.computed),
            ...path,
          ],
          ...(written ? { written } : {}),
        });
      } else if (
        t.isConditionalExpression(value) ||
        t.isLogicalExpression(value)
      ) {
        pending.push(
          {
            node: t.isConditionalExpression(value)
              ? value.consequent
              : value.left,
            path,
            readAt,
            ...(written ? { written } : {}),
          },
          {
            node: t.isConditionalExpression(value)
              ? value.alternate
              : value.right,
            path,
            readAt,
            ...(written ? { written } : {}),
          },
        );
      } else if (t.isSequenceExpression(value)) {
        const last = value.expressions.at(-1);
        if (last !== undefined)
          pending.push({
            node: last,
            path,
            readAt,
            ...(written ? { written } : {}),
          });
      } else if (t.isAssignmentExpression(value)) {
        if (["=", "||=", "&&=", "??="].includes(value.operator))
          pending.push({
            node: value.right,
            path,
            readAt,
            ...(written ? { written } : {}),
          });
        if (["||=", "&&=", "??="].includes(value.operator))
          pending.push({
            node: value.left,
            path,
            readAt,
            ...(written ? { written } : {}),
          });
      } else if (
        t.isCallExpression(value) ||
        t.isOptionalCallExpression(value) ||
        t.isNewExpression(value)
      ) {
        // Bound intrinsic references were expanded above at their capture sites.
        const bound = interop.boundIntrinsic(value);
        if (bound?.kind === "known") {
          pending.push(
            ...[
              ...(bound.receiver === undefined ? [] : [bound.receiver]),
              ...(bound.arguments ?? []),
            ].map((node) => ({
              node,
              path: [],
              readAt: node,
            })),
          );
          continue;
        }
        // A callable result can carry module even with no arguments. Unknown
        // or partial candidates cannot prove absence. Use the call-target
        // owner's completeness contract; returned references only expose
        // positive possibilities and intentionally do not prove method slots.
        const callable = resolveLocalCallables({
          node: value.callee,
          state,
          callableById,
          bindingCache: callableCache,
          seenInitializers: new Set(),
        });
        if (!callable.complete) return true;
        const results = returnedReferences(value.callee).references;
        if (results.length === 0) return true;
        pending.push(
          ...value.arguments.map((node) => ({ node, path: [], readAt })),
          ...results.map((reference) => ({
            node: reference.node,
            path: [...reference.projection, ...path],
            readAt,
            written: true as const,
          })),
        );
      } else if (
        t.isBinaryExpression(value) ||
        t.isUnaryExpression(value) ||
        t.isTemplateLiteral(value)
      ) {
        const operands = t.isBinaryExpression(value)
          ? [value.left, value.right]
          : t.isUnaryExpression(value)
            ? [value.argument]
            : value.expressions;
        pending.push(...operands.map((node) => ({ node, path: [], readAt })));
      } else if (
        written &&
        !readExactJavaScriptLiteral(value).found &&
        !t.isUnaryExpression(value) &&
        !t.isBinaryExpression(value) &&
        !t.isTemplateLiteral(value) &&
        !t.isUpdateExpression(value)
      )
        return true;
    }
    if (timeDependent) return false;
    for (const { node, path } of examined) {
      const coverage =
        moduleFree.get(node) ?? new SemanticPropertyPathCoverage();
      coverage.retain(path);
      moduleFree.set(node, coverage);
    }
    return false;
  };
  traverseJavaScriptAst(state.program, {
    enter: (node) => {
      const target = t.isAssignmentExpression(node)
        ? node.left
        : t.isUpdateExpression(node) ||
            t.isUnaryExpression(node, { operator: "delete" })
          ? node.argument
          : undefined;
      if (target !== undefined) {
        const members: string[] = [];
        let root: t.Node = target;
        while (
          t.isMemberExpression(root) ||
          t.isOptionalMemberExpression(root)
        ) {
          const key = semanticStaticPropertyKey(root.property, root.computed);
          if (key === null) break;
          members.unshift(key);
          root = root.object;
        }
        if (
          members.length === 1 &&
          members[0] === "require" &&
          semanticCommonJsModuleObjectAt(root, state)
        )
          writes.push(node);
        else if (
          members.length === 0 &&
          (t.isMemberExpression(target) ||
            t.isOptionalMemberExpression(target)) &&
          target.computed &&
          semanticStaticPropertyKey(target.property, true) === null &&
          semanticCommonJsModuleObjectAt(target.object, state)
        )
          // An unknown computed key may be "require"; retain uncertainty rather
          // than treating this direct delegate write as a proven unrelated slot.
          writes.push(node);
      }
      if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
        const invocation = interop.intrinsicInvocation(node);
        if (
          invocation?.kind === "opaque" &&
          ((invocation.path[1] === "Object" &&
            ["assign", "defineProperty", "defineProperties"].includes(
              invocation.path[2] ?? "",
            )) ||
            (invocation.path[1] === "Reflect" &&
              invocation.path[2] === "set")) &&
          invocation.path.at(-1) !== "bind"
        ) {
          // An overwritten callable does not retain native mutator argument
          // semantics. Preserve any module reference supplied directly,
          // through call/apply containers or a captured bound argument.
          if (exposesModule([...node.arguments, node.callee], node))
            writes.push(node);
          return;
        }
        const owner =
          invocation?.path?.length === 3 ? invocation.path[1] : undefined;
        const method = invocation?.path?.at(-1);
        const args = invocation?.arguments;
        if (
          (owner === "Object" || owner === "Reflect") &&
          method === "defineProperty" &&
          semanticCommonJsModuleObjectAt(args?.[0] ?? t.nullLiteral(), state)
        ) {
          const key = interop.staticPropertyKey(args?.[1]);
          if (key === "require" || key === undefined) writes.push(node);
        } else if (owner === "Reflect" && method === "set") {
          const key = args?.slice(0, 2).some(t.isSpreadElement)
            ? undefined
            : args !== undefined && args.length < 2
              ? "undefined"
              : interop.staticPropertyKey(args?.[1]);
          if (key !== "require" && key !== undefined) return;
          // Ordinary [[Set]] writes the receiver, which defaults to the target
          // only when omitted. An unknown receiver can still be this module.
          const receiver =
            args !== undefined && args.length >= 4 ? args[3] : args?.[0];
          if (
            receiver === undefined ||
            args?.slice(0, 4).some(t.isSpreadElement)
          ) {
            writes.push(node);
            return;
          }
          if (!isSeparateReceiver(receiver)) writes.push(node);
        } else if (
          owner === "Object" &&
          method === "defineProperties" &&
          semanticCommonJsModuleObjectAt(args?.[0] ?? t.nullLiteral(), state)
        ) {
          const descriptors = args?.[1];
          if (mayContainRequire(descriptors)) writes.push(node);
        } else if (
          owner === "Object" &&
          method === "assign" &&
          semanticCommonJsModuleObjectAt(args?.[0] ?? t.nullLiteral(), state)
        ) {
          if (args?.slice(1).some(mayContainRequire)) writes.push(node);
        }
      }
    },
  });
  moduleRequireWrites.set(state, writes);
  return writes;
};

/** Whether the original global process object can still own effects at this source site. */
export const semanticOriginalGlobalProcessAt = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  let replacements = globalProcessReplacements.get(state);
  if (replacements === undefined) {
    replacements = [
      ...state.ambientWriteEffects
        .filter(
          ({ path }) =>
            path.length <= 2 &&
            path.every((key, index) =>
              semanticPropertyPathKeyMatches(
                key,
                ["global", "process"][index]!,
              ),
            ),
        )
        .map(({ node: write }) => write),
      ...(state.ambientBindingWrites.get("process") ?? []),
    ];
    globalProcessReplacements.set(state, replacements);
  }
  return !replacements.some(
    (write) =>
      !semanticTopLevelEffectFollowsCapture(node, write, state.parentsByNode),
  );
};

/** Node's unbound process reference shares the cached process exports object. */
export const semanticGlobalProcessOrigin = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptModuleOrigin | undefined =>
  t.isIdentifier(node, { name: "process" }) &&
  resolveSemanticBindingState(state, node, "process") === undefined &&
  !semanticResolutionBlocked(state, node, "process") &&
  semanticOriginalGlobalProcessAt(node, state)
    ? { specifier: "node:process", importedPath: [], resolutionMode: "require" }
    : undefined;

/** Resolve qualified global-object process references, preserving their selected path. */
export const semanticGlobalProcessPathOrigin = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptModuleOrigin | undefined => {
  const members: string[] = [];
  let current = unwrapJavaScriptExpression(node).node;
  while (
    t.isMemberExpression(current) ||
    t.isOptionalMemberExpression(current)
  ) {
    const key = semanticStaticPropertyKey(current.property, current.computed);
    if (key === null) return undefined;
    members.unshift(key);
    current = unwrapJavaScriptExpression(current.object).node;
  }
  if (
    !t.isIdentifier(current) ||
    !["globalThis", "global", "window", "self"].includes(current.name) ||
    resolveSemanticBindingState(state, current, current.name) !== undefined ||
    semanticResolutionBlocked(state, current, current.name) ||
    members[0] !== "process" ||
    !semanticOriginalGlobalProcessAt(node, state)
  )
    return undefined;
  return {
    specifier: "node:process",
    importedPath: members.slice(1),
    resolutionMode: "require",
  };
};

/** Strip a static member chain, returning its root expression and member path. */
export const semanticMemberChain = (
  node: t.Node | null | undefined,
):
  | { readonly root: t.Node | null | undefined; readonly members: string[] }
  | undefined => {
  const members: string[] = [];
  let current = node;
  while (current !== null && current !== undefined) {
    current = unwrapJavaScriptExpression(current).node;
    if (
      !t.isMemberExpression(current) &&
      !t.isOptionalMemberExpression(current)
    )
      break;
    const member = semanticStaticPropertyKey(
      current.property,
      current.computed,
    );
    if (member === null || !t.isNode(current.object)) return undefined;
    members.push(member);
    current = current.object;
  }
  return { root: current, members: members.reverse() };
};

/** Recover an unshadowed literal require origin and its exact member path. */
export const semanticRequireOrigin = (
  node: t.Node | null | undefined,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptRequireOrigin | undefined => {
  const chain = semanticMemberChain(node);
  const current = chain?.root;
  if (
    chain === undefined ||
    !t.isCallExpression(current) ||
    !t.isIdentifier(current.callee, { name: "require" })
  )
    return undefined;
  if (
    writesModuleRequire(state).some(
      (write) =>
        !semanticTopLevelEffectFollowsCapture(
          current,
          write,
          state.parentsByNode,
        ),
    )
  )
    return undefined;
  const requireBinding = resolveSemanticBindingState(
    state,
    current.callee,
    "require",
  );
  if (
    (requireBinding !== undefined &&
      !isUnmodifiedCommonJsWrapperBinding(current.callee, "require", state) &&
      !isWrapperRequireInitializerCall(requireBinding, current, state)) ||
    (requireBinding === undefined &&
      semanticResolutionBlocked(state, current.callee, "require")) ||
    (state.ambientBindingWrites.get("require") ?? []).some(
      (write) =>
        !semanticTopLevelEffectFollowsCapture(
          current,
          write,
          state.parentsByNode,
        ),
    )
  )
    return undefined;
  const specifier = stringValue(current.arguments[0]);
  return specifier === undefined
    ? undefined
    : {
        origin: {
          specifier,
          importedPath: chain.members,
          resolutionMode: "require",
        },
        call: current,
      };
};

/** Node's fs.promises export and fs/promises require share one object. */
export const semanticRequireExportsIdentity = <Key>(
  specifier: string,
  path: readonly Key[],
): { readonly specifier: string; readonly path: readonly (Key | string)[] } => {
  const name = specifier.replace(/^node:/u, "");
  if (name === "fs/promises") return { specifier: name, path };
  return name === "fs" && path[0] === "promises" && path.length > 1
    ? { specifier: "fs/promises", path: path.slice(1) }
    : { specifier: name, path };
};

const MUTABLE_BUILTIN_DEFAULTS = new Set([
  ...Object.keys(BUILTIN_RESOURCE_METHODS),
  "http",
  "https",
  "child_process",
  "timers",
  "process",
]);

/** Known Node namespaces have native descriptors; external exports do not. */
export const semanticBuiltinNamespace = (
  origin: JavaScriptModuleOrigin,
): boolean => {
  const path =
    origin.resolutionMode !== "require" && origin.importedPath[0] === "default"
      ? origin.importedPath.slice(1)
      : origin.importedPath;
  const shared = semanticRequireExportsIdentity(origin.specifier, path);
  return (
    shared.path.length === 0 && MUTABLE_BUILTIN_DEFAULTS.has(shared.specifier)
  );
};

/** Mutable default/object selections share CommonJS identity; namespace slots do not. */
export const semanticMutableBuiltinOrigin = <Key = never>(
  origin: JavaScriptModuleOrigin,
  selected: readonly Key[] = [],
):
  | { readonly specifier: string; readonly path: readonly (Key | string)[] }
  | undefined => {
  const path = [...origin.importedPath, ...selected];
  if (origin.resolutionMode === "require")
    return { specifier: origin.specifier, path };
  const specifier = origin.specifier.replace(/^node:/u, "");
  if (!MUTABLE_BUILTIN_DEFAULTS.has(specifier)) return undefined;
  if (path[0] === "default") return { specifier, path: path.slice(1) };
  if (specifier === "process" && (path[0] === "env" || path[0] === "argv"))
    return { specifier, path };
  return specifier === "fs" && path[0] === "promises"
    ? { specifier, path }
    : undefined;
};
