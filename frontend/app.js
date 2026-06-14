const state = {
  overview: null,
  events: [],
  activeMetric: "cpu",
};

const pageTitles = {
  overview: "统一监控与事件响应中心",
  prometheus: "Prometheus 信息监控",
  hosts: "主机和监控机器预警",
  containers: "Docker 容器实时监控",
  events: "事件中心处理记录",
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function formatPercent(value) {
  return value === null || value === undefined ? "--" : `${Number(value).toFixed(1)}%`;
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return "--";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function timeAgo(iso) {
  const seconds = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2600);
}

async function api(path, options) {
  const response = await fetch(path, options);
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.message || payload.error || "请求失败");
  }
  return payload.data ?? payload;
}

function setMeter(id, value) {
  const el = $(id);
  el.style.width = `${Math.max(0, Math.min(100, Number(value || 0)))}%`;
}

function renderOverview(data) {
  const activeAlerts = data.alerts.filter((alert) => alert.state === "firing").length;
  const targetTotal = data.monitor.targetsTotal || 0;
  const targetUp = data.monitor.targetsUp || 0;
  const score = targetTotal ? Math.round((targetUp / targetTotal) * 100 - activeAlerts * 4) : 0;
  const health = Math.max(0, Math.min(100, score));

  $("#side-status").textContent = "在线";
  $("#side-prometheus").textContent = data.prometheusUrl;
  $("#prometheus-url").textContent = data.prometheusUrl;
  $("#health-score").textContent = `${health}%`;
  $("#health-copy").textContent = activeAlerts
    ? `${activeAlerts} 条活跃告警需要处理，数据来自 Prometheus 实时采集。`
    : "所有核心采集目标正常，指标来自 Prometheus 实时查询。";
  $("#target-ratio").textContent = `${targetUp}/${targetTotal}`;
  $("#container-count").textContent = data.docker.containers ?? "--";
  $("#alert-count").textContent = activeAlerts;

  $("#metric-cpu").textContent = formatPercent(data.host.cpu);
  $("#metric-memory").textContent = formatPercent(data.host.memory);
  $("#metric-disk").textContent = formatPercent(data.host.disk);
  $("#metric-network").textContent = formatBytes((data.host.networkReceiveBytes || 0) + (data.host.networkTransmitBytes || 0)) + "/s";
  $("#metric-network-sub").textContent = `入 ${formatBytes(data.host.networkReceiveBytes)}/s · 出 ${formatBytes(data.host.networkTransmitBytes)}/s`;

  setMeter("#meter-cpu", data.host.cpu);
  setMeter("#meter-memory", data.host.memory);
  setMeter("#meter-disk", data.host.disk);

  $("#refresh-text").textContent = `最后采集 ${new Date(data.collectedAt).toLocaleTimeString()}`;
  renderTargets(data.monitor.activeTargets);
  renderAlerts(data.alerts);
  renderContainers(data.docker);
  renderLoads(data.host.load);
}

function renderTargets(targets) {
  $("#targets-table").innerHTML = targets
    .map(
      (target) => `
        <tr>
          <td>${target.job}</td>
          <td>${target.instance}</td>
          <td><span class="tag ${target.health === "up" ? "up" : "down"}">${target.health}</span></td>
          <td>${target.lastScrape ? new Date(target.lastScrape).toLocaleString() : "--"}</td>
          <td>${target.lastError || "无"}</td>
        </tr>
      `,
    )
    .join("");
}

function renderAlerts(alerts) {
  const list = $("#alert-list");
  if (!alerts.length) {
    list.innerHTML = '<div class="empty">当前没有 Prometheus 活跃告警。</div>';
    return;
  }
  list.innerHTML = alerts
    .map(
      (alert) => `
        <article class="alert-item">
          <span class="tag ${alert.severity}">${alert.state} · ${alert.severity}</span>
          <h3>${alert.summary}</h3>
          <p>${alert.description || alert.name} · ${timeAgo(alert.activeAt)}</p>
        </article>
      `,
    )
    .join("");
}

