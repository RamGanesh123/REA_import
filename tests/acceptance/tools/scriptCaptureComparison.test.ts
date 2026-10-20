import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { createWebTextArtifact } from "../../../src/domain/webContentArtifact.js";
import {
  captureSnapshotSchema,
  webCaptureDiffSchema,
} from "../../../src/domain/webCaptureDiffSchemas.js";
import { stableWebScriptKey } from "../../../src/domain/webInventory.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { passiveNetworkCapture } from "../../fixtures/passiveNetworkCapture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

const scriptCapture = (text: string | null, cdpHash: string | null = null) => {
  const inspection = passiveNetworkCapture([]);
  const metadata = {
    url: `${inspection.target.url}/app.js`,
    cdp_hash: cdpHash,
    length: text?.length ?? 18,
    is_module: true,
    language: "JavaScript",
    source_map_url: null,
  };
  inspection.scripts = {
    total: 1,
    items: [
      {
        ...metadata,
        script_key: stableWebScriptKey(metadata),
        origin: inspection.target.origin,
        frame_id: null,
        resource_reconciliation: {
          status: "unmatched",
          reason: "no_exact_sanitized_url",
        },
        source:
          text === null
            ? { included: false, reason: "source unavailable" }
            : {
                included: true,
                artifact: createWebTextArtifact(text, "text/javascript"),
              },
      },
    ],
  };
  return captureSnapshotSchema.parse({ inspection });
};

const writeCaptures = async (
  captures: readonly ReturnType<typeof scriptCapture>[],
) => {
  const root = await createTestTempDirectory("rea-script-comparison-");
  const paths = captures.map((_, index) => join(root, `${String(index)}.json`));
  await Promise.all(
    captures.map((capture, index) =>
      writeFile(paths[index]!, JSON.stringify(capture)),
    ),
  );
  return paths;
};

const scriptGroupCapture = (texts: readonly (string | null)[]) => {
  const capture = scriptCapture(texts[0] ?? null);
  const base = capture.inspection.scripts.items[0]!.script_key;
  const items = texts.map(
    (text) => scriptCapture(text).inspection.scripts.items[0]!,
  );
  const sourceOrder = (script: (typeof items)[number]) =>
    script.source.included
      ? script.source.artifact.sha256
      : script.source.reason;
  items.sort((left, right) =>
    sourceOrder(left) < sourceOrder(right)
      ? -1
      : sourceOrder(left) > sourceOrder(right)
        ? 1
        : 0,
  );
  capture.inspection.scripts = {
    total: items.length,
    items: items.map((script, index) => ({
      ...script,
      script_key: items.length === 1 ? base : `${base}_${String(index + 1)}`,
    })),
  };
  return captureSnapshotSchema.parse(capture);
};

const compareScripts = async (cli: TestCli, before: string, after: string) => {
  const result = await cli.run({
    arguments: ["compare-web-captures", before, after, "--json"],
  });
  expect(result.exitCode).toBe(0);
  const evidence = parseEvidence(result.json);
  expect(evidence.operation).toBe("compare_web_captures");
  return webCaptureDiffSchema.parse(evidence.normalized_result).dimensions
    .scripts;
};

cliTest(
  "CLI compares retained script content when producer hashes are unavailable",
  async ({ cli }) => {
    const captures = [
      scriptCapture("export let x = 1;\n"),
      scriptCapture("export let x = 2;\n"),
    ];
    const paths = await writeCaptures(captures);
    for (const [left, right, status] of [
      [0, 1, "changed"],
      [1, 0, "changed"],
      [0, 0, "unchanged"],
    ] as const) {
      const compared = await compareScripts(cli, paths[left]!, paths[right]!);
      expect(compared).toMatchObject({
        status,
        total_changes: status === "changed" ? 1 : 0,
      });
      if (status === "changed")
        expect(compared.changes).toEqual([
          {
            identity: captures[0]!.inspection.scripts.items[0]!.script_key,
            change: "modified",
          },
        ]);
    }
  },
);

