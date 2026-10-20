import type { FileHandle } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { mediaTypeEssence } from "../../domain/analysisView/webNetworkRouteTemplates.js";
import { isExactJsonNumber } from "../../domain/exactJsonNumber.js";
import { err, ok, type Result } from "../../domain/result.js";
import { safeParseJson } from "../../domain/safeJson.js";
import {
  RegularFileCapacityError,
  readStableFileBytes,
} from "../../filesystem/readStableFileBytes.js";
import { openRegularFile } from "../../filesystem/RegularFile.js";

/** Why a named file or download could not be read: a category naming neither the uri nor the content. */
export type IntakeFailure =
  | "not-found"
  | "permission"
  | "not-regular-file"
  | "changed"
  | "read-failed"
  | "timeout"
  | "http-status"
  | "network";

/** A JSON-RPC error the data plane answers with; `data` locates a document problem or names an intake failure. */
export interface RpcError {
  readonly code: number;
  readonly message: string;
  readonly data?:
    | { readonly path: string }
    | { readonly reason: IntakeFailure };
}

const INVALID_PARAMS = -32602;
/** The data plane could not complete an operation whose params were valid. */
const SERVER_ERROR = -32000;

/** A loaded state document is at most this large, whether it arrives as bytes, a file or a download. */
export const STATE_INTAKE_LIMIT_BYTES = 32 * 1024 * 1024;
/** An https state download must finish within this time. */
export const STATE_FETCH_TIMEOUT_MS = 30_000;

/** Fetches one https state document; injectable so tests make no external requests. */
export type StateFetcher = (url: URL, signal: AbortSignal) => Promise<Response>;

/** Redirects are refused so a download never leaves the https origin the caller named. */
export const fetchStateDocument: StateFetcher = (url, signal) =>
  fetch(url, { signal, redirect: "error" });

/** How `data/add` reaches documents a uri names; injectable so tests make no external requests and need not wait. */
export interface StateIntake {
  readonly fetchState: StateFetcher;
  readonly timeoutMs: number;
}

/** The intake a served environment uses. */
export const DEFAULT_STATE_INTAKE: StateIntake = {
  fetchState: fetchStateDocument,
  timeoutMs: STATE_FETCH_TIMEOUT_MS,
};

/** Stands in for a value that JSON parsing would change: a number without an exact native value, or a `__proto__` member. */
const NOT_EXACT_JSON = Symbol("not exact JSON");

/** Mark values native parsing would change, so validation refuses them rather than storing an altered value. */
export const exactJsonReviver = (
  key: string,
  value: unknown,
  context?: { readonly source?: string },
): unknown =>
  key === "__proto__" ||
  (typeof value === "number" && !isExactJsonNumber(value, context?.source))
    ? NOT_EXACT_JSON
    : value;

export const invalidParams = (detail: string, path?: string): RpcError => ({
  code: INVALID_PARAMS,
  message: `invalid params: ${detail}`,
  ...(path === undefined ? {} : { data: { path } }),
});

const TOO_LARGE = invalidParams(
  `the state document exceeds ${String(STATE_INTAKE_LIMIT_BYTES)} bytes`,
);

const unreadable = (reason: IntakeFailure): RpcError => ({
  ...invalidParams("the file uri does not name a readable regular file"),
  data: { reason },
});

const fetchFailed = (reason: IntakeFailure): RpcError => ({
  code: SERVER_ERROR,
  message: "the state document could not be downloaded",
  data: { reason },
});

const FILE_FAILURES: ReadonlyMap<string, IntakeFailure> = new Map([
  ["ENOENT", "not-found"],
  ["ENOTDIR", "not-found"],
  ["EACCES", "permission"],
  ["EPERM", "permission"],
  ["EISDIR", "not-regular-file"],
  ["ENOTFILE", "not-regular-file"],
  ["ESTALE", "changed"],
]);

/** The coarse category of a file open or read failure, from its error code. */
const fileFailure = (cause: unknown): IntakeFailure =>
  (cause instanceof Error && "code" in cause
    ? FILE_FAILURES.get(String(cause.code))
    : undefined) ?? "read-failed";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

/** Parse loaded bytes as UTF-8 JSON, marking values parsing would change; the content is never echoed. */
const parseDocumentBytes = (bytes: Uint8Array): Result<unknown, RpcError> => {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return err(invalidParams("the file is not UTF-8 text"));
  }
  const parsed = safeParseJson(text, exactJsonReviver);
  return parsed.ok
    ? ok(parsed.value)
    : err(invalidParams("the file is not JSON"));
};

