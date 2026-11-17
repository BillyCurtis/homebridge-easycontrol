import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { GatewayController } from '../gateway.js';
import {
  HUMIDITY_ZONE, isAvailable, isHeating, num, setpointWrites, str, SYSTEM_PATHS, TEMPERATURE_RANGE, zonePaths, zoneTemperature,
} from '../model.js';
import type { EasyControlPlatform } from '../platform.js';

/** One HomeKit Thermostat per CT200 zone. */
export class ZoneAccessory {
  private readonly service: Service;
  private readonly paths: ReturnType<typeof zonePaths>;
  private noReading = false;

  constructor(
    private readonly platform: EasyControlPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly gateway: GatewayController,
    private readonly zone: string,
  ) {
    const { Service, Characteristic } = platform.api.hap;
    this.paths = zonePaths(zone);

    this.service = accessory.getService(Service.Thermostat) ?? accessory.addService(Service.Thermostat);
    this.service.setCharacteristic(Characteristic.Name, accessory.displayName);

    this.service.getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: TEMPERATURE_RANGE.min, maxValue: TEMPERATURE_RANGE.max })
      .onGet(() => this.required(zoneTemperature(gateway.state, zone).temperature));

    const setpoint = gateway.state.get(this.paths.setpoint);
    this.service.getCharacteristic(Characteristic.TargetTemperature)
      .setProps({
        minValue: setpoint?.minValue ?? 5,
        maxValue: setpoint?.maxValue ?? 30,
        minStep: setpoint?.stepSize ?? 0.5,
      })
      .onGet(() => this.required(num(gateway.state, this.paths.setpoint)))
      .onSet((v) => this.setTargetTemperature(v));

    this.service.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .onGet(() => this.currentState());

    // HAP defaults this to OFF, which isn't a valid value for the CT200; set it before restricting.
    this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .updateValue(Characteristic.TargetHeatingCoolingState.AUTO)
      .setProps({
        validValues: [Characteristic.TargetHeatingCoolingState.HEAT, Characteristic.TargetHeatingCoolingState.AUTO],
      })
      .onGet(() => this.targetState())
      .onSet((v) => this.setTargetState(v));

    this.service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .setProps({ validValues: [Characteristic.TemperatureDisplayUnits.CELSIUS] })
      .onGet(() => Characteristic.TemperatureDisplayUnits.CELSIUS);

    if (this.showsHumidity) {
      this.service.getCharacteristic(Characteristic.CurrentRelativeHumidity)
        .onGet(() => this.required(num(gateway.state, SYSTEM_PATHS.humidity)));
    } else if (this.service.testCharacteristic(Characteristic.CurrentRelativeHumidity)) {
      // Cached accessories from earlier versions had humidity on every zone.
      this.service.removeCharacteristic(this.service.getCharacteristic(Characteristic.CurrentRelativeHumidity));
    }

    gateway.onUpdate(() => this.push());
  }

  private get showsHumidity(): boolean {
    return this.zone === HUMIDITY_ZONE;
  }

  private required<T>(v: T | undefined): T {
    if (v === undefined) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return v;
  }

  private currentState(): number {
    const { CurrentHeatingCoolingState } = this.platform.api.hap.Characteristic;
    return isHeating(this.gateway.state, this.zone) ? CurrentHeatingCoolingState.HEAT : CurrentHeatingCoolingState.OFF;
  }

  private targetState(): number {
    const { TargetHeatingCoolingState } = this.platform.api.hap.Characteristic;
    const mode = this.required(str(this.gateway.state, this.paths.userMode));
    return mode === 'clock' ? TargetHeatingCoolingState.AUTO : TargetHeatingCoolingState.HEAT;
  }

  private async setTargetState(value: CharacteristicValue): Promise<void> {
    const { TargetHeatingCoolingState } = this.platform.api.hap.Characteristic;
    const mode = value === TargetHeatingCoolingState.AUTO ? 'clock' : 'manual';
    this.platform.log.info(`${this.accessory.displayName}: mode -> ${mode === 'clock' ? 'schedule' : 'manual'}`);
    await this.platform.guard(this.gateway.write([{ path: this.paths.userMode, value: mode }]));
  }

  private async setTargetTemperature(value: CharacteristicValue): Promise<void> {
    const temp = value as number;
    const writes = setpointWrites(this.gateway.state, this.zone, temp, this.platform.config.setpointBehaviour ?? 'override');
    this.platform.log.info(`${this.accessory.displayName}: target temperature -> ${temp} °C`);
    await this.platform.guard(this.gateway.write(writes, [{ path: this.paths.setpoint, value: temp }]));
  }

  /**
   * Shows the zone as No Response while Bosch can't reach its radiator valve,
   * and logs once when the connection is lost and once when it's back.
   */
  private pushTemperature(): void {
    const { Characteristic, HapStatusError, HAPStatus } = this.platform.api.hap;
    const name = this.accessory.displayName;
    const { temperature, problem } = zoneTemperature(this.gateway.state, this.zone);
    if (problem) {
      if (!this.noReading) {
        this.platform.log.warn(`${name}: no connection to the radiator valve (${problem}). `
          + 'It may need new batteries or re-pairing; showing No Response until it is back.');
        this.noReading = true;
      }
      this.service.getCharacteristic(Characteristic.CurrentTemperature)
        .updateValue(new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
    } else if (temperature !== undefined) {
      if (this.noReading) {
        this.platform.log.info(`${name}: radiator valve connection is back (${temperature} °C)`);
        this.noReading = false;
      }
      this.service.updateCharacteristic(Characteristic.CurrentTemperature, temperature);
    }
  }

  private push(): void {
    const { Characteristic } = this.platform.api.hap;
    const s = this.gateway.state;
    const update = (c: Parameters<Service['updateCharacteristic']>[0], v: CharacteristicValue | undefined) => {
      if (v !== undefined) {
        this.service.updateCharacteristic(c, v);
      }
    };
    this.pushTemperature();
    update(Characteristic.TargetTemperature, num(s, this.paths.setpoint));
    update(Characteristic.CurrentHeatingCoolingState, this.currentState());
    if (str(s, this.paths.userMode)) {
      update(Characteristic.TargetHeatingCoolingState, this.targetState());
    }
    if (this.showsHumidity && isAvailable(s, SYSTEM_PATHS.humidity)) {
      update(Characteristic.CurrentRelativeHumidity, num(s, SYSTEM_PATHS.humidity));
    }
  }
}