cliTest(
  "CLI keeps missing script content identity unknown without inventing a change",
  async ({ cli }) => {
    const known = scriptCapture("export let x = 1;\n");
    const missing = scriptCapture(null);
    missing.inspection.completeness.unavailable_sections.push("script_sources");
    const paths = await writeCaptures([known, missing, scriptCapture(null)]);
    for (const [left, right] of [
      [0, 1],
      [1, 0],
      [1, 1],
      [2, 2],
    ] as const) {
      const compared = await compareScripts(cli, paths[left]!, paths[right]!);
      expect(compared).toMatchObject({
        status: "unknown",
        total_changes: 0,
        changes: [],
        reason: expect.any(String),
      });
    }
  },
);

cliTest.for([
  {
    name: "matching producer hashes without source",
    before: null,
    after: null,
    status: "unchanged",
  },
  {
    name: "source retained on only one side with matching producer hashes",
    before: "export let x = 1;\n",
    after: null,
    status: "unchanged",
  },
  {
    name: "retained source changes despite matching producer hashes",
    before: "export let x = 1;\n",
    after: "export let x = 2;\n",
    status: "changed",
  },
] as const)(
  "CLI preserves $name",
  async ({ before, after, status }, { cli }) => {
    const paths = await writeCaptures([
      scriptCapture(before, "producer-hash"),
      scriptCapture(after, "producer-hash"),
    ]);
    for (const [left, right] of [
      [0, 1],
      [1, 0],
    ] as const) {
      const compared = await compareScripts(cli, paths[left]!, paths[right]!);
      expect(compared).toMatchObject({
        status,
        total_changes: status === "changed" ? 1 : 0,
      });
    }
  },
);

cliTest(
  "CLI preserves known script membership changes when shared content is unknown",
  async ({ cli }) => {
    const before = scriptCapture(null);
    const after = structuredClone(before);
    const added = scriptCapture(null).inspection.scripts.items[0]!;
    added.url = `${added.url}?new`;
    added.script_key = stableWebScriptKey(added);
    after.inspection.scripts.items.push(added);
    after.inspection.scripts.total = 2;
    const paths = await writeCaptures([before, after]);
    for (const [left, right, change] of [
      [0, 1, "added"],
      [1, 0, "removed"],
    ] as const) {
      expect(
        await compareScripts(cli, paths[left]!, paths[right]!),
      ).toMatchObject({
        status: "changed",
        total_changes: 1,
        changes: [{ identity: added.script_key, change }],
      });
    }
  },
);

cliTest(
  "CLI matches unchanged duplicate sources before counting replacements",
  async ({ cli }) => {
    const group = scriptGroupCapture([
      "export let x = 1;\n",
      "export let x = 2;\n",
      "export let x = 3;\n",
    ]);
    const sources = group.inspection.scripts.items.map((script) => {
      if (!script.source.included) throw new Error("Expected fixture source");
      return script.source.artifact.text;
    });
    const before = scriptGroupCapture(sources.slice(0, 2));
    const after = scriptGroupCapture(sources.slice(1));
    const paths = await writeCaptures([before, after]);
    for (const [left, right, identity] of [
      [0, 1, before.inspection.scripts.items[0]!.script_key],
      [1, 0, after.inspection.scripts.items[1]!.script_key],
    ] as const) {
      expect(
        await compareScripts(cli, paths[left]!, paths[right]!),
      ).toMatchObject({
        status: "changed",
        total_changes: 1,
        changes: [{ identity, change: "modified" }],
      });
    }
  },
);

