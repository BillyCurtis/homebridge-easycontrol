import * as hap from '@homebridge/hap-nodejs';
import type { PlatformAccessory } from 'homebridge';
import { describe, expect, it, vi } from 'vitest';

import { ZoneAccessory } from '../src/accessories/zone.js';
import type { GatewayController } from '../src/gateway.js';
import type { EasyControlPlatform } from '../src/platform.js';
import { stateOf } from './fixtures.js';

const { Characteristic, Service } = hap;

function zoneAccessory(zone: string, accessory = new hap.Accessory(zone, hap.uuid.generate(zone))) {
  const listeners: (() => void)[] = [];
  const gateway = { state: stateOf(), onUpdate: (fn: () => void) => listeners.push(fn) };
  const platform = { api: { hap }, config: {}, log: { info: vi.fn() }, guard: vi.fn() };
  new ZoneAccessory(
    platform as unknown as EasyControlPlatform,
    accessory as unknown as PlatformAccessory,
    gateway as unknown as GatewayController,
    zone,
  );
  const thermostat = accessory.getService(Service.Thermostat)!;
  return { accessory, thermostat, push: () => listeners.forEach((fn) => fn()) };
}

describe('zone humidity', () => {
  it('shows indoor humidity on zn1', async () => {
    const { thermostat, push } = zoneAccessory('zn1');
    push();
    expect(thermostat.testCharacteristic(Characteristic.CurrentRelativeHumidity)).toBe(true);
    expect(thermostat.getCharacteristic(Characteristic.CurrentRelativeHumidity).value).toBe(69); // HomeKit rounds 68.8 to whole percent
  });

  it('does not add humidity to other zones', () => {
    const { thermostat, push } = zoneAccessory('zn2');
    push();
    expect(thermostat.testCharacteristic(Characteristic.CurrentRelativeHumidity)).toBe(false);
  });

  it('removes humidity from a cached zone that had it', () => {
    const cached = new hap.Accessory('zn2', hap.uuid.generate('zn2'));
    cached.addService(Service.Thermostat).getCharacteristic(Characteristic.CurrentRelativeHumidity);
    const { thermostat } = zoneAccessory('zn2', cached);
    expect(thermostat.testCharacteristic(Characteristic.CurrentRelativeHumidity)).toBe(false);
  });
});
