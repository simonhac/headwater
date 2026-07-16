import { describe, it, expect } from "vitest";
import { renderStationsPage } from "@/ui/stations";
import type { StationResolution } from "@/lib/meltwater/stations";

const rows: StationResolution[] = [
  // render-resolved: has a resolution time + a known attempt count
  { code: "8540", name: "3AW", first_sighting: 1_783_458_412_449, sightings: 4, resolved_at: 1_783_458_999_999, attempts: 3 },
  // hand-seeded (migration): named but no timestamp / attempts
  { code: "8645", name: "702 ABC Sydney", first_sighting: 1_783_458_500_000, sightings: 2, resolved_at: null, attempts: null },
  // authorName-trust: named render-free (0 attempts)
  { code: "11655", name: "ABC Kimberley", first_sighting: 1_783_458_600_000, sightings: 5, resolved_at: 1_783_458_600_000, attempts: 0 },
  // still unresolved
  { code: "9999", name: null, first_sighting: 1_783_459_000_000, sightings: 1, resolved_at: null, attempts: null },
];

describe("renderStationsPage", () => {
  const html = renderStationsPage(rows);

  it("summarises resolved vs pending", () => {
    expect(html).toContain("4 codes · 3 resolved · 1 pending");
  });

  it("shows resolved names and marks an unresolved code", () => {
    expect(html).toContain("3AW");
    expect(html).toContain("702 ABC Sydney");
    expect(html).toContain("ABC Kimberley");
    expect(html).toContain("unresolved"); // code 9999 has no name
  });

  it("distinguishes seeded (no timestamp) from untracked attempts", () => {
    expect(html).toContain("seeded"); // 702 ABC Sydney: named but resolved_at null
    expect(html).toContain(">—<"); // untracked attempts render as an em dash
  });

  it("renders all six requested columns plus a status pill", () => {
    for (const h of ["Code", "Resolved name", "First sighting", "Resolved", "Attempts", "Sightings"]) {
      expect(html).toContain(h);
    }
    expect(html).toContain("resolved"); // status pill class/text
    expect(html).toContain("pending");
  });

  it("handles an empty list", () => {
    expect(renderStationsPage([])).toContain("No broadcast station codes seen yet.");
  });
});
