import assert from "node:assert/strict";
import test from "node:test";
import { MemoryMatchmaker } from "./matchmaker.js";

test("pairs visitors who share an interest and exposes that overlap", async () => {
  const matcher = new MemoryMatchmaker();
  await matcher.join("first", { language: "en", interests: ["music", "travel"] });
  const result = await matcher.join("second", { language: "en", interests: ["music"] });
  assert.equal(result.state, "matched");
  if (result.state === "matched") assert.deepEqual(result.match.sharedInterests, ["music"]);
});

test("does not pair visitors with incompatible selected interests", async () => {
  const matcher = new MemoryMatchmaker();
  await matcher.join("first", { language: "en", interests: ["music"] });
  const result = await matcher.join("second", { language: "en", interests: ["sports"] });
  assert.equal(result.state, "queued");
});

test("increments message ordering once per active match", async () => {
  const matcher = new MemoryMatchmaker();
  await matcher.join("first", { language: "en", interests: [] });
  await matcher.join("second", { language: "en", interests: [] });
  assert.equal((await matcher.nextMessage("first"))?.sequence, 1);
  assert.equal((await matcher.nextMessage("second"))?.sequence, 2);
});
