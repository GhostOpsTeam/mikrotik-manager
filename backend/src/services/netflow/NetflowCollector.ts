// NetFlow/IPFIX collector — receives Traffic Flow exports from managed
// RouterOS devices on a UDP socket, attributes flows to known clients
// (IP → MAC via the clients table), classifies them by protocol/port, and
// aggregates into 60-second windows written to InfluxDB (time series) and
// Postgres (daily per-client rollups).

import * as dgram from 'dgram';
import { Point } from '@influxdata/influxdb-client';
import { query } from '../../config/database';
import { getWriteApi } from '../../config/influxdb';
import { decodePacket, TemplateCache } from './decoder';
import { classifyApp, APP_LAN } from './appCategories';
import { FlowAggregator, CLIENT_UNKNOWN, Direction } from './FlowAggregator';

const FLUSH_INTERVAL_MS = 60_000;
const MAP_REFRESH_MS = 60_000;
const SETTINGS_RECONCILE_MS = 60_000;

export interface ExporterStats {
  deviceId: number;
  deviceName: string;
  packets: number;
  flows: number;
  lastSeen: string | null;
}

export interface CollectorStats {
  listening: boolean;
  port: number;
  packetsReceived: number;
  flowsDecoded: number;
  flowsAttributed: number;
  packetsFromUnknownExporter: number;
  recordsWithoutTemplate: number;
  exporters: ExporterStats[];
}

interface NetflowSettings {
  enabled: boolean;
  port: number;
  topN: number;
  acceptUnknown: boolean;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isLocalAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const lower = ip.toLowerCase();
    return lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8');
  }
  return isPrivateIPv4(ip);
}

export class NetflowCollector {
  private socket: dgram.Socket | null = null;
  private templates: TemplateCache = new Map();
  private aggregator = new FlowAggregator();

  private exporterByIp = new Map<string, { deviceId: number; deviceName: string }>();
  private clientMacByIp = new Map<string, string>();

  private settings: NetflowSettings = { enabled: false, port: 2055, topN: 50, acceptUnknown: true };
  private listening = false;

  // Pseudo-exporter ids for sources that don't match a managed device (e.g.
  // routers exporting from behind NAT). Negative so they can never collide
  // with real device ids.
  private unknownExporterIds = new Map<string, number>();

  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private mapTimer: ReturnType<typeof setInterval> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;

  // Stats (since process start)
  private packetsReceived = 0;
  private flowsDecoded = 0;
  private flowsAttributed = 0;
  private packetsFromUnknownExporter = 0;
  private recordsWithoutTemplate = 0;
  private exporterStats = new Map<number, ExporterStats>();

  async start(): Promise<void> {
    await this.refreshMaps().catch(() => {});
    await this.reconcile();
    this.flushTimer = setInterval(() => {
      this.flush().catch((e) => console.error('[NetFlow] Flush error:', e));
    }, FLUSH_INTERVAL_MS);
    this.mapTimer = setInterval(() => {
      this.refreshMaps().catch(() => {});
    }, MAP_REFRESH_MS);
    this.reconcileTimer = setInterval(() => {
      this.reconcile().catch(() => {});
    }, SETTINGS_RECONCILE_MS);
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.mapTimer) clearInterval(this.mapTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.closeSocket();
    await this.flush().catch(() => {});
  }

  // Re-read settings and (re)bind or close the socket as needed. Called on an
  // interval and directly by the settings route when netflow_* keys change.
  async reconcile(): Promise<void> {
    const next = await this.readSettings();
    const needsRebind =
      next.enabled !== this.settings.enabled ||
      (next.enabled && next.port !== this.settings.port);
    this.settings = next;
    if (!needsRebind) return;

    this.closeSocket();
    if (next.enabled) {
      this.bindSocket(next.port);
    }
  }

  getStats(): CollectorStats {
    return {
      listening: this.listening,
      port: this.settings.port,
      packetsReceived: this.packetsReceived,
      flowsDecoded: this.flowsDecoded,
      flowsAttributed: this.flowsAttributed,
      packetsFromUnknownExporter: this.packetsFromUnknownExporter,
      recordsWithoutTemplate: this.recordsWithoutTemplate,
      exporters: Array.from(this.exporterStats.values()),
    };
  }