function renderContainers(docker) {
  const cpu = docker.cpu.length
    ? docker.cpu
        .map((item) => rankItem(item.metric.name || item.metric.container || item.metric.id || "container", `${item.cpu}%`))
        .join("")
    : '<div class="empty">等待 cAdvisor 返回容器 CPU 指标。</div>';
  const memory = docker.memory.length
    ? docker.memory
        .map((item) => rankItem(item.metric.name || item.metric.container || item.metric.id || "container", formatBytes(item.memoryBytes)))
        .join("")
    : '<div class="empty">等待 cAdvisor 返回容器内存指标。</div>';
  $("#container-cpu").innerHTML = cpu;
  $("#container-memory").innerHTML = memory;
}

function rankItem(name, value) {
  return `
    <article class="rank-item">
      <span class="rank-name">${name}</span>
      <span class="rank-value">${value}</span>
    </article>
  `;
}

function renderLoads(loads) {
  $("#load-list").innerHTML = loads.length
    ? loads
        .map(
          (item) => `
            <article class="load-item">
              <strong>${item.metric.instance || "node"}</strong>
              <p class="sub-value">1 分钟负载：${item.load}</p>
            </article>
          `,
        )
        .join("")
    : '<div class="empty">等待 node-exporter 返回主机负载。</div>';
}

function renderEvents() {
  const html = state.events
    .map(
      (event) => `
        <article class="timeline-item">
          <span class="dot ${event.level}"></span>
          <div>
            <h3>${event.handler} · ${event.source} · ${timeAgo(event.time)}</h3>
            <p>${event.message}</p>
          </div>
        </article>
      `,
    )
    .join("");
  $("#events-list").innerHTML = html || '<div class="empty">暂无事件记录。</div>';
  $("#recent-events").innerHTML = html
    ? state.events
        .slice(0, 4)
        .map(
          (event) => `
            <article class="timeline-item">
              <span class="dot ${event.level}"></span>
              <div>
                <h3>${event.handler} · ${timeAgo(event.time)}</h3>
                <p>${event.message}</p>
              </div>
            </article>
          `,
        )
        .join("")
    : '<div class="empty">暂无事件记录。</div>';
}

async function loadOverview() {
  try {
    const data = await api("/api/overview");
    state.overview = data;
    renderOverview(data);
  } catch (error) {
    $("#side-status").textContent = "异常";
    $("#health-score").textContent = "--";
    $("#health-copy").textContent = `Prometheus 不可用：${error.message}`;
    $("#refresh-text").textContent = "采集失败";
    showToast(`实时指标获取失败：${error.message}`);
  }
}

async function loadEvents() {
  state.events = await api("/api/events");
  renderEvents();
}

async function loadSeries(metric = state.activeMetric) {
  state.activeMetric = metric;
  try {
    const data = await api(`/api/series?metric=${metric}`);
    const series = data.result?.[0]?.values || [];
    const max = Math.max(...series.map((point) => Number(point[1])), 1);
    $("#series-chart").innerHTML = series
      .slice(-40)
      .map((point) => {
        const value = Number(point[1]);
        const height = Math.max(3, (value / max) * 100);
        return `<i title="${value.toFixed(2)}" style="height:${height}%"></i>`;
      })
      .join("");
  } catch (error) {
    $("#series-chart").innerHTML = `<div class="empty">曲线获取失败：${error.message}</div>`;
  }
}

function switchView(view) {
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  $$(".view").forEach((item) => item.classList.toggle("active", item.id === `view-${view}`));
  $("#page-title").textContent = pageTitles[view] || pageTitles.overview;
}

async function refreshAll() {
  await Promise.all([loadOverview(), loadEvents(), loadSeries()]);
}

$$(".nav-item, .nav-shortcut").forEach((button) => {
  button.addEventListener("click", () => switchView(button.dataset.view));
});

$("#refresh-btn").addEventListener("click", refreshAll);

$("#series-tabs").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-metric]");
  if (!button) return;
  $$("#series-tabs button").forEach((item) => item.classList.toggle("active", item === button));
  loadSeries(button.dataset.metric);
});

$("#event-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const body = Object.fromEntries(form.entries());
  try {
    await api("/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    event.currentTarget.reset();
    event.currentTarget.elements.handler.value = "SRE";
    event.currentTarget.elements.source.value = "manual";
    await loadEvents();
    showToast("事件已写入");
  } catch (error) {
    showToast(`事件写入失败：${error.message}`);
  }
});

refreshAll();
setInterval(refreshAll, 15000);
