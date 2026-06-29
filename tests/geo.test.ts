import { describe, it, expect, vi } from "vitest";
import { buildGeoResolver } from "../src/geo/geo.js";

const googleResp = {
  status: "OK",
  results: [
    {
      formatted_address: "Andheri East, Mumbai, Maharashtra, India",
      geometry: { location: { lat: 19.1178, lng: 72.8631 } },
      address_components: [
        { long_name: "Andheri East", types: ["sublocality"] },
        { long_name: "Mumbai", types: ["locality"] },
        { long_name: "Maharashtra", types: ["administrative_area_level_1"] },
      ],
    },
  ],
};

const nominatimResp = [
  {
    display_name: "Pune, Maharashtra, India",
    lat: "18.52",
    lon: "73.85",
    address: { city: "Pune", state: "Maharashtra" },
  },
];

const json = (body: any) => ({ json: async () => body });

describe("geo resolveLocation", () => {
  it("uses Google when a key is set", async () => {
    const fetchFn = vi.fn().mockResolvedValue(json(googleResp));
    const geo = buildGeoResolver({ googleMapsApiKey: "k" }, fetchFn as any);
    const r = await geo.resolveLocation("andheri east");
    expect(r.source).toBe("google");
    expect(r.canonical).toContain("Andheri East");
    expect(r.city).toBe("Mumbai");
    expect(r.state).toBe("Maharashtra");
    expect(r.lat).toBeCloseTo(19.1178);
    expect(fetchFn.mock.calls[0][0]).toContain("maps.googleapis.com");
  });

  it("falls back to Nominatim when no Google key", async () => {
    const fetchFn = vi.fn().mockResolvedValue(json(nominatimResp));
    const geo = buildGeoResolver({}, fetchFn as any);
    const r = await geo.resolveLocation("pune");
    expect(r.source).toBe("nominatim");
    expect(r.city).toBe("Pune");
    expect(fetchFn.mock.calls[0][0]).toContain("nominatim");
  });

  it("falls back to Nominatim when Google returns ZERO_RESULTS", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(json({ status: "ZERO_RESULTS", results: [] }))
      .mockResolvedValueOnce(json(nominatimResp));
    const geo = buildGeoResolver({ googleMapsApiKey: "k" }, fetchFn as any);
    const r = await geo.resolveLocation("somewhere");
    expect(r.source).toBe("nominatim");
  });

  it("returns source none on total miss (best-effort, keeps raw)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(json([]));
    const geo = buildGeoResolver({ googleMapsApiKey: "k" }, fetchFn as any);
    // google returns non-OK shape (empty array → status undefined) then nominatim empty
    const r = await geo.resolveLocation("zzz nowhere zzz");
    expect(r.source).toBe("none");
    expect(r.raw).toBe("zzz nowhere zzz");
    expect(r.canonical).toBeNull();
  });

  it("returns none for blank input without fetching", async () => {
    const fetchFn = vi.fn();
    const geo = buildGeoResolver({ googleMapsApiKey: "k" }, fetchFn as any);
    const r = await geo.resolveLocation("   ");
    expect(r.source).toBe("none");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
