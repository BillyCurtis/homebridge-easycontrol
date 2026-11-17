import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory } from 'homebridge';

import { SystemAccessory } from './accessories/system.js';
import { ZoneAccessory } from './accessories/zone.js';
import { PointtClient, type Resource } from './api/client.js';
import { AuthError } from './api/oauth.js';
import { TokenStore } from './api/tokenStore.js';
import { GatewayController } from './gateway.js';
import {
  controllerHardware, decodeName, deviceFirmwarePath, devices, type Hardware, homekitVersion, str, SYSTEM_PATHS, zoneHardware,
  zoneHasBatteries, zoneIds, zonePaths,
} from './model.js';
import {
  DEFAULT_POLL_SECONDS, type EasyControlConfig, MIN_POLL_SECONDS, PLATFORM_NAME, PLUGIN_NAME, tokenPath,
} from './settings.js';

const DISCOVERY_RETRY_MS = 60_000;

export class EasyControlPlatform implements DynamicPlatformPlugin {
  readonly config: EasyControlConfig;
  private readonly cached = new Map<string, PlatformAccessory>();
  private readonly gateways: GatewayController[] = [];

  constructor(
    readonly log: Logging,
    config: EasyControlConfig,
    readonly api: API,
  ) {
    this.config = config;
    api.on('didFinishLaunching', () => void this.discover());
    api.on('shutdown', () => this.gateways.forEach((g) => g.stop()));
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory);
  }

  /** Turns write failures into a HomeKit "No Response" for the characteristic. */
  async guard(p: Promise<void>): Promise<void> {
    try {
      await p;
    } catch (err) {
      this.log.error(`Write failed: ${(err as Error).message}`);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /** Retries until it succeeds, so logging in from the UI takes effect without a restart. */
  private async discover(warned = false): Promise<void> {
    const retry = () => setTimeout(() => void this.discover(true), DISCOVERY_RETRY_MS);
    const tokens = new TokenStore(tokenPath(this.api.user.storagePath()));
    if (!(await tokens.load())) {
      if (!warned) {
        this.log.warn('Not logged in to Bosch. Log in from the plugin settings in the Homebridge UI; '
          + 'the plugin will pick it up within a minute.');
      }
      retry();
      return;
    }
    try {
      await this.setup(new PointtClient(tokens));
      this.log.info('Connected to Bosch');
    } catch (err) {
      if (!warned) {
        this.log.warn(err instanceof AuthError
          ? `${err.message}. Log in again from the plugin settings in the Homebridge UI.`
          : `Discovery failed (${(err as Error).message}); retrying every ${DISCOVERY_RETRY_MS / 1000}s`);
      }
      retry();
    }
  }

  private async setup(client: PointtClient): Promise<void> {
    // A retry after a partial failure starts from scratch.
    this.gateways.splice(0).forEach((g) => g.stop());
    const pollMs = Math.max(this.config.pollInterval ?? DEFAULT_POLL_SECONDS, MIN_POLL_SECONDS) * 1000;
    const gateways = (await client.getGateways()).filter((g) => g.deviceType === 'rrc2');
    if (!gateways.length) {
      this.log.warn('No EasyControl (rrc2) gateways found on this Bosch account');
    }
    const keep = new Set<string>();

    for (const gw of gateways) {
      const zones = zoneIds(await client.get(gw.deviceId, '/zones'));
      const info = await client.bulkGet(gw.deviceId, [
        '/gateway/versionFirmware', SYSTEM_PATHS.devices, ...zones.map((z) => zonePaths(z).name),
      ]);
      const firmware = str(info, '/gateway/versionFirmware') ?? 'unknown';
      // Each device's firmware, for the model and firmware HomeKit shows per accessory.
      const deviceList = devices(info);
      const deviceFirmware = deviceList.length
        ? await client.bulkGet(gw.deviceId, deviceList.map((d) => deviceFirmwarePath(d.id)))
        : new Map<string, Resource>();
      const fallback = homekitVersion(firmware);
      const controller = new GatewayController(gw.deviceId, zones, client, this.log, pollMs);
      this.log.info(`Gateway ${gw.deviceId} (firmware ${firmware}): zones ${zones.join(', ') || 'none'}`);

      // Seed state before wiring characteristics, so setpoint limits come from the device.
      await controller.poll();

      for (const zone of zones) {
        const name = decodeName(info.get(zonePaths(zone).name)?.value, zone);
        const hardware = zoneHardware(deviceList, deviceFirmware, zone, fallback);
        const acc = this.accessory(`${gw.deviceId}:${zone}`, name, gw.deviceId, hardware, keep);
        const hasBatteries = deviceList.length ? zoneHasBatteries(deviceList, zone) : undefined;
        new ZoneAccessory(this, acc, controller, zone, hasBatteries);
      }
      // With all of its services turned off the system accessory would be empty,
      // which Home shows as unsupported. Leaving it out of `keep` also removes
      // a previously cached one below.
      if (SystemAccessory.hasServices(this.config)) {
        const hardware = controllerHardware(deviceList, deviceFirmware, fallback);
        const sys = this.accessory(`${gw.deviceId}:system`, this.config.name ?? 'Bosch CT200', gw.deviceId, hardware, keep);
        new SystemAccessory(this, sys, controller);
      }
      this.gateways.push(controller);
    }

    const stale = [...this.cached.values()].filter((a) => !keep.has(a.UUID));
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }

  private accessory(key: string, name: string, serial: string, hardware: Hardware, keep: Set<string>): PlatformAccessory {
    const { Service, Characteristic } = this.api.hap;
    const uuid = this.api.hap.uuid.generate(key);
    keep.add(uuid);
    let acc = this.cached.get(uuid);
    if (!acc) {
      acc = new this.api.platformAccessory(name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
      this.log.info(`Added accessory ${name}`);
    }
    const info = acc.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Bosch')
      .setCharacteristic(Characteristic.Model, hardware.model)
      .setCharacteristic(Characteristic.SerialNumber, `${serial}${key.slice(serial.length)}`);
    if (hardware.firmware) {
      info.setCharacteristic(Characteristic.FirmwareRevision, hardware.firmware);
    }
    return acc;
  }
}
