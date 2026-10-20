import {
  DEFAULT_MAX_REQUEST_BODY_SIZE,
  fromJsonSchema,
  readRequestBody,
  type CallToolResult,
  type Transport,
} from "@modelcontextprotocol/server";
import type { Logger } from "pino";

import type { ReplayArguments } from "../../application/environment/environmentReplay.js";
import type { EnvironmentSource } from "../../application/environment/environmentSource.js";
import {
  servedCatalog,
  type EnvironmentState,
} from "../../application/environment/environmentState.js";
import {
  environmentToolAnswer,
  type EnvironmentToolAnswer,
} from "../../application/environment/environmentStateAnswer.js";
import { EnvironmentStateStore } from "../../application/environment/environmentStateStore.js";
import {
  environmentCard,
  REPLAY_CATALOG_INSTRUCTIONS,
  type EnvironmentCard,
  type EnvironmentToolDefinition,
} from "../../application/environment/environmentTools.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { safeParseJson } from "../../domain/safeJson.js";
import type { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { ok, type Result } from "../../domain/result.js";
import { PRODUCT_IDENTITY } from "../../identity.js";
import {
  jsonRpcErrorResponse,
  serveStreamableHttp,
  type StreamableHttpRoute,
  type StreamableHttpServer,
} from "../http/serveStreamableHttp.js";
import {
  TARGET_CONTENT_RESULT_META,
  UNTRUSTED_CONTENT_INSTRUCTIONS,
} from "../toolResultEncoding.js";
import { RequestTrackingMcpServer } from "../RequestTrackingMcpServer.js";
import {
  stateDataPlane,
  type RpcMethods,
  type RpcOutcome,
} from "./environmentDataPlane.js";
import {
  DEFAULT_STATE_INTAKE,
  exactJsonReviver,
  type RpcError,
  type StateFetcher,
} from "./stateIntake.js";
import { TargetContentTransport } from "./targetContentTransport.js";

/** Where the environment card is served. */
export const ENVIRONMENT_CARD_PATH = "/.well-known/agent-env.json";
/** The JSON-RPC data plane the card advertises; it serves methods only when serving from a state. */
export const ENVIRONMENT_RPC_PATH = "/agentenv";

const METHOD_NOT_FOUND = -32601;
const INVALID_REQUEST = -32600;
const PARSE_ERROR = -32700;
/** The SDK's code for a body over its bound, so `/agentenv` and `/mcp` refuse alike. */
const PAYLOAD_TOO_LARGE = -32000;

/** Every tool result of a replay server is target content, including errors the SDK builds itself. */
class EnvironmentMcpServer extends RequestTrackingMcpServer {
  override connect(transport: Transport): Promise<void> {
    return super.connect(new TargetContentTransport(transport));
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** At most this many messages in one data-plane batch; a larger batch is refused whole. */
export const MAX_RPC_BATCH_MESSAGES = 100;

/** A JSON-RPC 2.0 request or notification: an id, when present, is a string, number or null; params are structured. */
const isRpcMessage = (
  message: unknown,
): message is Readonly<Record<string, unknown>> =>
  isRecord(message) &&
  message.jsonrpc === "2.0" &&
  typeof message.method === "string" &&
  (!("id" in message) ||
    typeof message.id === "string" ||
    typeof message.id === "number" ||
    message.id === null) &&
  (!("params" in message) ||
    (typeof message.params === "object" && message.params !== null));

/** Build the MCP server whose tools answer from retained records or the live state; every result is target content. */
export const createEnvironmentMcpServer = (
  name: string,
  tools: readonly EnvironmentToolDefinition[],
  answer: EnvironmentToolAnswer,
): RequestTrackingMcpServer => {
  // Tool names, descriptions and replies all come from the captured application, so the
  // server carries REA's untrusted-content instructions plus a warning about its own catalog.
  const server = new EnvironmentMcpServer(
    { name, version: PRODUCT_IDENTITY.packageVersion },
    {
      instructions: `${UNTRUSTED_CONTENT_INSTRUCTIONS} ${REPLAY_CATALOG_INSTRUCTIONS}`,
    },
  );
  for (const definition of tools)
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: fromJsonSchema<ReplayArguments>(definition.inputSchema),
      },
      (args): CallToolResult => {
        const replayed = answer(definition.tool, args);
        if (!replayed.ok)
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(projectAnalysisError(replayed.error)),
              },
            ],
          };
        return {
          content: [{ type: "text", text: JSON.stringify(replayed.value) }],
          structuredContent: replayed.value,
          _meta: TARGET_CONTENT_RESULT_META,
        };
      },
    );
  return server;
};

type RpcReply = {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
} & ({ readonly result: unknown } | { readonly error: RpcError });

