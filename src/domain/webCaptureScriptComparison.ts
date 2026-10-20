import type { WebPageInspection } from "./browserObservationSchemas.js";
import { digestCanonicalValue } from "./canonicalDigest.js";
import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";
import type {
  WebCaptureChange,
  WebCaptureDimension,
} from "./webCaptureDiffSchemas.js";

type Script = WebPageInspection["scripts"]["items"][number];
type ScriptPair = {
  readonly before: Script | undefined;
  readonly after: Script | undefined;
};

/** Capture-local source ordinals do not establish cross-capture identity. */
export const compareWebCaptureScripts = (
  before: readonly Script[],
  after: readonly Script[],
  inventoryComplete: boolean,
): WebCaptureDimension => {
  const beforeGroups = scriptGroups(before);
  const afterGroups = scriptGroups(after);
  const changes: WebCaptureChange[] = [];
  let contentComplete = true;
  for (const base of new Set([...beforeGroups.keys(), ...afterGroups.keys()])) {
    const left = beforeGroups.get(base) ?? [];
    const right = afterGroups.get(base) ?? [];
    const sourceComparable =
      inventoryComplete &&
      [...left, ...right].every((script) => script.source.included);
    const pairs = matchScripts(
      left,
      right,
      sourceComparable
        ? (script) => scriptFingerprint(script, true)
        : (script) => script.script_key,
    );
    for (const pair of pairs) {
      if (pair.before === undefined) {
        if (inventoryComplete && pair.after !== undefined)
          changes.push({ identity: pair.after.script_key, change: "added" });
      } else if (pair.after === undefined) {
        if (inventoryComplete)
          changes.push({ identity: pair.before.script_key, change: "removed" });
      } else {
        if (
          !sourceComparable &&
          (pair.before.cdp_hash === null || pair.after.cdp_hash === null)
        )
          contentComplete = false;
        if (
          scriptFingerprint(pair.before, sourceComparable) !==
          scriptFingerprint(pair.after, sourceComparable)
        )
          changes.push({
            identity: pair.before.script_key,
            change: "modified",
          });
      }
    }
  }
  changes.sort(
    (left, right) =>
      compareUnicodeCodePoints(left.identity, right.identity) ||
      compareUnicodeCodePoints(left.change, right.change),
  );
  if (changes.length > 0)
    return {
      status: "changed",
      total_changes: changes.length,
      changes,
      reason: null,
    };
  return inventoryComplete && contentComplete
    ? { status: "unchanged", total_changes: 0, changes: [], reason: null }
    : {
        status: "unknown",
        total_changes: 0,
        changes: [],
        reason:
          "Script inventory or content identity was incomplete in at least one observation.",
      };
};

const scriptGroups = (scripts: readonly Script[]): Map<string, Script[]> => {
  const groups = new Map<string, Script[]>();
  for (const script of scripts) {
    const base = script.script_key.replace(/_[0-9]+$/u, "");
    const group = groups.get(base) ?? [];
    group.push(script);
    groups.set(base, group);
  }
  for (const group of groups.values())
    group.sort((left, right) =>
      compareUnicodeCodePoints(left.script_key, right.script_key),
    );
  return groups;
};

const matchScripts = (
  before: readonly Script[],
  after: readonly Script[],
  identity: (script: Script) => string,
): ScriptPair[] => {
  const remainingAfter = new Map<string, Script[]>();
  for (const script of [...after].reverse()) {
    const key = identity(script);
    const bucket = remainingAfter.get(key) ?? [];
    bucket.push(script);
    remainingAfter.set(key, bucket);
  }
  const pairs: ScriptPair[] = [];
  const unmatchedBefore: Script[] = [];
  for (const script of before) {
    const matched = remainingAfter.get(identity(script))?.pop();
    if (matched === undefined) unmatchedBefore.push(script);
    else pairs.push({ before: script, after: matched });
  }
  const unmatchedAfter = [...remainingAfter.values()]
    .flat()
    .sort((left, right) =>
      compareUnicodeCodePoints(left.script_key, right.script_key),
    );
  // Pair only residual occurrences after cancelling identical content counts.
  for (
    let index = 0;
    index < Math.max(unmatchedBefore.length, unmatchedAfter.length);
    index++
  )
    pairs.push({
      before: unmatchedBefore[index],
      after: unmatchedAfter[index],
    });
  return pairs;
};

const scriptFingerprint = (script: Script, includeSource: boolean): string =>
  digestCanonicalValue({
    url: script.url,
    cdp_hash: script.cdp_hash,
    length: script.length,
    is_module: script.is_module,
    language: script.language,
    source_map_url: script.source_map_url,
    source_sha256:
      includeSource && script.source.included
        ? script.source.artifact.sha256
        : null,
  });