cliTest(
  "CLI preserves duplicate occurrence counts and original keys across group growth",
  async ({ cli }) => {
    const group = scriptGroupCapture([
      "export let x = 1;\n",
      "export let x = 2;\n",
    ]);
    const sources = group.inspection.scripts.items.map((script) => {
      if (!script.source.included) throw new Error("Expected fixture source");
      return script.source.artifact.text;
    });
    const before = scriptGroupCapture([sources[1]!]);
    const paths = await writeCaptures([before, group]);
    for (const [left, right, change] of [
      [0, 1, "added"],
      [1, 0, "removed"],
    ] as const) {
      expect(
        await compareScripts(cli, paths[left]!, paths[right]!),
      ).toMatchObject({
        status: "changed",
        total_changes: 1,
        changes: [
          { identity: group.inspection.scripts.items[0]!.script_key, change },
        ],
      });
    }
  },
);

cliTest(
  "CLI preserves repeated digest multiplicity instead of comparing source sets",
  async ({ cli }) => {
    const first = "export let x = 1;\n";
    const second = "export let x = 2;\n";
    const before = scriptGroupCapture([first, first, second]);
    const after = scriptGroupCapture([first, second, second]);
    // Inventory array order is not cross-capture identity either.
    after.inspection.scripts.items.reverse();
    const paths = await writeCaptures([before, after]);
    for (const [left, right] of [
      [0, 1],
      [1, 0],
    ] as const) {
      expect(
        await compareScripts(cli, paths[left]!, paths[right]!),
      ).toMatchObject({
        status: "changed",
        total_changes: 1,
        changes: [{ identity: expect.any(String), change: "modified" }],
      });
    }
  },
);

cliTest.for([0, 2])(
  "CLI keeps mismatched script total %i unknown before source matching",
  async (total, { cli }) => {
    const captures = [
      scriptCapture("export let x = 1;\n"),
      scriptCapture("export let x = 2;\n"),
    ];
    for (const capture of captures) capture.inspection.scripts.total = total;
    captures.push(scriptCapture("export let x = 2;\n"));
    const paths = await writeCaptures(captures);
    for (const [left, right] of [
      [0, 1],
      [1, 0],
      [0, 2],
      [2, 0],
      [0, 0],
    ] as const) {
      expect(
        await compareScripts(cli, paths[left]!, paths[right]!),
      ).toMatchObject({ status: "unknown", total_changes: 0, changes: [] });
    }
  },
);

cliTest(
  "CLI keeps dropped script identities unknown without conflating other event loss",
  async ({ cli }) => {
    const before = scriptCapture("export let x = 1;\n");
    const after = scriptCapture("export let x = 2;\n");
    const droppedBefore = structuredClone(before);
    const droppedAfter = structuredClone(after);
    droppedBefore.inspection.completeness.dropped_events.scripts = 1;
    droppedAfter.inspection.completeness.dropped_events.scripts = 1;
    const networkDrop = structuredClone(after);
    networkDrop.inspection.completeness.dropped_events.network_requests = 1;
    const paths = await writeCaptures([
      before,
      after,
      droppedBefore,
      droppedAfter,
      networkDrop,
    ]);
    for (const [left, right] of [
      [2, 3],
      [3, 2],
      [0, 3],
      [3, 0],
      [2, 1],
      [1, 2],
      [2, 2],
    ] as const) {
      expect(
        await compareScripts(cli, paths[left]!, paths[right]!),
      ).toMatchObject({ status: "unknown", total_changes: 0, changes: [] });
    }
    expect(await compareScripts(cli, paths[0]!, paths[4]!)).toMatchObject({
      status: "changed",
      total_changes: 1,
    });
  },
);

