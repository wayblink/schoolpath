export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type SiteRecord = { type: string; key: string; district: string | null; raw: Json };

function object(value: Json | undefined): value is { [key: string]: Json } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pointer(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Preserve occurrences by JSON pointer; names alone are not source identities. */
export function siteRecords(url: string, data: Json): SiteRecord[] {
  const records: SiteRecord[] = [{ type: "site_json", key: "", district: null, raw: data }];
  const add = (type: string, key: string, district: string | null, raw: Json) => records.push({ type, key, district, raw });
  if (!object(data)) return records;
  if (object(data.districts)) {
    for (const [district, schools] of Object.entries(data.districts)) {
      const base = `/districts/${pointer(district)}`;
      add("map_district", base, district, schools);
      if (!Array.isArray(schools)) continue;
      schools.forEach((school, i) => {
        const key = `${base}/${i}`;
        add("map_school", key, district, school);
        if (!object(school)) return;
        for (const [field, type] of [["c", "map_community"], ["j", "map_enrollment_area"]]) {
          const values = school[field];
          if (Array.isArray(values)) values.forEach((value, n) => add(type, `${key}/${field}/${n}`, district, value));
        }
        if (school.m !== undefined) add("map_feeder", `${key}/m`, district, school.m);
        if (school.g !== undefined) {
          add("map_address_group", `${key}/g`, district, school.g);
          if (object(school.g)) {
            for (const [field, type] of [["p", "map_address"], ["r", "map_road"]]) {
              const values = school.g[field];
              if (Array.isArray(values)) values.forEach((value, n) => add(type, `${key}/g/${field}/${n}`, district, value));
            }
          }
        }
      });
    }
  }
  if (object(data.middles)) {
    for (const [name, school] of Object.entries(data.middles)) {
      const districts = object(school) && Array.isArray(school.districts) ? school.districts : [];
      add("map_middle", `/middles/${pointer(name)}`, districts.length === 1 && typeof districts[0] === "string" ? districts[0] : null, school);
    }
  }
  if (data.type === "FeatureCollection" && Array.isArray(data.features)) {
    data.features.forEach((feature, i) => {
      const district = object(feature) && object(feature.properties) && typeof feature.properties["区"] === "string" ? feature.properties["区"] : null;
      add(url.includes("GCJ02") ? "ring_geometry" : "committee_geometry", `/features/${i}`, district, feature);
    });
  } else if (!object(data.districts) && !object(data.middles)) {
    for (const [key, value] of Object.entries(data)) {
      const district = key.includes("|") ? key.split("|")[0] : /区$/.test(key) ? key : null;
      add("map_index_entry", `/${pointer(key)}`, district, value);
      if (Array.isArray(value)) value.forEach((item, i) => add("map_index_member", `/${pointer(key)}/${i}`, district, item));
      else if (object(value)) {
        for (const [name, item] of Object.entries(value)) add("map_index_member", `/${pointer(key)}/${pointer(name)}`, district, item);
      }
    }
  }
  return records;
}