/** The reply to one JSON-RPC message, or none for a notification; a method no table serves is not found. */
const rpcReply = async (
  message: unknown,
  methods: RpcMethods | undefined,
): Promise<RpcReply | undefined> => {
  const id =
    isRecord(message) &&
    (typeof message.id === "string" || typeof message.id === "number")
      ? message.id
      : null;
  if (!isRpcMessage(message))
    return {
      jsonrpc: "2.0",
      id,
      error: { code: INVALID_REQUEST, message: "invalid request" },
    };
  const method = String(message.method);
  // A notification still runs its method; it only gets no reply.
  const outcome: RpcOutcome | undefined =
    methods === undefined ? undefined : await methods(method, message.params);
  if (!("id" in message)) return undefined;
  return {
    jsonrpc: "2.0",
    id,
    ...(outcome ?? {
      error: { code: METHOD_NOT_FOUND, message: `method not found: ${method}` },
    }),
  };
};

/** Answer the data plane within the body bound; without methods every request is not found. */
const answerRpc = async (
  request: Request,
  methods: RpcMethods | undefined,
): Promise<Response> => {
  const read = await readRequestBody(request, DEFAULT_MAX_REQUEST_BODY_SIZE);
  if (read.tooLarge)
    return jsonRpcErrorResponse(
      413,
      PAYLOAD_TOO_LARGE,
      `Request body must not exceed ${String(DEFAULT_MAX_REQUEST_BODY_SIZE)} bytes`,
    );
  // Values parsing would alter become markers: such an id is refused rather than echoed as another number, and a state document carrying one is refused.
  const parsed = safeParseJson(read.text, exactJsonReviver);
  if (!parsed.ok) return jsonRpcErrorResponse(400, PARSE_ERROR, "parse error");
  // A batch is answered message by message; notifications get no reply at all.
  if (Array.isArray(parsed.value)) {
    if (parsed.value.length === 0)
      return jsonRpcErrorResponse(400, INVALID_REQUEST, "invalid request");
    if (parsed.value.length > MAX_RPC_BATCH_MESSAGES)
      return jsonRpcErrorResponse(
        400,
        INVALID_REQUEST,
        `batch exceeds ${String(MAX_RPC_BATCH_MESSAGES)} messages`,
      );
    // Messages run in order, so a batch's later reads see its earlier writes.
    const replies: RpcReply[] = [];
    for (const message of parsed.value) {
      const reply = await rpcReply(message, methods);
      if (reply !== undefined) replies.push(reply);
    }
    return replies.length === 0
      ? new Response(null, { status: 202 })
      : Response.json(replies);
  }
  const reply = await rpcReply(parsed.value, methods);
  return reply === undefined
    ? new Response(null, { status: 202 })
    : Response.json(reply, {
        status:
          "error" in reply && reply.error.code === INVALID_REQUEST ? 400 : 200,
      });
};

/** The plain routes an agent environment serves beside `/mcp`; data-plane methods only when given. */
export const environmentRoutes = (
  card: EnvironmentCard,
  methods?: RpcMethods,
): readonly StreamableHttpRoute[] => [
  {
    method: "GET",
    path: ENVIRONMENT_CARD_PATH,
    handle: () => Response.json(card),
  },
  {
    method: "POST",
    path: ENVIRONMENT_RPC_PATH,
    handle: (request) => answerRpc(request, methods),
  },
];

export interface ServeEnvironmentOptions {
  readonly source: EnvironmentSource;
  readonly host: string;
  readonly port: number;
  readonly signal?: AbortSignal;
  /** Served name; defaults to the manifest's environment name. */
  readonly environmentName?: string;
  readonly logger?: Logger;
  /** Reports a listener failure after binding; the failure is logged either way. */
  readonly onerror?: (error: Error) => void;
  /** The initial state read tools answer from; without it every tool replays its recordings. */
  readonly state?: EnvironmentState;
  /** Downloads https state documents for `data/add`; defaults to a redirect-refusing fetch. */
  readonly fetchState?: StateFetcher;
}

/** A listening agent environment and the card it serves. */
export interface ServedEnvironment extends StreamableHttpServer {
  readonly card: EnvironmentCard;
}

/** Serve one manifest as an agent environment until closed. */
export const serveEnvironment = async (
  options: ServeEnvironmentOptions,
): Promise<Result<ServedEnvironment, AnalysisResourceConstraintError>> => {
  const { source, host, port, logger } = options;
  const name = options.environmentName ?? source.manifest.name;
  // One store per process: every MCP session and the data plane share it.
  const store =
    options.state === undefined
      ? undefined
      : new EnvironmentStateStore(options.state);
  const catalog = servedCatalog(source, store !== undefined, name);
  if (!catalog.ok) return catalog;
  const { tools, dataPlane } = catalog.value;
  const card = environmentCard(name, tools, dataPlane);
  const answer = environmentToolAnswer(source, store);
  const served = await serveStreamableHttp({
    host,
    port,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    createMcpServer: () => createEnvironmentMcpServer(name, tools, answer),
    routes: environmentRoutes(
      card,
      store === undefined
        ? undefined
        : stateDataPlane(store, {
            ...DEFAULT_STATE_INTAKE,
            ...(options.fetchState === undefined
              ? {}
              : { fetchState: options.fetchState }),
          }),
    ),
    ...(logger === undefined ? {} : { logger }),
    onerror: (error) => {
      logger?.error(
        { error: error.message },
        "Agent environment listener failed",
      );
      options.onerror?.(error);
    },
  });
  return ok({ ...served, card });
};
