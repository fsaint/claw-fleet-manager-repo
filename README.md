# Claw Fleet Manager — Geotab MCP Server

An MCP server that exposes Geotab fleet management data as tools for AI agents.

## Setup

```bash
cp .env.example .env
# Edit .env with your Geotab credentials
npm install
npm run build
```

## Running

```bash
# Compiled
npm start

# Development
npx ts-node src/index.ts
```

The server uses **stdio transport** — connect it as an MCP server in your agent config.

### OpenClaw Integration

Add to your OpenClaw MCP config:

```json
{
  "mcpServers": {
    "geotab": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/path/to/claw-fleet-manager"
    }
  }
}
```

## Available Tools

| Tool | Description |
|------|-------------|
| `get_vehicles` | List all vehicles with location, status, driver |
| `get_vehicle_location` | Single vehicle GPS location + speed |
| `get_vehicle_status` | Engine status, diagnostics, odometer |
| `get_trips` | Trip history with distance, duration |
| `get_speed_events` | Speeding violations |
| `get_safety_events` | Harsh braking, acceleration, cornering events |
| `get_driver_safety_scores` | Driver performance scores |
| `get_fault_codes` | Diagnostic trouble codes (DTCs) |
| `get_zones` | Geofence zones |
| `get_fuel_usage` | Fuel consumption summary |
| `get_idle_time` | Idle time reports |
| `get_fleet_summary` | Overall fleet statistics |

## Environment Variables

- `GEOTAB_DATABASE` — Geotab database name
- `GEOTAB_USERNAME` — Geotab username
- `GEOTAB_PASSWORD` — Geotab password
- `GEOTAB_SERVER` — Geotab server (default: `my.geotab.com`)

## Hackathon Project

Built for the **Claw Fleet Manager** hackathon — an AI-powered autonomous fleet manager using OpenClaw + Geotab.
