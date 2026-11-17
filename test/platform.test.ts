import * as hap from '@homebridge/hap-nodejs';
import type { API, Logging } from 'homebridge';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SystemAccessory } from '../src/accessories/system.js';
import type { PointtClient } from '../src/api/client.js';
import { EasyControlPlatform } from '../src/platform.js';
import type { EasyControlConfig } from '../src/settings.js';
import { ct200, devicesList, firmware, stateOf, zonesRefEnum } from './fixtures.js';

const client = {
  getGateways: async () => [{ deviceId: 'gw', deviceType: 'rrc2' }],
  get: async () => zonesRefEnum,
  bulkGet: async () => stateOf([...ct200, devicesList(), ...firmware()]),
  put: async () => undefined,
} as unknown as PointtClient;

let shutdown: (() => void) | undefined;
afterEach(() => shutdown?.());

async function setUp(config: Partial<EasyControlConfig>, cached: hap.Accessory[] = []) {
  const handlers: Record<string, () => void> = {};
  const api = {
    hap,
    platformAccessory: hap.Accessory,
    on: (event: string, fn: () => void) => { handlers[event] = fn; },
    registerPlatformAccessories: vi.fn(),
    unregisterPlatformAccessories: vi.fn(),
    user: { storagePath: () => '/nonexistent' },
  };
  const log = Object.assign(vi.fn(), { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  const platform = new EasyControlPlatform(log as unknown as Logging, { platform: 'EasyControl', ...config }, api as unknown as API);
  cached.forEach((a) => platform.configureAccessory(a as never));
  shutdown = handlers.shutdown;
  await (platform as unknown as { setup(c: PointtClient): Promise<void> }).setup(client);
  const registered = api.registerPlatformAccessories.mock.calls.flatMap((c) => c[2] as hap.Accessory[]);
  const removed = api.unregisterPlatformAccessories.mock.calls.flatMap((c) => c[2] as hap.Accessory[]);
  return { registered, removed };
}

const allOff = { showOutdoorTemperature: false, showAway: false, showBoost: false };

describe('SystemAccessory.hasServices', () => {
  it('is true by default and while any service is on', () => {
    expect(SystemAccessory.hasServices({ platform: 'EasyControl' })).toBe(true);
    expect(SystemAccessory.hasServices({ platform: 'EasyControl', ...allOff, showBoost: true })).toBe(true);
  });
  it('is false when all three are off', () => {
    expect(SystemAccessory.hasServices({ platform: 'EasyControl', ...allOff })).toBe(false);
  });
});

describe('system accessory', () => {
  it('is added when any system service is on', async () => {
    const { registered } = await setUp({});
    expect(registered.map((a) => a.UUID)).toContain(hap.uuid.generate('gw:system'));
  });

  it('is not added when Away, Boost and Outdoor are all off', async () => {
    const { registered } = await setUp(allOff);
    expect(registered.map((a) => a.UUID)).toEqual([hap.uuid.generate('gw:zn1')]);
  });

  it('is removed if it was cached from before they were turned off', async () => {
    const old = new hap.Accessory('Bosch CT200', hap.uuid.generate('gw:system'));
    const { removed } = await setUp(allOff, [old]);
    expect(removed).toEqual([old]);
  });
});

describe('accessory information', () => {
  const info = (acc: hap.Accessory) => {
    const s = acc.getService(hap.Service.AccessoryInformation)!;
    return {
      model: s.getCharacteristic(hap.Characteristic.Model).value,
      firmware: s.getCharacteristic(hap.Characteristic.FirmwareRevision).value,
    };
  };

  it('shows each device\'s model and firmware in a form the Home app accepts', async () => {
    const { registered } = await setUp({});
    const byKey = (key: string) => registered.find((a) => a.UUID === hap.uuid.generate(key))!;
    expect(info(byKey('gw:zn1'))).toEqual({ model: 'EasyControl CT200', firmware: '5.4.0' });
    expect(info(byKey('gw:system'))).toEqual({ model: 'EasyControl CT200', firmware: '5.4.0' });
  });

  it('fixes the firmware on accessories cached with the old 05.04.00', async () => {
    const old = new hap.Accessory('Kitchen', hap.uuid.generate('gw:zn1'));
    old.getService(hap.Service.AccessoryInformation)!.setCharacteristic(hap.Characteristic.FirmwareRevision, '05.04.00');
    await setUp({}, [old]);
    expect(info(old).firmware).toBe('5.4.0');
  });
});
