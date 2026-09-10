import assert from "node:assert/strict";
import test from "node:test";
import {
  baiduMercatorToGcj02,
  extractBaiduMobileDetail,
  isStrictBaiduMobileSchoolMatch,
} from "../scripts/backfill-school-locations-baidu-mobile";

const school = {
  id: 6210,
  name: "上海市浦东新区浦三路小学",
  district: "浦东",
  type: "primary" as const,
  address: "兰陵路21号",
  lat: null,
  lng: null,
};

const mobileHtml = `<!doctype html><script>var data = ${JSON.stringify({
  content: {
    uid: "uid-6210",
    name: school.name,
    addr: "上海市浦东新区兰陵路21号",
    city_name: "上海市",
    di_tag: "教育培训;小学",
    diPointX: 1352805339,
    diPointY: 363660384,
  },
})};</script>`;

test("extracts a Baidu mobile detail payload and converts coordinates", () => {
  const detail = extractBaiduMobileDetail(mobileHtml);
  assert.equal(detail?.name, school.name);
  assert.equal(detail?.address, "上海市浦东新区兰陵路21号");
  assert.equal(detail?.uid, "uid-6210");
  assert.ok(detail?.diPointX && detail.diPointY);

  const coordinate = baiduMercatorToGcj02(detail!.diPointX!, detail!.diPointY!);
  assert.ok(coordinate.lat > 30.65 && coordinate.lat < 31.9);
  assert.ok(coordinate.lng > 120.85 && coordinate.lng < 122.15);
});

test("accepts only exact same-district school details", () => {
  const detail = extractBaiduMobileDetail(mobileHtml)!;
  assert.equal(isStrictBaiduMobileSchoolMatch(school, detail), true);
  assert.equal(
    isStrictBaiduMobileSchoolMatch(school, { ...detail, name: "上海市浦东新区浦三路小学-西南门" }),
    false,
  );
  assert.equal(
    isStrictBaiduMobileSchoolMatch(school, { ...detail, address: "上海市闵行区兰陵路21号" }),
    false,
  );
  assert.equal(
    isStrictBaiduMobileSchoolMatch({ ...school, type: "middle" }, detail),
    false,
  );
});
