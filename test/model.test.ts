import { describe, expect, it } from 'vitest';

import {
  compareVersions, controllerHardware, decodeName, devices, homekitVersion, isHeating, pollPaths, setpointWrites, zoneBattery,
  zoneHardware, zoneHasBatteries, zoneIds,
} from '../src/model.js';
import { ct200, devicesList, firmware, stateOf, zonesRefEnum } from './fixtures.js';

describe('zoneIds', () => {
  it('keeps only znN references', () => {
    expect(zoneIds(zonesRefEnum)).toEqual(['zn1']);
    expect(zoneIds(undefined)).toEqual([]);
  });
});

describe('decodeName', () => {
  it('decodes base64 zone names', () => {
    expect(decodeName('S2l0Y2hlbg==', 'zn1')).toBe('Kitchen');
  });
  it('leaves plain names alone and falls back when empty', () => {
    expect(decodeName('Living room', 'zn1')).toBe('Living room');
    expect(decodeName('', 'zn1')).toBe('zn1');
    expect(decodeName(undefined, 'zn1')).toBe('zn1');
  });
});

describe('pollPaths', () => {
  it('covers zone and system resources but not the static name', () => {
    const paths = pollPaths(['zn1']);
    expect(paths).toContain('/zones/zn1/temperatureActual');
    expect(paths).toContain('/system/awayMode/enabled');
    expect(paths).not.toContain('/zones/zn1/name');
    expect(paths.length).toBeLessThanOrEqual(30);
  });
});

describe('isHeating', () => {
  it('is false when idle with the flame off', () => {
    expect(isHeating(stateOf(), 'zn1')).toBe(false);
  });
  it('is true when the flame is on', () => {
    const s = stateOf();
    s.set('/heatSources/flameIndication', { ...s.get('/heatSources/flameIndication')!, value: 'on' });
    expect(isHeating(s, 'zn1')).toBe(true);
  });
});

describe('setpointWrites', () => {
  it('uses the temporary clock override on schedule by default', () => {
    expect(setpointWrites(stateOf(), 'zn1', 21, 'override')).toEqual([
      { path: '/zones/zn1/clockOverride/temperatureHeating', value: 21 },
    ]);
  });
  it('switches to manual first when configured to', () => {
    expect(setpointWrites(stateOf(), 'zn1', 21, 'manual')).toEqual([
      { path: '/zones/zn1/userMode', value: 'manual' },
      { path: '/zones/zn1/manualTemperatureHeating', value: 21 },
    ]);
  });
  it('writes the manual setpoint when already manual', () => {
    const s = stateOf();
    s.set('/zones/zn1/userMode', { ...s.get('/zones/zn1/userMode')!, value: 'manual' });
    expect(setpointWrites(s, 'zn1', 19.5, 'override')).toEqual([
      { path: '/zones/zn1/manualTemperatureHeating', value: 19.5 },
    ]);
  });
});

describe('zoneBattery', () => {
  const withDevices = (batteries: Record<number, string> = {}) => stateOf([...ct200, devicesList(batteries)]);

  it('is OK when every valve in the zone is OK, ignoring the CT200\'s unknown battery', () => {
    expect(zoneBattery(withDevices(), 'zn1')).toEqual({ low: false, lowDevices: [] });
  });

  it('is low when any valve in the zone is low, and names it', () => {
    expect(zoneBattery(withDevices({ 3: 'low battery' }), 'zn1')).toEqual({ low: true, lowDevices: ['Lounge'] });
  });

  it('ignores low valves in other zones', () => {
    expect(zoneBattery(withDevices({ 4: 'low battery' }), 'zn1').low).toBe(false);
    expect(zoneBattery(withDevices({ 4: 'low battery' }), 'zn2')).toEqual({ low: true, lowDevices: ['Hall'] });
  });

  it('names every low valve in the zone', () => {
    expect(zoneBattery(withDevices({ 2: 'low battery', 3: 'low battery' }), 'zn1'))
      .toEqual({ low: true, lowDevices: ['Kitchen', 'Lounge'] });
  });

  it('polls the device list', () => {
    expect(pollPaths(['zn1'])).toContain('/devices/list');
  });
});

describe('homekitVersion', () => {
  it('drops the leading zeros the Home app rejects', () => {
    expect(homekitVersion('05.04.00')).toBe('5.4.0');
  });
  it('keeps versions already in HomeKit form', () => {
    expect(homekitVersion('1.6.0')).toBe('1.6.0');
    expect(homekitVersion('2.10')).toBe('2.10');
  });
  it('rejects anything that is not a version', () => {
    expect(homekitVersion('unknown')).toBeUndefined();
    expect(homekitVersion('1.2.3.4')).toBeUndefined();
    expect(homekitVersion(undefined)).toBeUndefined();
  });
});

describe('compareVersions', () => {
  it('compares numerically, not as text', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.6.0', '1.6')).toBe(0);
    expect(compareVersions('1.5.9', '1.6.0')).toBeLessThan(0);
  });
});

describe('model and firmware per accessory', () => {
  const list = devices(stateOf([devicesList()]));

  it('shows the EasyControl for a zone that contains it', () => {
    expect(zoneHardware(list, stateOf(firmware()), 'zn1', '5.4.0')).toEqual({ model: 'EasyControl CT200', firmware: '5.4.0' });
  });

  it('shows the radiator valve for a zone without the EasyControl', () => {
    expect(zoneHardware(list, stateOf(firmware()), 'zn2', '5.4.0')).toEqual({ model: 'Radiator Thermostat', firmware: '1.6.0' });
  });

  it('shows the oldest firmware when a zone\'s valves differ', () => {
    const twoValves = list.map((d) => (d.id === 3 ? { ...d, zone: 2 } : d));
    expect(zoneHardware(twoValves, stateOf(firmware({ 3: '1.5.2', 4: '1.6.0' })), 'zn2').firmware).toBe('1.5.2');
  });

  it('shows the EasyControl for the system accessory', () => {
    expect(controllerHardware(list, stateOf(firmware()))).toEqual({ model: 'EasyControl CT200', firmware: '5.4.0' });
  });

  it('falls back to the gateway firmware when device firmware is missing', () => {
    expect(controllerHardware(list, stateOf([]), '5.4.0').firmware).toBe('5.4.0');
    expect(zoneHardware([], stateOf([]), 'zn1', '5.4.0')).toEqual({ model: 'EasyControl CT200', firmware: '5.4.0' });
  });
});

describe('zoneHasBatteries', () => {
  const list = devices(stateOf([devicesList()]));

  it('is true for zones with radiator valves, with or without the EasyControl', () => {
    expect(zoneHasBatteries(list, 'zn1')).toBe(true);
    expect(zoneHasBatteries(list, 'zn2')).toBe(true);
  });

  it('is false for a zone with only the EasyControl, or nothing', () => {
    const ct200Only = list.filter((d) => d.type === 'thermostat');
    expect(zoneHasBatteries(ct200Only, 'zn1')).toBe(false);
    expect(zoneHasBatteries(list, 'zn9')).toBe(false);
  });
});
