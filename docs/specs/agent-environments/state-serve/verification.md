# Verification

Verified base: e96484b10a1ae3dad8541d748599da32b447495e (main with #5319 and
#5349 merged into this branch), with the changes of this pass uncommitted.

Executed on the implementation worktree with Node v22.23.1 (the repository pins
24.18.0 in `.nvmrc`, which was not installed). Every check below ran as written
after the last source change, in this order.

- `npm run format` then `npm run format:check`: passed (4330 files).
- `npm run check:fast`: typecheck and lint passed (0 lint errors). The lint
  report holds no diagnostic in any file this change touches.
- `npx knip`: passed (exit 0, no findings).
- `npm run jscpd`: 3.37% duplicated lines over 3373 files (2800 clones), under
  the 3.5% gate. Five clones touch a changed file. The same jscpd arguments on
  a copy of the base tree's `src/` and `tests/` (identical to `HEAD` for every
  changed file) report 3.38% (2802 clones) with seven clones touching these
  files, which include all five, so this change adds none; the bundle tests'
  name-refusal pair and their oversized-manifest pair with
  `environmentCapacity.test.ts` are gone.
- `npm run scan:todos`: passed, no markers.
- `npm run docs:check`: the built documentation checks (6 tasks) and the README
  consistency conformance test (5 tests) passed.
- `npx vitest run --project domain --project services`: 347 files, 5946 tests
  passed, 5 pre-existing skips.
- `npm run build:cached`, then `npm run test:focused --` the serve CLI, MCP and
  process boundaries, the export CLI boundary, the CLI startup imports, the
  agentenv verifier identity boundary, the bundle package pin conformance test,
  the CI change scope boundary, the analysis-view CLI and MCP boundaries, and
  the `serveEnvironment`, `serveEnvironmentState`, `environmentCapacity` and
  `stateIntake` adapters tests: 14 files, 329 tests passed.
- After this file was written: `npm run format`, `npm run format:check` and
  `npm run docs:check` passed again.

A state catalog over the discovery budget, through the built CLI: a capture of
380 distinct `GET` paths projected with no template rules gives a 380-tool
read-only manifest whose replay catalog fits the reservation and whose state
catalog does not (300 to 360 such tools fit both, 380 to 460 only replay).
`environment-serve` with no flag logged the warning
`"code":"resource_constraint"` before binding, served 380 tools and stopped
with `state: {"served": false, "reason": "unavailable", "code":
"resource_constraint", …}`; with `--replay-only` it served the same 380 tools
and reported `replay-only`. `environment-export` of the same pair wrote a
bundle with `tool_count` 380, that `state`, `TOOL_COUNT = 380`, a replay check
and a README naming the code. The same export with `--name con` was refused
with `invalid_request` and created nothing.

`--replay-only` against main: a script loaded main's (`3fca2e0c`) sources for
the Grafana-shaped fixture in-process and compared them with the built CLI
serving the same files with `--replay-only` and `ENVIRONMENT_NAME=renamed`. The
card was byte-identical (11,131 bytes; its SHA-256, computed from main's
sources, is the one the mcp-boundary test now pins), `tools/list` matched
main's 19 tool names, descriptions and input schemas, five tool calls
(`get_users_by_id` with `2` and `999`, `get_annotations`,
`get_folders_by_uid`, `post_folders`) returned main's replay results, and
`data/get` answered `-32601`.

Startup, measured by starting the built CLI, timing until the listener
announcement and reading `process.resourceUsage()` at exit, with a load average
of 6 to 7 on a shared host. Medians of six interleaved runs:

| Capture                           | Mode                   | Listen ms | CPU ms | Peak RSS MiB |
| --------------------------------- | ---------------------- | --------- | ------ | ------------ |
| Grafana fixture (25 KB)           | `--replay-only`        | 542       | 819    | 265          |
| Grafana fixture (25 KB)           | default, derived state | 546       | 822    | 266          |
| Synthetic, 1,530 records (5.2 MB) | `--replay-only`        | 610       | 934    | 277          |
| Synthetic, 1,530 records (5.2 MB) | default, derived state | 789       | 1234   | 303          |

Deriving the state costs about 180 ms, 300 ms CPU and 26 MiB peak RSS on the
5.2 MB capture and is within noise on the fixture. The state catalog check runs
before deriving and takes about 1.4 ms in-process for the 350-tool manifest of
the services test, which it refuses without deriving.

Not covered here: agent token usage (no agent task was run), a real AgentEnv
framework run against a bundle or a state-served environment
(`npm run verify:agentenv:environment` needs Docker and the pinned framework),
a real-world capture, a real `https://` download (tests inject the fetcher or
stub `fetch`), and write effects, which are a later increment.
