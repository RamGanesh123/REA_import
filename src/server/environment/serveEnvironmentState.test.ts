import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { timedCaptureEvidence } from "../../../tests/fixtures/analysisView.js";
import {
  environmentStateServeFixture,
  environmentStateServeInputs,
} from "../../../tests/fixtures/environmentServe.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { EnvironmentStateStore } from "../../application/environment/environmentStateStore.js";
import {
  environmentCard,
  STATE_INTAKE_EXTENSION,
  STATE_OPERATIONS,
} from "../../application/environment/environmentTools.js";
import { stateDataPlane } from "./environmentDataPlane.js";
import {
  ENVIRONMENT_CARD_PATH,
  ENVIRONMENT_RPC_PATH,
  environmentRoutes,
  serveEnvironment,
  type ServedEnvironment,
} from "./serveEnvironment.js";
import {
  DEFAULT_STATE_INTAKE,
  STATE_INTAKE_LIMIT_BYTES,
  type StateIntake,
} from "./stateIntake.js";

const { source, state } = environmentStateServeInputs();

/** The initial state as a rea-state/v1 document with user 2 renamed. */
const renamedDocument = () => {
  const document = structuredClone(new EnvironmentStateStore(state).snapshot());
  return {
    rea_state: {
      ...document.rea_state,
      entities: document.rea_state.entities.map((entity) =>
        entity.type === "/api/users" && entity.id === "2"
          ? { ...entity, fields: { ...entity.fields, login: "renamed" } }
          : entity,
      ),
    },
  };
};

/** A data plane over a fresh store, posting raw bodies to its route. */
const dataPlane = (intake: Partial<StateIntake> = {}) => {
  const store = new EnvironmentStateStore(state);
  const route = environmentRoutes(
    environmentCard("grafana-example", [], "state"),
    stateDataPlane(store, { ...DEFAULT_STATE_INTAKE, ...intake }),
  ).find((entry) => entry.path === ENVIRONMENT_RPC_PATH);
  if (route === undefined) throw new Error("No data-plane route");
  const post = async (body: unknown) => {
    const response = await route.handle(
      new Request(`http://127.0.0.1${ENVIRONMENT_RPC_PATH}`, {
        method: "POST",
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
    return {
      status: response.status,
      json: response.status === 202 ? undefined : await response.json(),
    };
  };
  const call = async (method: string, params?: unknown) =>
    (
      await post({
        jsonrpc: "2.0",
        id: 1,
        method,
        ...(params === undefined ? {} : { params }),
      })
    ).json;
  const add = (part: unknown) => call("data/add", { parts: [part] });
  return { store, post, call, add };
};

const loginOf = (store: EnvironmentStateStore) =>
  store.entity("/api/users", "/api/users", "2")?.fields.login;

describe("state data plane", () => {
  it("answers data/get, data/add and data/reset in the AgentEnv shapes", async () => {
    const plane = dataPlane();
    await expect(plane.call("data/get")).resolves.toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        parts: [
          {
            kind: "data",
            data: JSON.parse(JSON.stringify(plane.store.snapshot())),
          },
        ],
      },
    });
    await expect(
      plane.add({ kind: "data", data: renamedDocument() }),
    ).resolves.toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(loginOf(plane.store)).toBe("renamed");
    await expect(plane.call("data/reset")).resolves.toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });
    expect(loginOf(plane.store)).toBe("probe");
    await expect(plane.call("data/remove")).resolves.toMatchObject({
      error: { code: -32601, message: "method not found: data/remove" },
    });
  });

  it("refuses anything but exactly one data or file part as invalid params", async () => {
    const plane = dataPlane();
    for (const params of [
      { parts: [] },
      undefined,
      {
        parts: [
          { kind: "data", data: {} },
          { kind: "data", data: {} },
        ],
      },
      { parts: [{ kind: "text", text: "{}" }] },
      { parts: [{ kind: "file", file: { bytes: "e30=", uri: "file:///x" } }] },
      { parts: [{ kind: "file", file: { bytes: "not base64!" } }] },
      {
        parts: [
          { kind: "file", file: { bytes: "e30=", mimeType: "text/plain" } },
        ],
      },
      { parts: [{ kind: "file", file: { uri: "http://example.test/x" } }] },
    ])
      await expect(plane.call("data/add", params)).resolves.toMatchObject({
        error: { code: -32602 },
      });
    expect(loginOf(plane.store)).toBe("probe");
  });

  it("names the first invalid member by JSON pointer and changes nothing", async () => {
    const plane = dataPlane();
    const document = renamedDocument();
    const entities = document.rea_state.entities.map((entity, index) =>
      index === 3 ? { ...entity, collection: "/api/elsewhere" } : entity,
    );
    const reply = await plane.add({
      kind: "data",
      data: { rea_state: { ...document.rea_state, entities } },
    });
    expect(reply).toMatchObject({
      error: {
        code: -32602,
        message: expect.stringContaining("/rea_state/entities/3/collection"),
        data: { path: "/rea_state/entities/3/collection" },
      },
    });
    expect(loginOf(plane.store)).toBe("probe");
    // Values parsing would alter are refused where they sit, never rounded or turned into a prototype.
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "data/add",
      params: { parts: [{ kind: "data", data: renamedDocument() }] },
    });
    for (const altered of [
      '"login":9007199254740993',
      '"__proto__":{"polluted":true},"login":"renamed"',
    ]) {
      const reply = await plane.post(
        body.replace('"login":"renamed"', altered),
      );
      expect(reply.json).toMatchObject({
        error: {
          code: -32602,
          data: { path: expect.stringMatching(/\/fields$/u) },
        },
      });
      expect(JSON.stringify(reply.json)).not.toContain("polluted");
    }
    expect(loginOf(plane.store)).toBe("probe");
  });
});

