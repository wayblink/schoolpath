import assert from "node:assert/strict";
import test from "node:test";
import { cleanFeederText, detectAdmissionMode, parseFeederRow, splitCandidates } from "../lib/pathways/parse";

test("cleanFeederText strips full-width and half-width parenthetical notes", () => {
  assert.equal(cleanFeederText("虹桥/娄山/天山初中(派位)"), "虹桥/娄山/天山初中");
  assert.equal(cleanFeederText("田林三中（部分对口）/中国中学（部分对口）"), "田林三中/中国中学");
  assert.equal(cleanFeederText("市光学校(初中部)"), "市光学校");
  assert.equal(cleanFeederText("风华初级中学"), "风华初级中学");
});

test("splitCandidates splits on slash and enumeration comma", () => {
  assert.deepEqual(splitCandidates("虹桥/娄山/天山初中"), ["虹桥", "娄山", "天山初中"]);
  assert.deepEqual(splitCandidates("市西初级、七一中学"), ["市西初级", "七一中学"]);
  assert.deepEqual(splitCandidates("育才初级/培明学校"), ["育才初级", "培明学校"]);
  assert.deepEqual(splitCandidates(""), []);
});

test("detectAdmissionMode classifies feeder text by keyword", () => {
  assert.equal(detectAdmissionMode("本校直升"), "direct");
  assert.equal(detectAdmissionMode("西南位育附属实验学校(直升)"), "direct");
  assert.equal(detectAdmissionMode("虹桥/娄山/天山初中(派位)"), "placement");
  assert.equal(detectAdmissionMode("零陵/南洋(派位+对口)"), "placement");
  assert.equal(detectAdmissionMode("田林三中(部分对口)/中国中学(部分对口)"), "partial");
  assert.equal(detectAdmissionMode("徐教院附中(对口)"), "assign");
  assert.equal(detectAdmissionMode("户籍对口(按地段)"), "assign");
  assert.equal(detectAdmissionMode("风华初级中学"), "unknown");
});

test("parseFeederRow combines cleaning, splitting and mode detection", () => {
  const row = parseFeederRow("白玉兰小学", "虹桥/娄山/天山初中(派位)");
  assert.equal(row.primaryName, "白玉兰小学");
  assert.equal(row.rawText, "虹桥/娄山/天山初中(派位)");
  assert.equal(row.admissionMode, "placement");
  assert.deepEqual(row.candidates, ["虹桥", "娄山", "天山初中"]);
});
