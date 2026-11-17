import type { Resource } from './api/client.js';

export type State = ReadonlyMap<string, Resource>;
export type Write = { path: string; value: unknown };
export type SetpointBehaviour = 'override' | 'manual';

export const SYSTEM_PATHS = {
  flame: '/heatSources/flameIndication',
  humidity: '/system/sensors/humidity/indoor_h1',
  outdoorTemp: '/system/sensors/temperatures/outdoor_t1',
  away: '/system/awayMode/enabled',
  boost: '/heatingCircuits/hc1/boostMode',
  boostTemperature: '/heatingCircuits/hc1/boostTemperature',
  boostDuration: '/heatingCircuits/hc1/boostDuration',
  /** Every paired device (the CT200 and its radiator valves) with battery state and zone. */
  devices: '/devices/list',
} as const;

/**
 * The CT200 has one indoor humidity sensor for the whole system. It is shown
 * only on this zone's thermostat, so other zones don't repeat the same reading.
 */
export const HUMIDITY_ZONE = 'zn1';

export function zonePaths(zone: string) {
  const base = `/zones/${zone}`;
  return {
    name: `${base}/name`,
    temperature: `${base}/temperatureActual`,
    setpoint: `${base}/temperatureHeatingSetpoint`,
    manualSetpoint: `${base}/manualTemperatureHeating`,
    overrideSetpoint: `${base}/clockOverride/temperatureHeating`,
    userMode: `${base}/userMode`,
    status: `${base}/status`,
  };
}

/** All resources polled each cycle for the given zones. */
export function pollPaths(zones: string[]): string[] {
  const zoneOnly = zones.flatMap((z) => {
    const { name: _name, ...rest } = zonePaths(z);
    return Object.values(rest);
  });
  return [...zoneOnly, ...Object.values(SYSTEM_PATHS)];
}

/** Zone ids (`zn1`, ...) from the `/zones` refEnum, ignoring `/zones/list` etc. */
export function zoneIds(zones: Resource | undefined): string[] {
  return (zones?.references ?? [])
    .map((r) => r.id.match(/^\/zones\/(zn\d+)$/)?.[1])
    .filter((z): z is string => !!z);
}

/** Bosch stores user-entered names base64-encoded. */
export function decodeName(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || !raw) {
    return fallback;
  }
  const decoded = Buffer.from(raw, 'base64').toString('utf8');
  const looksBase64 = /^[A-Za-z0-9+/]+={0,2}$/.test(raw) && raw.length % 4 === 0;
  return looksBase64 && /^[\p{L}\p{N}\p{P}\p{Zs}]+$/u.test(decoded) ? decoded : raw;
}

/** The range HomeKit accepts for a current temperature, in °C. */
export const TEMPERATURE_RANGE = { min: -50, max: 100 } as const;

/** Zone status while the CT200 can't reach the zone's radiator valve (eTRV). */
export const COMM_ERROR = 'comm error';

export interface ZoneTemperature {
  /** A temperature HomeKit can show, when there is one. */
  temperature?: number;
  /** Why there's no reading, when Bosch says there's a problem. */
  problem?: string;
}

/**
 * The zone's current temperature, or the reason there isn't one. While an eTRV
 * has no connection to the CT200 (flat battery, out of range, needs re-pairing,
 * still reconnecting after a power cut) Bosch sets the zone's status to
 * "comm error" and reports its temperature as 1000 °C, which isn't a reading.
 */
export function zoneTemperature(state: State, zone: string): ZoneTemperature {
  const paths = zonePaths(zone);
  const raw = num(state, paths.temperature);
  if (str(state, paths.status) === COMM_ERROR) {
    return { problem: `status "${COMM_ERROR}"` };
  }
  if (raw !== undefined && (raw < TEMPERATURE_RANGE.min || raw > TEMPERATURE_RANGE.max)) {
    return { problem: `Bosch reports ${raw} °C` };
  }
  return { temperature: raw };
}

export const num = (state: State, path: string): number | undefined => {
  const v = state.get(path)?.value;
  return typeof v === 'number' ? v : undefined;
};

export const str = (state: State, path: string): string | undefined => {
  const v = state.get(path)?.value;
  return typeof v === 'string' ? v : undefined;
};

/** Present in the poll and not flagged unavailable by the gateway. */
export const isAvailable = (state: State, path: string): boolean => {
  const r = state.get(path);
  return !!r && r.available !== 'false';
};

export function isHeating(state: State, zone: string): boolean {
  return str(state, SYSTEM_PATHS.flame) === 'on' || str(state, zonePaths(zone).status) === 'heating';
}

