import type { Resource } from '../src/api/client.js';

// Shapes captured from a live CT200 (firmware 05.04.00), personal data removed.
export const zonesRefEnum: Resource = {
  id: '/zones',
  type: 'refEnum',
  references: [
    { id: '/zones/deviceTypeAllowed' },
    { id: '/zones/list' },
    { id: '/zones/zn1' },
  ],
};

const float = (id: string, value: number, extra: Partial<Resource> = {}): Resource =>
  ({ id, type: 'floatValue', writeable: 0, value, ...extra });
const string = (id: string, value: string, extra: Partial<Resource> = {}): Resource =>
  ({ id, type: 'stringValue', writeable: 0, value, ...extra });

export const ct200: Resource[] = [
  float('/zones/zn1/temperatureActual', 22.7),
  float('/zones/zn1/temperatureHeatingSetpoint', 10, { minValue: 5, maxValue: 30, stepSize: 0.5, used: 'true' }),
  float('/zones/zn1/manualTemperatureHeating', 15, { writeable: 1, minValue: 5, maxValue: 30, stepSize: 0.5 }),
  float('/zones/zn1/clockOverride/temperatureHeating', 10, { writeable: 1, minValue: 0, maxValue: 30, stepSize: 0.5 }),
  string('/zones/zn1/userMode', 'clock', { writeable: 1, used: 'true' }),
  string('/zones/zn1/status', 'idle'),
  string('/heatSources/flameIndication', 'off'),
  float('/system/sensors/humidity/indoor_h1', 68.8),
  float('/system/sensors/temperatures/outdoor_t1', 16, { minValue: -25, maxValue: 50, stepSize: 1 }),
  string('/system/awayMode/enabled', 'false', { writeable: 1, used: 'true' }),
  string('/heatingCircuits/hc1/boostMode', 'off', { writeable: 1, used: 'true', available: 'true' }),
];

export const stateOf = (resources: Resource[] = ct200) => new Map(resources.map((r) => [r.id, r]));

const b64 = (s: string) => Buffer.from(s).toString('base64');

/** `/devices/list` as a CT200 with radiator valves reports it (names changed). */
export const devicesList = (batteries: Record<number, string> = {}): Resource => ({
  id: '/devices/list',
  type: 'deviceArray',
  writeable: 0,
  value: [
    { name: b64('EasyControl'), zone: 1, protocol: 'no_protocol', id: 1, battery: 'unknown', signal: 0, type: 'thermostat' },
    { name: b64('Kitchen'), zone: 1, protocol: 'homematicip', id: 2, battery: batteries[2] ?? 'ok', signal: 72, type: 'thermostat_valve', warning: 0 },
    { name: b64('Lounge'), zone: 1, protocol: 'homematicip', id: 3, battery: batteries[3] ?? 'ok', signal: 76, type: 'thermostat_valve', warning: 0 },
    { name: b64('Hall'), zone: 2, protocol: 'homematicip', id: 4, battery: batteries[4] ?? 'ok', signal: 78, type: 'thermostat_valve', warning: 0 },
  ],
});
