import assert from "node:assert/strict";
import test from "node:test";
import { eligibleCoordinateCopy, REVIEWED_COPIES, type ReviewedCoordinateCopy } from "../scripts/backfill-reviewed-duplicate-school-coordinates";

const review: ReviewedCoordinateCopy = REVIEWED_COPIES[0]!;
const source = { id: 3912, name: review.name, district: review.district, type: review.type, address: review.address, lat: 31.122, lng: 121.428, attrs: null };

test("coordinate copy requires exact reviewed identity and only fills an empty target", () => {
  const target = { id: 5638, name: review.name, district: review.district, type: review.type, address: review.address, lat: null, lng: null, attrs: null };
  assert.equal(eligibleCoordinateCopy(source, target, review), true);
  assert.equal(eligibleCoordinateCopy(source, { ...target, lat: 31.123 }, review), false);
  assert.equal(eligibleCoordinateCopy(source, { ...target, address: "其他地址" }, review), false);
  assert.equal(eligibleCoordinateCopy(source, { ...target, district: "浦东" }, review), false);
});