  private async readSettings(): Promise<NetflowSettings> {
    try {
      const rows = await query<{ key: string; value: unknown }>(
        `SELECT key, value FROM app_settings
         WHERE key IN ('netflow_enabled', 'netflow_collector_port', 'netflow_topn_clients',
                       'netflow_accept_unknown')`
      );
      const map: Record<string, unknown> = {};
      for (const row of rows) map[row.key] = row.value;
      return {
        enabled: map['netflow_enabled'] === true,
        // In Docker the container always binds 2055 (NETFLOW_BIND_PORT) and the
        // host port is remapped via compose; netflow_collector_port is the
        // externally reachable port pushed to devices as the export target.
        port: Number(process.env.NETFLOW_BIND_PORT) || Number(map['netflow_collector_port']) || 2055,
        topN: Number(map['netflow_topn_clients']) || 50,
        acceptUnknown: map['netflow_accept_unknown'] !== false,
      };
    } catch {
      return this.settings;
    }
  }

  private bindSocket(port: number): void {
    const socket = dgram.createSocket('udp4');
    socket.on('message', (msg, rinfo) => this.onMessage(msg, rinfo));
    socket.on('error', (err) => {
      console.error(`[NetFlow] Socket error: ${err.message}`);
      this.closeSocket();
    });
    socket.bind(port, () => {
      this.listening = true;
      console.log(`[NetFlow] Collector listening on udp/${port}`);
    });
    this.socket = socket;
  }

