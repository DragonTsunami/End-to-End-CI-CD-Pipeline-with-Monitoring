import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const PORT = Number(process.env.PORT || 8080);
const PROMETHEUS_URL = process.env.PROMETHEUS_URL || "http://localhost:9090";
const EVENTS_FILE = process.env.EVENTS_FILE || "./data/events.json";

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

const queries = {
  cpu: '100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[2m])) * 100)',
  memory: "(1 - (sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes))) * 100",
  disk: '(1 - (sum(node_filesystem_avail_bytes{fstype!~"tmpfs|overlay|squashfs"}) / sum(node_filesystem_size_bytes{fstype!~"tmpfs|overlay|squashfs"}))) * 100',
  containers: 'count(container_last_seen{id!="",id!="/"})',
  targetsUp: "sum(up)",
  targetsTotal: "count(up)",
  containerCpu: 'topk(8, sum by(id) (rate(container_cpu_usage_seconds_total{id!="",id!="/"}[2m])) * 100)',
  containerMemory: 'topk(8, container_memory_usage_bytes{id!="",id!="/"})',
  hostLoad: "node_load1",
  networkReceive: 'sum(rate(node_network_receive_bytes_total{device!~"lo|veth.*|docker.*|br-.*"}[2m]))',
  networkTransmit: 'sum(rate(node_network_transmit_bytes_total{device!~"lo|veth.*|docker.*|br-.*"}[2m]))',
};

const seedEvents = [
  {
    id: "seed-1",
    time: new Date(Date.now() - 1000 * 60 * 18).toISOString(),
    level: "info",
    source: "prometheus",
    handler: "Hermes",
    message: "Prometheus 采集链路初始化完成",
  },
  {
    id: "seed-2",
    time: new Date(Date.now() - 1000 * 60 * 74).toISOString(),
    level: "warning",
    source: "host",
    handler: "SRE",
    message: "完成主机磁盘水位巡检，已确认日志轮转策略",
  },
  {
    id: "seed-3",
    time: new Date(Date.now() - 1000 * 60 * 145).toISOString(),
    level: "success",
    source: "docker",
    handler: "Platform",
    message: "cAdvisor 容器指标采集已接入监控面板",
  },
];

function send(res, status, payload) {
  res.writeHead(status, jsonHeaders);
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function prometheus(path, params = {}) {
  const url = new URL(path, PROMETHEUS_URL);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  const payload = await response.json();
  if (!response.ok || payload.status !== "success") {
    throw new Error(payload.error || `Prometheus request failed: ${response.status}`);
  }
  return payload.data;
}

async function instantQuery(query) {
  const data = await prometheus("/api/v1/query", { query });
  return data.result;
}

function firstNumber(result) {
  const value = result?.[0]?.value?.[1];
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function vectorRows(result, valueName = "value") {
  return result.map((item) => ({
    metric: item.metric,
    [valueName]: round(Number(item.value?.[1] || 0), 2),
  }));
}

async function getEvents() {
  try {
    const raw = await readFile(EVENTS_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    await mkdir(dirname(EVENTS_FILE), { recursive: true });
    await writeFile(EVENTS_FILE, JSON.stringify(seedEvents, null, 2));
    return seedEvents;
  }
}

async function saveEvents(events) {
  await mkdir(dirname(EVENTS_FILE), { recursive: true });
  await writeFile(EVENTS_FILE, JSON.stringify(events.slice(0, 200), null, 2));
}

async function overview() {
  const [cpu, memory, disk, containers, up, total, rx, tx, alerts, targets, containerCpu, containerMemory, load] =
    await Promise.all([
      instantQuery(queries.cpu),
      instantQuery(queries.memory),
      instantQuery(queries.disk),
      instantQuery(queries.containers),
      instantQuery(queries.targetsUp),
      instantQuery(queries.targetsTotal),
      instantQuery(queries.networkReceive),
      instantQuery(queries.networkTransmit),
      prometheus("/api/v1/alerts"),
      prometheus("/api/v1/targets"),
      instantQuery(queries.containerCpu),
      instantQuery(queries.containerMemory),
      instantQuery(queries.hostLoad),
    ]);

  return {
    collectedAt: new Date().toISOString(),
    prometheusUrl: PROMETHEUS_URL,
    host: {
      cpu: round(firstNumber(cpu)),
      memory: round(firstNumber(memory)),
      disk: round(firstNumber(disk)),
      load: vectorRows(load, "load"),
      networkReceiveBytes: round(firstNumber(rx), 0),
      networkTransmitBytes: round(firstNumber(tx), 0),
    },
    monitor: {
      targetsUp: round(firstNumber(up), 0),
      targetsTotal: round(firstNumber(total), 0),
      activeTargets: targets.activeTargets.map((target) => ({
        job: target.labels.job,
        instance: target.labels.instance,
        health: target.health,
        lastScrape: target.lastScrape,
        lastError: target.lastError,
        scrapeUrl: target.scrapeUrl,
      })),
    },
    docker: {
      containers: round(firstNumber(containers), 0),
      cpu: vectorRows(containerCpu, "cpu"),
      memory: vectorRows(containerMemory, "memoryBytes"),
    },
    alerts: alerts.alerts.map((alert) => ({
      state: alert.state,
      name: alert.labels.alertname,
      severity: alert.labels.severity || "info",
      module: alert.labels.module || "system",
      summary: alert.annotations.summary || alert.labels.alertname,
      description: alert.annotations.description || "",
      activeAt: alert.activeAt,
      labels: alert.labels,
    })),
  };
}

async function range(query, seconds = 1800, step = 30) {
  const end = Math.floor(Date.now() / 1000);
  const start = end - seconds;
  return prometheus("/api/v1/query_range", {
    query,
    start: String(start),
    end: String(end),
    step: String(step),
  });
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return send(res, 200, { ok: true });

    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (url.pathname === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
      return res.end(`hermes_backend_info{service="api"} 1\n`);
    }

    if (url.pathname === "/api/health") {
      return send(res, 200, { status: "ok", prometheusUrl: PROMETHEUS_URL });
    }

    if (url.pathname === "/api/overview") {
      try {
        return send(res, 200, { ok: true, data: await overview() });
      } catch (error) {
        return send(res, 503, {
          ok: false,
          error: "PROMETHEUS_UNAVAILABLE",
          message: error.message,
          prometheusUrl: PROMETHEUS_URL,
        });
      }
    }

    if (url.pathname === "/api/series") {
      const metric = url.searchParams.get("metric") || "cpu";
      const queryMap = {
        cpu: queries.cpu,
        memory: queries.memory,
        disk: queries.disk,
        receive: queries.networkReceive,
        transmit: queries.networkTransmit,
      };
      const query = queryMap[metric] || queryMap.cpu;
      return send(res, 200, { ok: true, data: await range(query) });
    }

    if (url.pathname === "/api/events" && req.method === "GET") {
      return send(res, 200, { ok: true, data: await getEvents() });
    }

    if (url.pathname === "/api/events" && req.method === "POST") {
      const body = await readBody(req);
      const event = {
        id: crypto.randomUUID(),
        time: new Date().toISOString(),
        level: body.level || "info",
        source: body.source || "manual",
        handler: body.handler || "operator",
        message: String(body.message || "").slice(0, 240),
      };
      if (!event.message) return send(res, 400, { ok: false, message: "message is required" });
      const events = [event, ...(await getEvents())];
      await saveEvents(events);
      return send(res, 201, { ok: true, data: event });
    }

    send(res, 404, { ok: false, message: "Not found" });
  } catch (error) {
    send(res, 500, { ok: false, message: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Hermes backend listening on ${PORT}`);
});