describe("state data plane intake", () => {
  it("loads file parts from bytes and from a file uri", async () => {
    const plane = dataPlane();
    const text = JSON.stringify(renamedDocument());
    await expect(
      plane.add({
        kind: "file",
        file: {
          bytes: Buffer.from(text).toString("base64"),
          mimeType: "application/json; charset=utf-8",
        },
      }),
    ).resolves.toMatchObject({ result: {} });
    expect(loginOf(plane.store)).toBe("renamed");
    plane.store.reset();
    const root = await createTestTempDirectory("rea-environment-state-file-");
    const path = join(root, "state.json");
    await writeFile(path, text);
    await expect(
      plane.add({ kind: "file", file: { uri: pathToFileURL(path).href } }),
    ).resolves.toMatchObject({ result: {} });
    expect(loginOf(plane.store)).toBe("renamed");
    await mkdir(join(root, "directory"));
    for (const [name, reason] of [
      ["missing.json", "not-found"],
      ["directory", "not-regular-file"],
    ] as const) {
      const uri = pathToFileURL(join(root, name)).href;
      const reply = await plane.add({ kind: "file", file: { uri } });
      expect(reply).toMatchObject({
        error: { code: -32602, data: { reason } },
      });
      expect(JSON.stringify(reply)).not.toContain(root);
    }
  });

  it("downloads https uris through the injected fetcher within its limits, never echoing the uri", async () => {
    const requested: string[] = [];
    let answer = (): Response =>
      new Response(JSON.stringify(renamedDocument()));
    const plane = dataPlane({
      fetchState: (url, signal) => {
        requested.push(url.href);
        expect(signal).toBeInstanceOf(AbortSignal);
        return Promise.resolve(answer());
      },
    });
    const uri = "https://state.example.test/state.json?token=secret-token";
    const add = () => plane.add({ kind: "file", file: { uri } });
    await expect(add()).resolves.toMatchObject({ result: {} });
    expect(requested).toEqual([uri]);
    expect(loginOf(plane.store)).toBe("renamed");
    answer = () => new Response("missing", { status: 404 });
    const missing = await add();
    expect(missing).toMatchObject({
      error: { code: -32000, data: { reason: "http-status" } },
    });
    expect(JSON.stringify(missing)).not.toContain("secret-token");
    answer = () =>
      new Response("{}", {
        headers: { "content-length": String(STATE_INTAKE_LIMIT_BYTES + 1) },
      });
    await expect(add()).resolves.toMatchObject({ error: { code: -32602 } });
    const chunk = new Uint8Array(1024 * 1024);
    answer = () => {
      let sent = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            sent += chunk.length;
            controller.enqueue(chunk);
            if (sent > STATE_INTAKE_LIMIT_BYTES + chunk.length)
              controller.close();
          },
        }),
      );
    };
    await expect(add()).resolves.toMatchObject({
      error: { code: -32602, message: expect.stringContaining("exceeds") },
    });
    answer = () => new Response("not json");
    await expect(add()).resolves.toMatchObject({ error: { code: -32602 } });
  });

  it("runs batches in order and runs notifications without replying", async () => {
    const plane = dataPlane();
    const batch = await plane.post([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "data/add",
        params: { parts: [{ kind: "data", data: renamedDocument() }] },
      },
      { jsonrpc: "2.0", id: 2, method: "data/get" },
    ]);
    expect(batch.json).toMatchObject([
      { id: 1, result: {} },
      { id: 2, result: { parts: [{ kind: "data" }] } },
    ]);
    expect(JSON.stringify(batch.json)).toContain('"login":"renamed"');
    const notified = await plane.post({ jsonrpc: "2.0", method: "data/reset" });
    expect(notified.status).toBe(202);
    expect(loginOf(plane.store)).toBe("probe");
  });
});

