import type { EnvironmentStateStore } from "../../application/environment/environmentStateStore.js";
import type { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import {
  DEFAULT_STATE_INTAKE,
  invalidParams,
  partDocument,
  type RpcError,
  type StateIntake,
} from "./stateIntake.js";

/** One data-plane method's outcome; undefined from a method table means the method is not served. */
export type RpcOutcome =
  | { readonly result: unknown }
  | { readonly error: RpcError };

/** The data-plane methods one environment serves, by JSON-RPC method name. */
export type RpcMethods = (
  method: string,
  params: unknown,
) => Promise<RpcOutcome | undefined>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const pointerSegment = (segment: string | number): string =>
  String(segment).replaceAll("~", "~0").replaceAll("/", "~1");

/** The first document problem as `-32602`, located by a JSON pointer into the document. */
const documentError = (error: AnalysisInputError): RpcError => {
  const issue = error.issues[0];
  const pointer = (issue?.path ?? [])
    .map((segment) => `/${pointerSegment(segment)}`)
    .join("");
  return invalidParams(
    `${pointer === "" ? "the document" : pointer} ${issue?.message ?? "is not a rea-state/v1 document"}`,
    pointer,
  );
};

/** `data/add`: exactly one part, whose document replaces the whole state only when it is valid. */
const addState = async (
  store: EnvironmentStateStore,
  params: unknown,
  intake: StateIntake,
): Promise<RpcOutcome> => {
  const parts = isRecord(params) ? params.parts : undefined;
  if (!Array.isArray(parts) || parts.length !== 1)
    return { error: invalidParams("data/add takes exactly one part") };
  const document = await partDocument(parts[0], intake);
  if (!document.ok) return { error: document.error };
  const replaced = store.replace(document.value);
  return replaced.ok
    ? { result: {} }
    : { error: documentError(replaced.error) };
};

/** One data-plane method over the live state, or undefined when the method is not served. */
const runMethod = (
  store: EnvironmentStateStore,
  intake: StateIntake,
  method: string,
  params: unknown,
): Promise<RpcOutcome> | undefined => {
  switch (method) {
    case "data/reset":
      store.reset();
      return Promise.resolve({ result: {} });
    case "data/add":
      return addState(store, params, intake);
    case "data/get":
      return Promise.resolve({
        result: { parts: [{ kind: "data", data: store.snapshot() }] },
      });
    default:
      return undefined;
  }
};

/**
 * `data/reset`, `data/add` and `data/get` over one live state. Calls run one
 * at a time in arrival order across requests, so a slow load never overwrites
 * a later reset and at most one loaded document is parsed at once.
 */
export const stateDataPlane = (
  store: EnvironmentStateStore,
  intake: StateIntake = DEFAULT_STATE_INTAKE,
): RpcMethods => {
  let previous: Promise<unknown> = Promise.resolve();
  return (method, params) => {
    const next = previous.then(() => runMethod(store, intake, method, params));
    previous = next.catch(() => undefined);
    return next;
  };
};
