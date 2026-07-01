// Thin typed client for the dispatch API. The API key gates access; this is an
// internal operations console, so the key lives in the build env.
const BASE = (import.meta.env.VITE_API_BASE as string) || "http://localhost:4200";
const KEY = (import.meta.env.VITE_API_KEY as string) || "";

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.stringify((await res.json()).error ?? "");
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status} ${path} ${detail}`.trim());
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ---- types (mirror the backend) ----
export type Lane = { from: string; to: string };
export type Owner = {
  id: string;
  name: string;
  phone: string;
  vehicleTypes: string[];
  lanes: Lane[];
  active: boolean;
  createdAt: string;
};
export type OwnerInput = {
  name: string;
  phone: string;
  vehicleTypes: string[];
  lanes: Lane[];
};

export type LoadStatus = "DRAFT" | "CALLING" | "LOCKED" | "BOOKED" | "CLOSED";
export type Load = {
  id: string;
  fromLocation: string;
  toLocation: string;
  vehicleType: string;
  pickupDate: string;
  fixedPriceInr: number;
  status: LoadStatus;
  createdBy: string;
  createdAt: string;
};
export type LoadInput = {
  fromLocation: string;
  toLocation: string;
  vehicleType: string;
  pickupDate: string;
  fixedPriceInr: number;
  createdBy: string;
};

export type Suggestion = { owner: Owner; score: number };

export type CallStatus =
  | "QUEUED"
  | "DIALING"
  | "IN_PROGRESS"
  | "DONE"
  | "NO_ANSWER"
  | "FAILED";
export type CallAttempt = {
  id: string;
  loadId: string;
  ownerId: string;
  phone: string;
  flow: "offer" | "fixed_price_followup";
  status: CallStatus;
  elConversationId: string | null;
  attemptNo: number;
  createdAt: string;
  endedAt: string | null;
};

export type Availability = "YES" | "NO" | "CALLBACK";
export type Quote = {
  id: string;
  loadId: string;
  ownerId: string;
  callAttemptId: string | null;
  elConversationId: string | null;
  available: Availability;
  quotedPriceInr: number | null;
  acceptsFixed: boolean | null;
  vehicleType: string | null;
  note: string | null;
  createdAt: string;
};

export type ResolvedLocation = {
  raw: string;
  canonical: string | null;
  city: string | null;
  state: string | null;
  lat: number | null;
  lng: number | null;
  source: string;
};
export type DemandStatus =
  | "NEW"
  | "REJECTED"
  | "SOURCING"
  | "DRIVER_LOCKED"
  | "CUSTOMER_PENDING"
  | "BOOKED"
  | "DECLINED"
  | "CANCELLED";
export type DemandRequest = {
  id: string;
  customerPhone: string;
  fromText: string;
  toText: string;
  fromResolved: ResolvedLocation | null;
  toResolved: ResolvedLocation | null;
  vehicleType: string | null;
  offeredPriceInr: number | null;
  pickupDate: string | null;
  status: DemandStatus;
  loadId: string | null;
  winningOwnerId: string | null;
  lockedPriceInr: number | null;
  approvedAt: string | null;
  bookedAt: string | null;
  note: string | null;
  createdAt: string;
};

export const api = {
  // owners
  listOwners: () => req<Owner[]>("GET", "/owners"),
  createOwner: (i: OwnerInput) => req<Owner>("POST", "/owners", i),
  updateOwner: (id: string, patch: Partial<OwnerInput> & { active?: boolean }) =>
    req<Owner>("PATCH", `/owners/${id}`, patch),
  // loads
  listLoads: () => req<Load[]>("GET", "/loads"),
  createLoad: (i: LoadInput) => req<Load>("POST", "/loads", i),
  getLoad: (id: string) => req<Load>("GET", `/loads/${id}`),
  suggestedOwners: (id: string) => req<Suggestion[]>("GET", `/loads/${id}/suggested-owners`),
  fireCalls: (id: string, ownerIds: string[]) =>
    req<{ queued: number }>("POST", `/loads/${id}/call`, { ownerIds }),
  loadCalls: (id: string) => req<CallAttempt[]>("GET", `/loads/${id}/calls`),
  loadQuotes: (id: string) => req<Quote[]>("GET", `/loads/${id}/quotes`),
  followup: (id: string, ownerId: string) =>
    req<{ queued: number }>("POST", `/loads/${id}/owners/${ownerId}/followup`),
  // accept a driver at a chosen price (e.g. take their counter) → locks the load
  acceptOwner: (id: string, ownerId: string, priceInr: number) =>
    req<{ status: string; lockedPriceInr: number }>("POST", `/loads/${id}/owners/${ownerId}/accept`, { priceInr }),
  closeLoad: (id: string) => req<{ status: string }>("POST", `/loads/${id}/close`),
  // demand — the domino
  listDemand: (filter: { status?: DemandStatus; loadId?: string } = {}) => {
    const q = new URLSearchParams();
    if (filter.status) q.set("status", filter.status);
    if (filter.loadId) q.set("loadId", filter.loadId);
    const qs = q.toString();
    return req<DemandRequest[]>("GET", `/demand${qs ? `?${qs}` : ""}`);
  },
  // step 1 (manual fallback for incomplete demands): create load + call drivers
  approveDemand: (id: string, body: { fixedPriceInr?: number; vehicleType?: string; pickupDate?: string } = {}) =>
    req<{ loadId: string; calledOwners: number; status: string }>("POST", `/demand/${id}/approve`, body),
  rejectDemand: (id: string) => req<{ status: string }>("POST", `/demand/${id}/reject`),
  // step 3: company approves the locked driver's value → customer is called
  approveDriver: (id: string) =>
    req<{ status: string; loadId: string }>("POST", `/demand/${id}/approve-driver`),
  // step 4 (manual): mark the customer confirmed → booked
  bookDemand: (id: string) => req<{ status: string; loadId: string }>("POST", `/demand/${id}/book`),
  cancelDemand: (id: string) => req<{ status: string }>("POST", `/demand/${id}/cancel`),
  resourceDemand: (id: string) =>
    req<{ loadId: string; calledOwners: number; status: string }>("POST", `/demand/${id}/resource`),
};
