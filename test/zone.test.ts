import * as hap from '@homebridge/hap-nodejs';
import type { PlatformAccessory } from 'homebridge';
import { describe, expect, it, vi } from 'vitest';

import type { Resource } from '../src/api/client.js';

import { ZoneAccessory } from '../src/accessories/zone.js';
import type { GatewayController } from '../src/gateway.js';
import type { EasyControlPlatform } from '../src/platform.js';
import { devicesList, stateOf } from './fixtures.js';

const { Characteristic, Service } = hap;

function zoneAccessory(zone: string, accessory = new hap.Accessory(zone, hap.uuid.generate(zone))) {
  const listeners: (() => void)[] = [];
  const gateway = { state: stateOf(), onUpdate: (fn: () => void) => listeners.push(fn) };
  const log = { info: vi.fn(), warn: vi.fn() };
  const platform = { api: { hap }, config: {}, log, guard: vi.fn() };
  new ZoneAccessory(
    platform as unknown as EasyControlPlatform,
    accessory as unknown as PlatformAccessory,
    gateway as unknown as GatewayController,
    zone,
  );
  const thermostat = accessory.getService(Service.Thermostat)!;
  return { accessory, thermostat, gateway, log, push: () => listeners.forEach((fn) => fn()) };
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

describe('radiator valve connection', () => {
  const set = (state: Map<string, Resource>, path: string, value: string | number) => {
    state.set(path, { ...state.get(path)!, value });
  };
  const lose = (state: Map<string, Resource>) => {
    set(state, '/zones/zn1/status', 'comm error');
    set(state, '/zones/zn1/temperatureActual', 1000);
  };

  it('shows No Response while the zone status is "comm error"', async () => {
    const { thermostat, gateway, log, push } = zoneAccessory('zn1');
    push();
    lose(gateway.state);
    push();
    const current = thermostat.getCharacteristic(Characteristic.CurrentTemperature);
    expect(current.statusCode).toBe(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    expect(current.value).toBeCloseTo(22.7); // the 1000 °C placeholder never reaches HomeKit
    await expect(current.handleGetRequest()).rejects.toBe(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn.mock.calls[0][0]).toMatch(/no connection to the radiator valve \(status "comm error"\)/);
  });

  it('logs the lost connection only once while it lasts', () => {
    const { gateway, log, push } = zoneAccessory('zn1');
    lose(gateway.state);
    push();
    push();
    push();
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('recovers by itself when the valve reconnects', async () => {
    const { thermostat, gateway, log, push } = zoneAccessory('zn1');
    lose(gateway.state);
    push();
    set(gateway.state, '/zones/zn1/status', 'idle');
    set(gateway.state, '/zones/zn1/temperatureActual', 19.5);
    push();
    const current = thermostat.getCharacteristic(Characteristic.CurrentTemperature);
    expect(current.statusCode).toBe(hap.HAPStatus.SUCCESS);
    expect(current.value).toBeCloseTo(19.5);
    expect(await current.handleGetRequest()).toBeCloseTo(19.5);
    expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/radiator valve connection is back \(19.5 °C\)/));
  });

  it('also treats a temperature HomeKit cannot show as no connection', () => {
    const { thermostat, gateway, log, push } = zoneAccessory('zn1');
    set(gateway.state, '/zones/zn1/temperatureActual', 1000); // status still "idle"
    push();
    expect(thermostat.getCharacteristic(Characteristic.CurrentTemperature).statusCode)
      .toBe(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    expect(log.warn.mock.calls[0][0]).toMatch(/Bosch reports 1000 °C/);
  });
});

describe('radiator valve batteries', () => {
  const battery = (accessory: hap.Accessory) =>
    accessory.getService(Service.Battery)!.getCharacteristic(Characteristic.StatusLowBattery);

  it('adds a battery status grouped with the thermostat, normal when all valves are OK', () => {
    const { accessory, thermostat, gateway, log, push } = zoneAccessory('zn1');
    gateway.state.set('/devices/list', devicesList());
    push();
    expect(thermostat.linkedServices).toContain(accessory.getService(Service.Battery));
    expect(battery(accessory).value).toBe(Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
    const service = accessory.getService(Service.Battery)!;
    expect(service.getCharacteristic(Characteristic.BatteryLevel).value).toBe(100);
    expect(service.testCharacteristic(Characteristic.ChargingState)).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('shows low battery and logs the valve once, then clears when it is OK again', () => {
    const { accessory, gateway, log, push } = zoneAccessory('zn1');
    gateway.state.set('/devices/list', devicesList({ 2: 'low battery' }));
    push();
    push();
    expect(battery(accessory).value).toBe(Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);
    expect(accessory.getService(Service.Battery)!.getCharacteristic(Characteristic.BatteryLevel).value).toBe(10);
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn.mock.calls[0][0]).toBe('zn1: low battery in radiator valve "Kitchen". Replace the batteries soon.');

    gateway.state.set('/devices/list', devicesList());
    push();
    expect(battery(accessory).value).toBe(Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
    expect(log.info).toHaveBeenCalledWith('zn1: radiator valve batteries OK again.');
  });

  it('removes a charging status left on a cached accessory', () => {
    const cached = new hap.Accessory('zn1', hap.uuid.generate('zn1'));
    cached.addService(Service.Battery).getCharacteristic(Characteristic.ChargingState);
    zoneAccessory('zn1', cached);
    expect(cached.getService(Service.Battery)!.testCharacteristic(Characteristic.ChargingState)).toBe(false);
  });

  it('reuses the battery status of a cached accessory', () => {
    const cached = new hap.Accessory('zn1', hap.uuid.generate('zn1'));
    zoneAccessory('zn1', cached);
    zoneAccessory('zn1', cached);
    expect(cached.services.filter((s) => s.UUID === Service.Battery.UUID)).toHaveLength(1);
  });
});