/** Read one regular file within the intake limit and close it before answering. */
const readStateFile = async (
  path: string,
): Promise<Result<Buffer, RpcError>> => {
  let handle: FileHandle;
  try {
    handle = await openRegularFile(path, { symlinks: "follow" });
  } catch (cause: unknown) {
    return err(unreadable(fileFailure(cause)));
  }
  let read: Result<Buffer, RpcError>;
  try {
    read = ok(
      await readStableFileBytes(handle, path, STATE_INTAKE_LIMIT_BYTES, {
        symlinks: "follow",
      }),
    );
  } catch (cause: unknown) {
    read = err(
      cause instanceof RegularFileCapacityError
        ? TOO_LARGE
        : unreadable(fileFailure(cause)),
    );
  }
  try {
    await handle.close();
  } catch {
    return err({
      code: SERVER_ERROR,
      message: "the state file could not be closed after reading",
    });
  }
  return read;
};

/** Settles only by rejecting when the signal aborts; the rejection is always handled. */
const abortion = (signal: AbortSignal): Promise<never> => {
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
  });
  aborted.catch(() => undefined);
  return aborted;
};

/** Read a response body within the intake limit and the download's time, whether or not the fetcher ties the body to the signal. */
const readCapped = async (
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
): Promise<Result<Buffer, RpcError>> => {
  if (body === null) return ok(Buffer.alloc(0));
  const reader = body.getReader();
  const aborted = abortion(signal);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) return ok(Buffer.concat(chunks, total));
      total += value.byteLength;
      if (total > STATE_INTAKE_LIMIT_BYTES) {
        await reader.cancel().catch(() => undefined);
        return err(TOO_LARGE);
      }
      chunks.push(value);
    }
  } catch {
    void reader.cancel().catch(() => undefined);
    return err(fetchFailed(signal.aborted ? "timeout" : "network"));
  }
};

/** Download one https document within the time and size limits. */
const downloadState = async (
  url: URL,
  intake: StateIntake,
): Promise<Result<Buffer, RpcError>> => {
  const signal = AbortSignal.timeout(intake.timeoutMs);
  const fetching = Promise.resolve().then(() => intake.fetchState(url, signal));
  let response: Response;
  try {
    response = await Promise.race([fetching, abortion(signal)]);
  } catch {
    // A response that arrives after the timeout is released unread.
    void fetching
      .then(
        (late) => late.body?.cancel(),
        () => undefined,
      )
      .catch(() => undefined);
    return err(fetchFailed(signal.aborted ? "timeout" : "network"));
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (!response.ok || declared > STATE_INTAKE_LIMIT_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return err(
      response.ok
        ? TOO_LARGE
        : {
            ...fetchFailed("http-status"),
            message: `the state document download answered HTTP ${String(response.status)}`,
          },
    );
  }
  return readCapped(response.body, signal);
};

/** The bytes a file part carries inline or names by a `file://` or `https://` uri. */
const fileBytes = async (
  file: Readonly<Record<string, unknown>>,
  intake: StateIntake,
): Promise<Result<Uint8Array, RpcError>> => {
  if (typeof file.bytes === "string" && file.uri === undefined) {
    if (!BASE64.test(file.bytes))
      return err(invalidParams("the file part's bytes are not base64"));
    const bytes = Buffer.from(file.bytes, "base64");
    return bytes.length > STATE_INTAKE_LIMIT_BYTES ? err(TOO_LARGE) : ok(bytes);
  }
  if (
    typeof file.uri !== "string" ||
    file.bytes !== undefined ||
    !URL.canParse(file.uri)
  )
    return err(
      invalidParams("a file part carries exactly one of bytes or a uri"),
    );
  const url = new URL(file.uri);
  if (url.protocol === "https:") return downloadState(url, intake);
  if (url.protocol !== "file:")
    return err(invalidParams("a file uri is a file:// or https:// URL"));
  let path: string;
  try {
    path = fileURLToPath(url);
  } catch {
    return err(invalidParams("a file:// uri names a local absolute path"));
  }
  return readStateFile(path);
};

/** The state document one `data/add` part carries, parsed but not yet validated. */
export const partDocument = async (
  part: unknown,
  intake: StateIntake,
): Promise<Result<unknown, RpcError>> => {
  if (isRecord(part) && part.kind === "data" && isRecord(part.data))
    return ok(part.data);
  if (!isRecord(part) || part.kind !== "file" || !isRecord(part.file))
    return err(
      invalidParams(
        "a data/add part is a data part holding the document or a file part carrying it",
      ),
    );
  const { mimeType } = part.file;
  if (
    mimeType !== undefined &&
    (typeof mimeType !== "string" ||
      mediaTypeEssence(mimeType) !== "application/json")
  )
    return err(invalidParams("a file part's mimeType is application/json"));
  const bytes = await fileBytes(part.file, intake);
  return bytes.ok ? parseDocumentBytes(bytes.value) : bytes;
};