cliTest(
  "CLI keeps missing script membership unknown while preserving known metadata changes",
  async ({ cli }) => {
    const complete = scriptCapture(null, "producer-hash");
    const missing = structuredClone(complete);
    missing.inspection.scripts.items = [];
    const excess = structuredClone(complete);
    excess.inspection.scripts.total = 0;
    const modified = structuredClone(excess);
    modified.inspection.scripts.items[0]!.url += "?revision=2";
    const paths = await writeCaptures([complete, missing, excess, modified]);
    for (const [left, right] of [
      [0, 1],
      [1, 0],
      [0, 2],
      [2, 0],
    ] as const) {
      expect(
        await compareScripts(cli, paths[left]!, paths[right]!),
      ).toMatchObject({ status: "unknown", total_changes: 0, changes: [] });
    }
    for (const [left, right] of [
      [0, 3],
      [3, 0],
    ] as const) {
      expect(
        await compareScripts(cli, paths[left]!, paths[right]!),
      ).toMatchObject({
        status: "changed",
        total_changes: 1,
        changes: [
          {
            identity: complete.inspection.scripts.items[0]!.script_key,
            change: "modified",
          },
        ],
      });
    }
  },
);

cliTest(
  "CLI keeps bare source keys unknown when omissions can hide duplicate members",
  async ({ cli }) => {
    const captures = [
      scriptCapture("export let x = 1;\n"),
      scriptCapture("export let x = 2;\n"),
    ];
    for (const capture of captures) {
      capture.inspection.scripts.total = 2;
      capture.inspection.completeness.truncated_sections.push("scripts");
    }
    const paths = await writeCaptures(captures);
    for (const [left, right] of [
      [0, 1],
      [1, 0],
    ] as const) {
      expect(
        await compareScripts(cli, paths[left]!, paths[right]!),
      ).toMatchObject({ status: "unknown", total_changes: 0, changes: [] });
    }
  },
);

cliTest(
  "CLI keeps duplicate source identity unknown across truncated script inventories",
  async ({ cli }) => {
    const complete = scriptGroupCapture([
      "export let x = 1;\n",
      "export let x = 2;\n",
      "export let x = 3;\n",
    ]);
    const base = complete.inspection.scripts.items[0]!.script_key.replace(
      /_1$/u,
      "",
    );
    const captures = [
      [0, 1, 2],
      [0, 1],
      [1, 2],
    ].map((indexes) => {
      const capture = structuredClone(complete);
      capture.inspection.scripts.items = indexes.map((index, ordinal) => ({
        ...complete.inspection.scripts.items[index]!,
        script_key: `${base}_${String(ordinal + 1)}`,
      }));
      if (indexes.length < 3)
        capture.inspection.completeness.truncated_sections.push("scripts");
      return captureSnapshotSchema.parse(capture);
    });
    const paths = await writeCaptures(captures);
    for (const [left, right] of [
      [0, 2],
      [2, 0],
      [1, 2],
      [2, 1],
    ] as const) {
      expect(
        await compareScripts(cli, paths[left]!, paths[right]!),
      ).toMatchObject({ status: "unknown", total_changes: 0, changes: [] });
    }
  },
);

cliTest(
  "CLI keeps duplicate script source identity unknown when retention renumbers occurrences",
  async ({ cli }) => {
    const before = scriptGroupCapture([
      "export let x = 1;\n",
      "export let x = 2;\n",
    ]);
    const base = before.inspection.scripts.items[0]!.script_key.replace(
      /_1$/u,
      "",
    );
    const after = structuredClone(before);
    // The producer sorts retained digests before this unavailable-source reason.
    after.inspection.scripts.items.reverse();
    after.inspection.scripts.items[1]!.source = {
      included: false,
      reason: "source unavailable",
    };
    for (const [index, script] of after.inspection.scripts.items.entries())
      script.script_key = `${base}_${String(index + 1)}`;
    after.inspection.completeness.unavailable_sections.push("script_sources");
    const paths = await writeCaptures([before, after]);
    for (const [left, right] of [
      [0, 1],
      [1, 0],
    ] as const) {
      expect(
        await compareScripts(cli, paths[left]!, paths[right]!),
      ).toMatchObject({ status: "unknown", total_changes: 0, changes: [] });
    }
  },
);
