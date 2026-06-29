// Resolve a free-text (often spoken) location into a canonical place + coords.
// Prefers Google Geocoding (accurate for Indian addresses); falls back to the
// free Nominatim (OpenStreetMap) service, mirroring support-service. Best-effort:
// a miss returns the raw text with nulls rather than throwing.

export type ResolvedLocation = {
  raw: string;
  canonical: string | null;
  city: string | null;
  state: string | null;
  lat: number | null;
  lng: number | null;
  source: "google" | "nominatim" | "none";
};

type FetchFn = (url: string, init?: any) => Promise<{ json: () => Promise<any> }>;

export interface GeoResolver {
  resolveLocation(text: string): Promise<ResolvedLocation>;
}

function none(raw: string): ResolvedLocation {
  return { raw, canonical: null, city: null, state: null, lat: null, lng: null, source: "none" };
}

function pickGoogleComponent(components: any[], type: string): string | null {
  const c = components?.find((x) => Array.isArray(x.types) && x.types.includes(type));
  return c ? c.long_name : null;
}

export function buildGeoResolver(
  cfg: { googleMapsApiKey?: string },
  fetchFn: FetchFn = fetch as unknown as FetchFn,
): GeoResolver {
  async function google(text: string): Promise<ResolvedLocation | null> {
    if (!cfg.googleMapsApiKey) return null;
    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
        text,
      )}&region=in&key=${cfg.googleMapsApiKey}`;
      const data = await (await fetchFn(url)).json();
      if (data?.status !== "OK" || !data.results?.length) return null;
      const r = data.results[0];
      const comp = r.address_components || [];
      return {
        raw: text,
        canonical: r.formatted_address ?? null,
        city:
          pickGoogleComponent(comp, "locality") ||
          pickGoogleComponent(comp, "administrative_area_level_2"),
        state: pickGoogleComponent(comp, "administrative_area_level_1"),
        lat: r.geometry?.location?.lat ?? null,
        lng: r.geometry?.location?.lng ?? null,
        source: "google",
      };
    } catch {
      return null;
    }
  }

  async function nominatim(text: string): Promise<ResolvedLocation | null> {
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=1&countrycodes=in&q=${encodeURIComponent(
        text,
      )}`;
      const data = await (await fetchFn(url, {
        headers: { "User-Agent": "VehicleSourcing/1.0" },
      })).json();
      const hit = Array.isArray(data) ? data[0] : null;
      if (!hit) return null;
      const addr = hit.address || {};
      return {
        raw: text,
        canonical: hit.display_name ?? null,
        city: addr.city || addr.town || addr.village || addr.suburb || addr.county || null,
        state: addr.state || null,
        lat: hit.lat ? parseFloat(hit.lat) : null,
        lng: hit.lon ? parseFloat(hit.lon) : null,
        source: "nominatim",
      };
    } catch {
      return null;
    }
  }

  return {
    async resolveLocation(text: string): Promise<ResolvedLocation> {
      const trimmed = (text || "").trim();
      if (!trimmed) return none(text || "");
      return (await google(trimmed)) ?? (await nominatim(trimmed)) ?? none(trimmed);
    },
  };
}