  private closeSocket(): void {
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* already closed */
      }
      this.socket = null;
    }
    if (this.listening) console.log('[NetFlow] Collector stopped');
    this.listening = false;
  }

  private onMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    this.packetsReceived++;
    let exporter = this.exporterByIp.get(rinfo.address);
    if (!exporter) {
      // Source doesn't match any managed device — common when the exporting
      // routers sit behind NAT relative to the collector, so every packet
      // arrives from the NAT gateway's address. Client attribution doesn't
      // depend on exporter identity, so (unless disabled) process these as a
      // per-source pseudo-exporter instead of dropping real traffic data.
      this.packetsFromUnknownExporter++;
      if (!this.settings.acceptUnknown) return;
      let pseudoId = this.unknownExporterIds.get(rinfo.address);
      if (pseudoId === undefined) {
        pseudoId = -(this.unknownExporterIds.size + 1);
        this.unknownExporterIds.set(rinfo.address, pseudoId);
        console.log(`[NetFlow] Accepting flows from unidentified exporter ${rinfo.address} (NAT in path?)`);
      }
      exporter = { deviceId: pseudoId, deviceName: `Unidentified (${rinfo.address})` };
    }

    const result = decodePacket(msg, rinfo.address, this.templates);
    this.flowsDecoded += result.flows.length;
    this.recordsWithoutTemplate += result.recordsWithoutTemplate;

    let stats = this.exporterStats.get(exporter.deviceId);
    if (!stats) {
      stats = { deviceId: exporter.deviceId, deviceName: exporter.deviceName, packets: 0, flows: 0, lastSeen: null };
      this.exporterStats.set(exporter.deviceId, stats);
    }
    stats.packets++;
    stats.flows += result.flows.length;
    stats.deviceName = exporter.deviceName;
    if (result.flows.length > 0) stats.lastSeen = new Date().toISOString();

    for (const flow of result.flows) {
      this.attribute(exporter.deviceId, flow.srcAddr, flow.dstAddr, flow.srcPort, flow.dstPort, flow.protocol, flow.bytes, flow.packets);
    }
  }

  // Attribution rules:
  //  - exactly one endpoint is a known client → that client's traffic
  //    (client = source → upload, client = destination → download)
  //  - both endpoints known clients → LAN traffic, attributed to both
  //  - a local/private endpoint we can't map to a client → "unknown" bucket
  //  - neither endpoint local (e.g. post-NAT duplicate record where the
  //    source is the router's WAN address) → dropped
  private attribute(
    exporterId: number,
    srcAddr: string,
    dstAddr: string,
    srcPort: number,
    dstPort: number,
    protocol: number,
    bytes: number,
    packets: number
  ): void {
    const srcMac = this.clientMacByIp.get(srcAddr);
    const dstMac = this.clientMacByIp.get(dstAddr);
    const srcLocal = srcMac !== undefined || isLocalAddress(srcAddr);
    const dstLocal = dstMac !== undefined || isLocalAddress(dstAddr);

    const add = (clientKey: string, direction: Direction, app: string) => {
      this.aggregator.add({ exporterId, clientKey, direction, app, bytes, packets });
      this.flowsAttributed++;
    };

    if (srcMac && dstMac) {
      // Client-to-client on the local network
      add(srcMac, 'upload', APP_LAN);
      add(dstMac, 'download', APP_LAN);
      return;
    }
    if (srcLocal && dstLocal) {
      // Local flow we can't fully attribute (e.g. printer ↔ unknown host)
      add(srcMac || dstMac || CLIENT_UNKNOWN, srcMac ? 'upload' : 'download', APP_LAN);
      return;
    }
    if (srcLocal && !dstLocal) {
      add(srcMac || CLIENT_UNKNOWN, 'upload', classifyApp(protocol, srcPort, dstPort));
      return;
    }
    if (!srcLocal && dstLocal) {
      add(dstMac || CLIENT_UNKNOWN, 'download', classifyApp(protocol, dstPort, srcPort));
      return;
    }
    // Neither endpoint local — transit or post-NAT duplicate; drop.
  }

  private async refreshMaps(): Promise<void> {
    // Exporters: management IP + every cached /ip/address (CIDR stripped)
    const devices = await query<{ id: number; name: string; ip_address: string; ip_addresses_jsonb: { address: string }[] | null }>(
      `SELECT id, name, ip_address, ip_addresses_jsonb FROM devices`
    );
    const exporters = new Map<string, { deviceId: number; deviceName: string }>();
    for (const d of devices) {
      exporters.set(d.ip_address, { deviceId: d.id, deviceName: d.name });
      for (const entry of d.ip_addresses_jsonb || []) {
        const ip = (entry.address || '').split('/')[0];
        if (ip && !exporters.has(ip)) exporters.set(ip, { deviceId: d.id, deviceName: d.name });
      }
    }
    this.exporterByIp = exporters;

    // Clients: newest MAC per IP wins (DHCP reuse)
    const clients = await query<{ mac_address: string; ip_address: string }>(
      `SELECT DISTINCT ON (ip_address) mac_address, ip_address
       FROM clients
       WHERE ip_address IS NOT NULL AND ip_address != ''
       ORDER BY ip_address, last_seen DESC NULLS LAST`
    );
    const clientMap = new Map<string, string>();
    for (const c of clients) {
      clientMap.set(c.ip_address, c.mac_address.toLowerCase());
    }
    // A device's own addresses are not client traffic endpoints we can bill
    // to a MAC — exporter match takes priority over a stale client row.
    for (const ip of exporters.keys()) clientMap.delete(ip);
    this.clientMacByIp = clientMap;
  }

  private async flush(): Promise<void> {
    const rows = this.aggregator.drain(this.settings.topN);
    if (rows.length === 0) return;

    const writeApi = getWriteApi();
    const now = new Date();
    for (const row of rows) {
      writeApi.writePoint(
        new Point('client_traffic')
          .tag('mac', row.clientKey)
          .tag('direction', row.direction)
          .tag('app', row.app)
          .intField('bytes', row.bytes)
          .intField('packets', row.packets)
          .timestamp(now)
      );
    }
    await writeApi.flush().catch((e) => console.error('[NetFlow] Influx write error:', e));

    // Daily rollups: totals per mac + per-app byte breakdown
    const perClient = new Map<string, { upload: number; download: number; apps: Map<string, number> }>();
    for (const row of rows) {
      let entry = perClient.get(row.clientKey);
      if (!entry) {
        entry = { upload: 0, download: 0, apps: new Map() };
        perClient.set(row.clientKey, entry);
      }
      if (row.direction === 'upload') entry.upload += row.bytes;
      else entry.download += row.bytes;
      entry.apps.set(row.app, (entry.apps.get(row.app) || 0) + row.bytes);
    }

    for (const [mac, entry] of perClient) {
      try {
        await query(
          `INSERT INTO client_traffic_daily (mac_address, day, upload_bytes, download_bytes, app_breakdown)
           VALUES ($1, CURRENT_DATE, $2, $3, $4::jsonb)
           ON CONFLICT (mac_address, day) DO UPDATE SET
             upload_bytes   = client_traffic_daily.upload_bytes + EXCLUDED.upload_bytes,
             download_bytes = client_traffic_daily.download_bytes + EXCLUDED.download_bytes,
             app_breakdown  = (
               SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb)
               FROM (
                 SELECT COALESCE(a.key, b.key) AS k,
                        to_jsonb(COALESCE((a.value)::bigint, 0) + COALESCE((b.value)::bigint, 0)) AS v
                 FROM jsonb_each_text(client_traffic_daily.app_breakdown) a
                 FULL OUTER JOIN jsonb_each_text(EXCLUDED.app_breakdown) b ON a.key = b.key
               ) merged
             )`,
          [mac, entry.upload, entry.download, JSON.stringify(Object.fromEntries(entry.apps))]
        );
      } catch (e) {
        console.error('[NetFlow] Daily rollup error:', e);
      }
    }
  }
}

export const netflowCollector = new NetflowCollector();
