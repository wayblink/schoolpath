import assert from "node:assert/strict";
import test from "node:test";
import {
  BAOSHAN_POLICY_SPECS,
  cleanOfficialHtml,
  isAllowedBaoshanPolicy,
  policyContent,
  policyDedupeKey,
} from "../scripts/backfill-baoshan-policy";

test("宝山政策只接受两条上海政府官方区级来源", () => {
  assert.equal(BAOSHAN_POLICY_SPECS.length, 2);
  for (const spec of BAOSHAN_POLICY_SPECS) {
    assert.equal(spec.scope, "district");
    assert.equal(spec.district, "宝山");
    assert.equal(spec.year, 2025);
    assert.match(spec.sourceUrl, /^https:\/\/www\.shanghai\.gov\.cn\/bsqywjy\/20250423\//);
    assert.equal(isAllowedBaoshanPolicy(spec), true);
  }
  assert.equal(
    isAllowedBaoshanPolicy({ ...BAOSHAN_POLICY_SPECS[0], sourceUrl: "https://example.com/policy" }),
    false,
  );
  assert.equal(isAllowedBaoshanPolicy({ ...BAOSHAN_POLICY_SPECS[0], scope: "school" }), false);
});

test("官方 HTML 清洗后保留标题、学校地址和招生范围等正文", () => {
  const html = `<html><head><title>无关</title><script>alert(1)</script></head><body><h2>宝山政策</h2><div id="ivs_content"><table><tr><th>学校名称</th><th>学校地址</th></tr><tr><td>甲小学</td><td>宝山区路1号</td></tr></table></div></body></html>`;
  const cleaned = cleanOfficialHtml(html);
  assert.match(cleaned, /学校名称/);
  assert.match(cleaned, /宝山区路1号/);
  assert.doesNotMatch(cleaned, /alert/);
  assert.ok(cleaned.length > 20);
});

test("政策正文带有来源元数据且幂等键稳定", () => {
  const spec = BAOSHAN_POLICY_SPECS[0];
  const content = policyContent(spec, "学校名称\n学校地址\n户籍对口学校就近入学的范围\n当年招生计划数");
  assert.match(content, /页面标题：2025年宝山区义务教育阶段学校校区范围与招生计划（小学）/);
  assert.match(content, /来源 URL：https:\/\/www\.shanghai\.gov\.cn/);
  assert.match(content, /学校地址/);
  assert.equal(policyDedupeKey(spec), `${spec.scope}|${spec.district}|${spec.year}|${spec.title}|${spec.sourceUrl}`);
});