/**
 * Writes needed to change a zone's target temperature from HomeKit.
 * In schedule (`clock`) mode the default is the CT200's own temporary override,
 * which lasts until the next schedule switch point, the same as turning the dial.
 */
export function setpointWrites(state: State, zone: string, temp: number, behaviour: SetpointBehaviour): Write[] {
  const p = zonePaths(zone);
  if (str(state, p.userMode) !== 'clock') {
    return [{ path: p.manualSetpoint, value: temp }];
  }
  if (behaviour === 'override') {
    return [{ path: p.overrideSetpoint, value: temp }];
  }
  return [
    { path: p.userMode, value: 'manual' },
    { path: p.manualSetpoint, value: temp },
  ];
}

/** Apply writes to the cached state, so HomeKit reflects them before the next poll confirms. */
export function applyWrites(state: Map<string, Resource>, writes: Write[]): void {
  for (const w of writes) {
    const r = state.get(w.path);
    if (r) {
      state.set(w.path, { ...r, value: w.value });
    }
  }
}

/** A radiator valve's battery in `/devices/list` when it needs replacing. */
export const LOW_BATTERY = 'low battery';

/** One entry of `/devices/list`. */
export interface Device {
  id: number;
  /** Base64-encoded, like zone names. */
  name?: string;
  /** Zone number: 1 for zn1. */
  zone?: number;
  /** `ok` or `low battery` for radiator valves; `unknown` for the mains-powered CT200. */
  battery?: string;
  type?: string;
}

export function devices(state: State): Device[] {
  const v = state.get(SYSTEM_PATHS.devices)?.value;
  return Array.isArray(v) ? (v as Device[]) : [];
}

export interface ZoneBattery {
  low: boolean;
  /** Names of the zone's devices reporting a low battery. */
  lowDevices: string[];
}

/** Whether any device in the zone has a low battery, from each device's battery in `/devices/list`. */
export function zoneBattery(state: State, zone: string): ZoneBattery {
  const lowDevices = devices(state)
    .filter((d) => `zn${d.zone}` === zone && d.battery === LOW_BATTERY)
    .map((d) => decodeName(d.name, `device ${d.id}`));
  return { low: lowDevices.length > 0, lowDevices };
}

export const MODEL_CT200 = 'EasyControl CT200';
export const MODEL_VALVE = 'Radiator Thermostat';

/** Where Bosch reports a device's firmware, already in HomeKit's x.y.z form. */
export const deviceFirmwarePath = (id: number) => `/devices/device${id}/versionFirmware`;

/**
 * A firmware version HomeKit can show. The Home app only accepts plain numbers
 * like `5.4.0`, so `05.04.00` (how `/gateway/versionFirmware` reports it) shows
 * as 0.0; leading zeros are dropped. Anything that isn't a version is undefined.
 */
export function homekitVersion(raw: unknown): string | undefined {
  const m = typeof raw === 'string' ? raw.trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/) : null;
  return m ? m.slice(1).filter((p) => p !== undefined).map(Number).join('.') : undefined;
}

/** Negative if a is older than b, positive if newer, 0 if the same. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) {
      return d;
    }
  }
  return 0;
}

/** What a HomeKit accessory reports as its model and firmware. */
export interface Hardware {
  model: string;
  firmware?: string;
}

const firmwareOf = (fw: State, d: Device) => homekitVersion(fw.get(deviceFirmwarePath(d.id))?.value);

/** The EasyControl itself, for accessories that stand for the whole system. */
export function controllerHardware(list: Device[], fw: State, fallback?: string): Hardware {
  const ct200 = list.find((d) => d.type === 'thermostat');
  return { model: MODEL_CT200, firmware: (ct200 && firmwareOf(fw, ct200)) ?? fallback };
}

/**
 * The device that does the work in a zone: the EasyControl if the zone contains
 * it, otherwise its radiator valves. With several valves on different firmware,
 * the oldest is shown, so a valve that needs updating is visible.
 */
export function zoneHardware(list: Device[], fw: State, zone: string, fallback?: string): Hardware {
  const inZone = list.filter((d) => `zn${d.zone}` === zone);
  if (inZone.some((d) => d.type === 'thermostat')) {
    return controllerHardware(inZone, fw, fallback);
  }
  const valves = inZone.filter((d) => d.type === 'thermostat_valve');
  if (!valves.length) {
    return { model: MODEL_CT200, firmware: fallback };
  }
  const versions = valves.map((d) => firmwareOf(fw, d)).filter((v): v is string => !!v);
  return { model: MODEL_VALVE, firmware: versions.sort(compareVersions)[0] };
}
