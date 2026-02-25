// @ts-nocheck
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// --- Load .env early ---
try {
  const fs = require("fs");
  const path = require("path");
  const envPath = path.resolve(__dirname, "..", ".env");
  const envContent = fs.readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1].trim()]) {
      process.env[match[1].trim()] = match[2].trim();
    }
  }
} catch {}

// --- Geotab API Client ---

const GEOTAB_SERVER = process.env.GEOTAB_SERVER || "my.geotab.com";
const GEOTAB_DATABASE = process.env.GEOTAB_DATABASE || "";
const GEOTAB_USERNAME = process.env.GEOTAB_USERNAME || "";
const GEOTAB_PASSWORD = process.env.GEOTAB_PASSWORD || "";
const API_URL = `https://${GEOTAB_SERVER}/apiv1`;

let sessionId: string | null = null;

async function authenticate(): Promise<void> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "Authenticate",
      params: {
        database: GEOTAB_DATABASE,
        userName: GEOTAB_USERNAME,
        password: GEOTAB_PASSWORD,
      },
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Auth failed: ${JSON.stringify(data.error)}`);
  sessionId = data.result.credentials.sessionId;
}

async function geotabCall(method: string, params: Record<string, any> = {}): Promise<any> {
  if (!sessionId) await authenticate();

  const makeCall = async () => {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method,
        params: {
          ...params,
          credentials: {
            database: GEOTAB_DATABASE,
            sessionId,
            userName: GEOTAB_USERNAME,
          },
        },
      }),
    });
    return res.json();
  };

  let data = await makeCall();
  if (data.error?.errors?.[0]?.name === "InvalidUserException" || data.error?.message?.includes("session")) {
    await authenticate();
    data = await makeCall();
  }
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.result;
}

async function multiCall(calls: Array<{ method: string; params: Record<string, any> }>): Promise<any[]> {
  if (!sessionId) await authenticate();
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "ExecuteMultiCall",
      params: {
        calls: calls.map(c => ({ method: c.method, params: c.params })),
        credentials: {
          database: GEOTAB_DATABASE,
          sessionId,
          userName: GEOTAB_USERNAME,
        },
      },
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.result;
}

// --- Helpers ---

function dateOrDefault(d: string | undefined, daysAgo: number): string {
  if (d) return new Date(d).toISOString();
  const dt = new Date();
  dt.setDate(dt.getDate() - daysAgo);
  return dt.toISOString();
}

// --- MCP Server ---

const server = new McpServer({
  name: "claw-fleet-manager",
  version: "1.0.0",
});

// ---- get_vehicles ----
server.tool(
  "get_vehicles",
  "List all vehicles with name, status, location, and driver info",
  { search: z.string().optional().describe("Filter by vehicle name"), limit: z.number().optional().describe("Max results") },
  async ({ search, limit }) => {
    const devices: any[] = await geotabCall("Get", { typeName: "Device", search: search ? { name: `%${search}%` } : {} });
    const deviceInfos: any[] = await geotabCall("Get", { typeName: "DeviceStatusInfo" });

    const infoMap = new Map(deviceInfos.map((i: any) => [i.device?.id, i]));
    let results = devices.map((d: any) => {
      const info = infoMap.get(d.id);
      return {
        id: d.id,
        name: d.name,
        vin: d.vehicleIdentificationNumber || null,
        licensePlate: d.licensePlate || null,
        speed: info?.speed ?? null,
        latitude: info?.latitude ?? null,
        longitude: info?.longitude ?? null,
        isDeviceCommunicating: info?.isDeviceCommunicating ?? null,
        isDriving: info?.isDriving ?? null,
        driver: info?.driver?.id !== "UnknownDriverId" ? info?.driver?.id : null,
        bearing: info?.bearing ?? null,
        currentStateDuration: info?.currentStateDuration ?? null,
      };
    });

    if (limit) results = results.slice(0, limit);
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  }
);

// ---- get_vehicle_location ----
server.tool(
  "get_vehicle_location",
  "Get a single vehicle's current location, speed, bearing, and address",
  { vehicle: z.string().describe("Vehicle name or ID") },
  async ({ vehicle }) => {
    const devices: any[] = await geotabCall("Get", { typeName: "Device", search: { name: `%${vehicle}%` } });
    if (!devices.length) return { content: [{ type: "text", text: `No vehicle found matching "${vehicle}"` }] };
    const dev = devices[0];
    const infos: any[] = await geotabCall("Get", { typeName: "DeviceStatusInfo", search: { deviceSearch: { id: dev.id } } });
    const info = infos[0];
    const result = {
      vehicle: dev.name,
      id: dev.id,
      latitude: info?.latitude,
      longitude: info?.longitude,
      speed: info?.speed,
      bearing: info?.bearing,
      isDriving: info?.isDriving,
      isDeviceCommunicating: info?.isDeviceCommunicating,
      timestamp: info?.dateTime,
      driver: info?.driver?.id !== "UnknownDriverId" ? info?.driver?.id : null,
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ---- get_vehicle_status ----
server.tool(
  "get_vehicle_status",
  "Get vehicle engine status, odometer, fuel level, battery voltage",
  { vehicle: z.string().describe("Vehicle name or ID") },
  async ({ vehicle }) => {
    const devices: any[] = await geotabCall("Get", { typeName: "Device", search: { name: `%${vehicle}%` } });
    if (!devices.length) return { content: [{ type: "text", text: `No vehicle found matching "${vehicle}"` }] };
    const dev = devices[0];

    const [infos, statusData] = await Promise.all([
      geotabCall("Get", { typeName: "DeviceStatusInfo", search: { deviceSearch: { id: dev.id } } }),
      geotabCall("Get", {
        typeName: "StatusData",
        search: {
          deviceSearch: { id: dev.id },
          fromDate: dateOrDefault(undefined, 1),
          toDate: new Date().toISOString(),
        },
        resultsLimit: 100,
      }),
    ]);

    const info = infos[0];
    // Extract known diagnostic IDs
    const diagMap: Record<string, any> = {};
    for (const s of statusData || []) {
      const diagName = s.diagnostic?.id || "";
      if (!diagMap[diagName] || new Date(s.dateTime) > new Date(diagMap[diagName].dateTime)) {
        diagMap[diagName] = s;
      }
    }

    const result = {
      vehicle: dev.name,
      id: dev.id,
      isDriving: info?.isDriving,
      isDeviceCommunicating: info?.isDeviceCommunicating,
      speed: info?.speed,
      odometer: dev.odometer ?? null,
      engineHours: dev.engineHours ?? null,
      latestDiagnostics: Object.entries(diagMap).slice(0, 20).map(([k, v]: [string, any]) => ({
        diagnostic: k,
        value: v.data,
        unit: v.diagnostic?.unitOfMeasure,
        timestamp: v.dateTime,
      })),
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ---- get_trips ----
server.tool(
  "get_trips",
  "Get trip history with distance, duration, fuel used",
  {
    vehicle: z.string().optional().describe("Vehicle name or ID"),
    from: z.string().optional().describe("Start date (ISO)"),
    to: z.string().optional().describe("End date (ISO)"),
    limit: z.number().optional().describe("Max results (default 50)"),
  },
  async ({ vehicle, from, to, limit }) => {
    const search: any = {
      fromDate: dateOrDefault(from, 7),
      toDate: to ? new Date(to).toISOString() : new Date().toISOString(),
    };
    if (vehicle) {
      const devices: any[] = await geotabCall("Get", { typeName: "Device", search: { name: `%${vehicle}%` } });
      if (!devices.length) return { content: [{ type: "text", text: `No vehicle found matching "${vehicle}"` }] };
      search.deviceSearch = { id: devices[0].id };
    }
    const trips: any[] = await geotabCall("Get", { typeName: "Trip", search, resultsLimit: limit || 50 });
    const results = trips.map((t: any) => ({
      id: t.id,
      device: t.device?.id,
      driver: t.driver?.id !== "UnknownDriverId" ? t.driver?.id : null,
      start: t.start,
      stop: t.stop,
      distance: t.distance, // km
      drivingDuration: t.drivingDuration,
      idleDuration: t.idleDuration,
      stopDuration: t.stopDuration,
      maxSpeed: t.speedRange,
      nextTripStart: t.nextTripStart,
    }));
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  }
);

// ---- get_speed_events ----
server.tool(
  "get_speed_events",
  "Get speeding violations across the fleet",
  {
    from: z.string().optional().describe("Start date (ISO)"),
    to: z.string().optional().describe("End date (ISO)"),
    vehicle: z.string().optional().describe("Filter by vehicle name"),
    limit: z.number().optional().describe("Max results (default 50)"),
  },
  async ({ from, to, vehicle, limit }) => {
    // Get speed-related rules first
    const rules: any[] = await geotabCall("Get", { typeName: "Rule" });
    const speedRuleIds = rules
      .filter((r: any) => /speed/i.test(r.name || ""))
      .map((r: any) => r.id);

    const search: any = {
      fromDate: dateOrDefault(from, 7),
      toDate: to ? new Date(to).toISOString() : new Date().toISOString(),
    };
    if (vehicle) {
      const devices: any[] = await geotabCall("Get", { typeName: "Device", search: { name: `%${vehicle}%` } });
      if (devices.length) search.deviceSearch = { id: devices[0].id };
    }
    if (speedRuleIds.length) search.ruleSearch = { id: speedRuleIds[0] };

    const events: any[] = await geotabCall("Get", { typeName: "ExceptionEvent", search, resultsLimit: limit || 50 });
    const results = events.map((e: any) => ({
      id: e.id,
      device: e.device?.id,
      driver: e.driver?.id !== "UnknownDriverId" ? e.driver?.id : null,
      rule: e.rule?.id,
      startTime: e.activeFrom,
      endTime: e.activeTo,
      duration: e.duration,
      distance: e.distance,
    }));
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  }
);

// ---- get_safety_events ----
server.tool(
  "get_safety_events",
  "Get safety events: harsh braking, acceleration, cornering, seatbelt",
  {
    from: z.string().optional(),
    to: z.string().optional(),
    vehicle: z.string().optional(),
    limit: z.number().optional(),
  },
  async ({ from, to, vehicle, limit }) => {
    const search: any = {
      fromDate: dateOrDefault(from, 7),
      toDate: to ? new Date(to).toISOString() : new Date().toISOString(),
    };
    if (vehicle) {
      const devices: any[] = await geotabCall("Get", { typeName: "Device", search: { name: `%${vehicle}%` } });
      if (devices.length) search.deviceSearch = { id: devices[0].id };
    }
    const events: any[] = await geotabCall("Get", { typeName: "ExceptionEvent", search, resultsLimit: limit || 100 });

    // Get rules to label them
    const ruleIds = [...new Set(events.map((e: any) => e.rule?.id).filter(Boolean))];
    let ruleMap: Map<string, string> = new Map();
    if (ruleIds.length) {
      const rules: any[] = await geotabCall("Get", { typeName: "Rule" });
      ruleMap = new Map(rules.map((r: any) => [r.id, r.name]));
    }

    const results = events.map((e: any) => ({
      id: e.id,
      device: e.device?.id,
      driver: e.driver?.id !== "UnknownDriverId" ? e.driver?.id : null,
      rule: ruleMap.get(e.rule?.id) || e.rule?.id,
      startTime: e.activeFrom,
      endTime: e.activeTo,
      duration: e.duration,
      distance: e.distance,
    }));
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  }
);

// ---- get_driver_safety_scores ----
server.tool(
  "get_driver_safety_scores",
  "Get driver safety performance scores based on exception events",
  {
    from: z.string().optional(),
    to: z.string().optional(),
  },
  async ({ from, to }) => {
    const fromDate = dateOrDefault(from, 30);
    const toDate = to ? new Date(to).toISOString() : new Date().toISOString();

    const events: any[] = await geotabCall("Get", {
      typeName: "ExceptionEvent",
      search: { fromDate, toDate },
      resultsLimit: 5000,
    });

    // Group by driver
    const driverEvents: Record<string, any[]> = {};
    for (const e of events) {
      const driverId = e.driver?.id || "Unknown";
      if (!driverEvents[driverId]) driverEvents[driverId] = [];
      driverEvents[driverId].push(e);
    }

    const scores = Object.entries(driverEvents).map(([driver, evts]) => ({
      driver,
      totalEvents: evts.length,
      // Simple score: fewer events = better (100 - events, min 0)
      score: Math.max(0, 100 - evts.length),
      eventsByRule: evts.reduce((acc: Record<string, number>, e: any) => {
        const rule = e.rule?.id || "unknown";
        acc[rule] = (acc[rule] || 0) + 1;
        return acc;
      }, {}),
    }));

    scores.sort((a, b) => b.score - a.score);
    return { content: [{ type: "text", text: JSON.stringify(scores, null, 2) }] };
  }
);

// ---- get_fault_codes ----
server.tool(
  "get_fault_codes",
  "Get diagnostic trouble codes (DTCs) across the fleet",
  {
    vehicle: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    limit: z.number().optional(),
  },
  async ({ vehicle, from, to, limit }) => {
    const search: any = {
      fromDate: dateOrDefault(from, 30),
      toDate: to ? new Date(to).toISOString() : new Date().toISOString(),
    };
    if (vehicle) {
      const devices: any[] = await geotabCall("Get", { typeName: "Device", search: { name: `%${vehicle}%` } });
      if (devices.length) search.deviceSearch = { id: devices[0].id };
    }
    const faults: any[] = await geotabCall("Get", { typeName: "FaultData", search, resultsLimit: limit || 100 });
    const results = faults.map((f: any) => ({
      id: f.id,
      device: f.device?.id,
      diagnostic: f.diagnostic?.id,
      failureMode: f.failureMode?.id,
      controller: f.controller?.id,
      dateTime: f.dateTime,
      count: f.count,
      dismissUser: f.dismissUser,
    }));
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  }
);

// ---- get_zones ----
server.tool(
  "get_zones",
  "Get geofence zones",
  { type: z.string().optional().describe("Filter by zone type") },
  async ({ type }) => {
    const zones: any[] = await geotabCall("Get", { typeName: "Zone" });
    let results = zones.map((z: any) => ({
      id: z.id,
      name: z.name,
      displayed: z.displayed,
      activeFrom: z.activeFrom,
      activeTo: z.activeTo,
      groups: z.groups?.map((g: any) => g.id),
      points: z.points?.length || 0,
      centroid: z.centroid,
    }));
    if (type) results = results.filter(r => r.name?.toLowerCase().includes(type.toLowerCase()));
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  }
);

// ---- get_fuel_usage ----
server.tool(
  "get_fuel_usage",
  "Get fuel consumption data for vehicles",
  {
    vehicle: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
  },
  async ({ vehicle, from, to }) => {
    // Use trips as proxy for fuel usage (Geotab doesn't have a direct fuel usage entity)
    const search: any = {
      fromDate: dateOrDefault(from, 7),
      toDate: to ? new Date(to).toISOString() : new Date().toISOString(),
    };
    if (vehicle) {
      const devices: any[] = await geotabCall("Get", { typeName: "Device", search: { name: `%${vehicle}%` } });
      if (devices.length) search.deviceSearch = { id: devices[0].id };
    }
    const trips: any[] = await geotabCall("Get", { typeName: "Trip", search, resultsLimit: 500 });

    // Aggregate by device
    const byDevice: Record<string, { distance: number; trips: number; idleDuration: string; drivingDuration: string }> = {};
    for (const t of trips) {
      const devId = t.device?.id || "unknown";
      if (!byDevice[devId]) byDevice[devId] = { distance: 0, trips: 0, idleDuration: "PT0S", drivingDuration: "PT0S" };
      byDevice[devId].distance += t.distance || 0;
      byDevice[devId].trips += 1;
    }

    const results = Object.entries(byDevice).map(([device, data]) => ({
      device,
      totalDistanceKm: Math.round(data.distance * 100) / 100,
      tripCount: data.trips,
      // Note: actual fuel data requires FuelTransaction or diagnostic-based fuel level tracking
      note: "Fuel volume requires FuelTransaction data or diagnostic fuel level sensors. Showing distance-based summary.",
    }));

    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  }
);

// ---- get_idle_time ----
server.tool(
  "get_idle_time",
  "Get idle time reports for vehicles/drivers",
  {
    vehicle: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
  },
  async ({ vehicle, from, to }) => {
    const search: any = {
      fromDate: dateOrDefault(from, 7),
      toDate: to ? new Date(to).toISOString() : new Date().toISOString(),
    };
    if (vehicle) {
      const devices: any[] = await geotabCall("Get", { typeName: "Device", search: { name: `%${vehicle}%` } });
      if (devices.length) search.deviceSearch = { id: devices[0].id };
    }
    const trips: any[] = await geotabCall("Get", { typeName: "Trip", search, resultsLimit: 500 });

    // Aggregate idle time by device
    const byDevice: Record<string, { idleDuration: number; tripCount: number; totalDistance: number }> = {};
    for (const t of trips) {
      const devId = t.device?.id || "unknown";
      if (!byDevice[devId]) byDevice[devId] = { idleDuration: 0, tripCount: 0, totalDistance: 0 };
      // Parse ISO duration for idle (approximate)
      const idleMatch = t.idleDuration?.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
      if (idleMatch) {
        byDevice[devId].idleDuration += (parseInt(idleMatch[1] || "0") * 3600) + (parseInt(idleMatch[2] || "0") * 60) + parseInt(idleMatch[3] || "0");
      }
      byDevice[devId].tripCount += 1;
      byDevice[devId].totalDistance += t.distance || 0;
    }

    const results = Object.entries(byDevice).map(([device, data]) => ({
      device,
      idleTimeSeconds: data.idleDuration,
      idleTimeFormatted: `${Math.floor(data.idleDuration / 3600)}h ${Math.floor((data.idleDuration % 3600) / 60)}m`,
      tripCount: data.tripCount,
      totalDistanceKm: Math.round(data.totalDistance * 100) / 100,
    }));

    results.sort((a, b) => b.idleTimeSeconds - a.idleTimeSeconds);
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  }
);

// ---- get_fleet_summary ----
server.tool(
  "get_fleet_summary",
  "Get overall fleet summary statistics",
  {
    from: z.string().optional(),
    to: z.string().optional(),
  },
  async ({ from, to }) => {
    const fromDate = dateOrDefault(from, 7);
    const toDate = to ? new Date(to).toISOString() : new Date().toISOString();

    const [devices, statusInfos, trips, events, faults] = await Promise.all([
      geotabCall("Get", { typeName: "Device" }),
      geotabCall("Get", { typeName: "DeviceStatusInfo" }),
      geotabCall("Get", { typeName: "Trip", search: { fromDate, toDate }, resultsLimit: 1000 }),
      geotabCall("Get", { typeName: "ExceptionEvent", search: { fromDate, toDate }, resultsLimit: 1000 }),
      geotabCall("Get", { typeName: "FaultData", search: { fromDate, toDate }, resultsLimit: 500 }),
    ]);

    const driving = statusInfos.filter((s: any) => s.isDriving);
    const communicating = statusInfos.filter((s: any) => s.isDeviceCommunicating);
    const totalDistance = trips.reduce((sum: number, t: any) => sum + (t.distance || 0), 0);

    const result = {
      period: { from: fromDate, to: toDate },
      vehicles: {
        total: devices.length,
        driving: driving.length,
        communicating: communicating.length,
        offline: devices.length - communicating.length,
      },
      trips: {
        count: trips.length,
        totalDistanceKm: Math.round(totalDistance * 100) / 100,
      },
      safety: {
        exceptionEvents: events.length,
      },
      maintenance: {
        faultCodes: faults.length,
      },
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// --- Start Server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Claw Fleet Manager MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