describe("state data plane timing and order", () => {
  it("ends a download that outlives its time limit, whether or not the fetcher honours the signal", async () => {
    const uri = "https://state.example.test/slow.json?token=secret-token";
    const waitForAbort = (signal: AbortSignal) =>
      new Promise<Response>((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    const stalledBody = () =>
      Promise.resolve(
        new Response(new ReadableStream<Uint8Array>({ pull: () => undefined })),
      );
    for (const fetchState of [
      (_: URL, signal: AbortSignal) => waitForAbort(signal),
      stalledBody,
      () => new Promise<Response>(() => undefined),
    ]) {
      const plane = dataPlane({ fetchState, timeoutMs: 20 });
      const reply = await plane.add({ kind: "file", file: { uri } });
      expect(reply).toMatchObject({
        error: { code: -32000, data: { reason: "timeout" } },
      });
      expect(JSON.stringify(reply)).not.toContain("secret-token");
      expect(loginOf(plane.store)).toBe("probe");
    }
    const failing = dataPlane({
      fetchState: () => Promise.reject(new TypeError("fetch failed")),
    });
    await expect(
      failing.add({ kind: "file", file: { uri } }),
    ).resolves.toMatchObject({
      error: { code: -32000, data: { reason: "network" } },
    });
  });

  it("applies data-plane calls from separate requests in arrival order", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const plane = dataPlane({
      fetchState: async () => {
        await gate;
        return new Response(JSON.stringify(renamedDocument()));
      },
    });
    const slowAdd = plane.add({
      kind: "file",
      file: { uri: "https://state.example.test/state.json" },
    });
    const reset = plane.call("data/reset");
    release();
    await expect(slowAdd).resolves.toMatchObject({ result: {} });
    await expect(reset).resolves.toMatchObject({ result: {} });
    // The reset arrived after the add, so it wins even though the add finished loading later.
    expect(loginOf(plane.store)).toBe("probe");
  });
});

const served: ServedEnvironment[] = [];
afterEach(async () => {
  await Promise.all(served.splice(0).map((entry) => entry.close()));
});

/** Serve a state on a loopback port until the test ends. */
const serveState = async (
  inputs: ReturnType<typeof environmentStateServeInputs>,
): Promise<ServedEnvironment> => {
  const entry = await serveEnvironment({
    ...inputs,
    host: "127.0.0.1",
    port: 0,
  });
  if (!entry.ok) throw entry.error;
  served.push(entry.value);
  return entry.value;
};

/** Run `use` with an MCP client, after checking it lists the card's tools, then end its session. */
const withClient = async (
  environment: ServedEnvironment,
  use: (client: Client) => Promise<void>,
): Promise<void> => {
  const transport = new StreamableHTTPClientTransport(new URL(environment.url));
  const client = new Client({ name: "environment-state", version: "1" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    expect(tools.map(({ name }) => name)).toEqual(
      environment.card.capabilities.tools.map(({ name }) => name),
    );
    await use(client);
  } finally {
    await transport.terminateSession();
    await client.close();
  }
};

describe("serveEnvironment with a state", () => {
  it("declares the data plane, serves read tools from the state and reflects data/add in the next answer", async () => {
    const environment = await serveState({ source, state });
    const url = new URL(environment.url);
    const card: unknown = await (
      await fetch(new URL(ENVIRONMENT_CARD_PATH, url))
    ).json();
    expect(card).toEqual(JSON.parse(JSON.stringify(environment.card)));
    const { capabilities } = environment.card;
    expect(capabilities.extensions).toEqual([STATE_INTAKE_EXTENSION]);
    expect(capabilities.operations).toEqual(STATE_OPERATIONS);
    const names = capabilities.tools.map((tool) => tool.name);
    expect(names).toContain("get_users_by_id");
    for (const write of [
      "post_annotations",
      "delete_dashboards_by_uid",
      "post_folders",
      "put_folders_by_uid",
      "delete_teams_by_id",
    ])
      expect(names).not.toContain(write);
    await withClient(environment, async (client) => {
      const before = await client.callTool({
        name: "get_users_by_id",
        arguments: { id: "2" },
      });
      expect(before.structuredContent).toMatchObject({
        body: { login: "probe" },
        state: { source: "state", view: "item", id: "2" },
      });
      const added = await fetch(new URL(ENVIRONMENT_RPC_PATH, url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "data/add",
          params: { parts: [{ kind: "data", data: renamedDocument() }] },
        }),
      });
      await expect(added.json()).resolves.toMatchObject({ result: {} });
      const after = await client.callTool({
        name: "get_users_by_id",
        arguments: { id: "2" },
      });
      expect(after.structuredContent).toMatchObject({
        body: { login: "renamed" },
      });
      const missing = await client.callTool({
        name: "get_users_by_id",
        arguments: { id: "999" },
      });
      expect(missing.isError).toBe(true);
    });
  });

  it("serves query POSTs from their recordings and leaves state-changing writes out", async () => {
    const environment = await serveState(
      environmentStateServeInputs(
        environmentStateServeFixture(
          timedCaptureEvidence([
            ["GET", "/api/items", [{ id: 1, name: "a" }]],
            ["POST", "/api/search", [{ id: 1, name: "a" }]],
            ["POST", "/api/items", { id: 2, name: "b" }],
          ]),
        ),
      ),
    );
    const { tools } = environment.card.capabilities;
    expect(tools.map(({ name }) => name)).toEqual(["get_items", "post_search"]);
    expect(
      tools.find(({ name }) => name === "post_search")?.description,
    ).toContain(
      "answers from the served environment state where the state backs this tool",
    );
    await withClient(environment, async (client) => {
      const searched = await client.callTool({
        name: "post_search",
        arguments: {},
      });
      expect(searched.structuredContent).toMatchObject({
        body: [{ id: 1, name: "a" }],
        state: { source: "recording", reason: "query-body" },
      });
    });
  });
});

it("keeps the stateless card's data plane empty", () => {
  expect(environmentCard("x", []).capabilities).toEqual({
    extensions: null,
    tools: [],
    operations: [],
  });
});
