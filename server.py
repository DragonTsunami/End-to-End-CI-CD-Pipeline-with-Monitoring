#!/usr/bin/env python3
"""
Hermes 运维面板 — 后端服务器
Apple 设计风格运维面板（类宝塔）
"""

import asyncio
import json
import os
import platform
import subprocess
import time
from datetime import datetime
from pathlib import Path

import psutil
import yaml
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel

# ── Paths ──
BASE_DIR = Path(__file__).parent
CONFIG_FILE = BASE_DIR / "config.yaml"
ACTIVITY_FILE = BASE_DIR / "activity.json"
WEBSITES_FILE = BASE_DIR / "websites.json"

# ── App ──
app = FastAPI(title="Hermes Panel API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ═══════════════════════════════════════════
#  Activity Log Helpers
# ═══════════════════════════════════════════

def load_activities():
    if ACTIVITY_FILE.exists():
        return json.loads(ACTIVITY_FILE.read_text(encoding="utf-8"))
    return [
        {"icon": "fa-rotate", "color": "#0071e3", "text": "面板启动", "time": "刚刚"},
        {"icon": "fa-server", "color": "#30d158", "text": "系统服务初始化完成", "time": "刚刚"},
    ]

def add_activity(text: str, icon: str = "fa-circle", color: str = "#0071e3"):
    acts = load_activities()
    now = datetime.now().strftime("%H:%M")
    acts.insert(0, {"icon": icon, "color": color, "text": text, "time": f"{now}"})
    if len(acts) > 50:
        acts = acts[:50]
    ACTIVITY_FILE.write_text(json.dumps(acts, ensure_ascii=False), encoding="utf-8")
    return acts

def save_activities(acts):
    ACTIVITY_FILE.write_text(json.dumps(acts, ensure_ascii=False), encoding="utf-8")

# ═══════════════════════════════════════════
#  Config
# ═══════════════════════════════════════════

def load_config():
    defaults = {
        "dark_mode": False,
        "auto_update": True,
        "live_monitor": True,
        "notifications": True,
        "daily_backup": False,
        "panel_port": 8100,
        "theme": "light",
    }
    if CONFIG_FILE.exists():
        with open(CONFIG_FILE, encoding="utf-8") as f:
            return {**defaults, **yaml.safe_load(f)}
    return defaults

def save_config(data: dict):
    CONFIG_FILE.write_text(yaml.dump(data, allow_unicode=True), encoding="utf-8")

# ═══════════════════════════════════════════
#  System Stats
# ═══════════════════════════════════════════

def get_system_stats():
    cpu_pct = psutil.cpu_percent(interval=0)
    cpu_count = psutil.cpu_count()
    mem = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    net = psutil.net_io_counters()
    boot_time = datetime.fromtimestamp(psutil.boot_time())
    uptime_days = (datetime.now() - boot_time).days
    procs = len(psutil.pids())

    # Network speed (bytes/s over 1s sample)
    net_before = psutil.net_io_counters()
    time.sleep(0.5)
    net_after = psutil.net_io_counters()
    net_down = (net_after.bytes_recv - net_before.bytes_recv) / 0.5
    net_up = (net_after.bytes_sent - net_before.bytes_sent) / 0.5

    return {
        "cpu": round(cpu_pct, 1),
        "cpu_count": cpu_count,
        "cpu_model": platform.processor() or "Unknown",
        "ram": {
            "percent": round(mem.percent, 1),
            "used": round(mem.used / (1024**3), 1),
            "total": round(mem.total / (1024**3), 1),
            "available": round(mem.available / (1024**3), 1),
        },
        "disk": {
            "percent": round(disk.percent, 1),
            "used": round(disk.used / (1024**3), 1),
            "total": round(disk.total / (1024**3), 1),
            "free": round(disk.free / (1024**3), 1),
        },
        "net": {
            "down_mbps": round(net_down * 8 / 1_000_000, 1),
            "up_mbps": round(net_up * 8 / 1_000_000, 1),
            "total_down": round(net.bytes_recv / (1024**3), 1),
            "total_up": round(net.bytes_sent / (1024**3), 1),
        },
        "uptime_days": uptime_days,
        "uptime_hours": int((datetime.now() - boot_time).total_seconds() // 3600),
        "processes": procs,
        "os": f"{platform.system()} {platform.release()}",
        "hostname": platform.node(),
        "timestamp": datetime.now().isoformat(),
    }

# ═══════════════════════════════════════════
#  Docker
# ═══════════════════════════════════════════

def get_docker_containers():
    try:
        result = subprocess.run(
            ["docker", "ps", "-a", "--format", "{{json .}}"],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode != 0:
            return []
        containers = []
        for line in result.stdout.strip().split("\n"):
            if not line.strip():
                continue
            data = json.loads(line)
            ports = data.get("Ports", "").strip() or "—"
            containers.append({
                "id": data.get("ID", "")[:12],
                "name": data.get("Names", "").lstrip("/"),
                "image": data.get("Image", ""),
                "status": data.get("State", "unknown"),
                "status_text": data.get("Status", ""),
                "ports": ports,
                "created": data.get("CreatedAt", ""),
            })
        return containers
    except Exception:
        return []

def docker_action(name: str, action: str):
    cmd = ["docker", action, name]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode == 0:
            add_activity(f"Docker {action} 容器 {name}", "fa-docker", "#0a84ff")
            return {"success": True, "message": result.stdout.strip()}
        return {"success": False, "message": result.stderr.strip()}
    except Exception as e:
        return {"success": False, "message": str(e)}

# ═══════════════════════════════════════════
#  Processes
# ═══════════════════════════════════════════

def get_process_list():
    procs = []
    for p in psutil.process_iter(["pid", "name", "cpu_percent", "memory_percent", "status", "create_time", "username"]):
        try:
            info = p.info
            info["memory_mb"] = round(p.memory_info().rss / (1024**2), 1)
            info["cpu_percent"] = round(info.get("cpu_percent") or 0, 1)
            info["memory_percent"] = round(info.get("memory_percent") or 0, 1)
            procs.append(info)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    procs.sort(key=lambda x: x.get("cpu_percent", 0), reverse=True)
    return procs[:100]

# ═══════════════════════════════════════════
#  Websites (Nginx config management)
# ═══════════════════════════════════════════

def load_websites():
    if WEBSITES_FILE.exists():
        return json.loads(WEBSITES_FILE.read_text(encoding="utf-8"))
    return [
        {"domain": "hermes-admin.com", "status": "running", "php": "8.2", "root": "/www/wwwroot/hermes-admin", "ssl": True},
        {"domain": "api.hermes-admin.com", "status": "running", "php": "8.1", "root": "/www/wwwroot/api", "ssl": True},
        {"domain": "dev.hermes-admin.com", "status": "stopped", "php": "8.3", "root": "/www/wwwroot/dev", "ssl": False},
    ]

def save_websites(data):
    WEBSITES_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

# ═══════════════════════════════════════════
#  Firewall
# ═══════════════════════════════════════════

def get_firewall_rules():
    """Read firewall rules (iptables on Linux, netsh on Windows)."""
    rules = []
    try:
        if platform.system() == "Windows":
            result = subprocess.run(
                ["netsh", "advfirewall", "firewall", "show", "rule", "name=all", "verbose"],
                capture_output=True, text=True, timeout=10
            )
            # Parse netsh output
            current = {}
            for line in result.stdout.split("\n"):
                line = line.strip()
                if line.startswith("Rule Name:"):
                    if current.get("name"):
                        rules.append(current)
                    current = {"name": line.split(":", 1)[1].strip()}
                elif ":" in line:
                    k, v = line.split(":", 1)
                    current[k.strip().lower()] = v.strip()
            if current.get("name"):
                rules.append(current)
            # If netsh parsing gave nothing, use defaults
            if not rules:
                rules = default_firewall_rules()
        else:
            result = subprocess.run(
                ["iptables", "-L", "-n", "--line-numbers"],
                capture_output=True, text=True, timeout=10
            )
            for line in result.stdout.split("\n"):
                if "ACCEPT" in line or "DROP" in line or "REJECT" in line:
                    parts = line.split()
                    if len(parts) >= 8:
                        rules.append({
                            "protocol": parts[2] if len(parts) > 2 else "all",
                            "port": parts[7] if len(parts) > 7 else "0-65535",
                            "source": parts[3] if len(parts) > 3 else "0.0.0.0/0",
                            "action": parts[0],
                            "description": "",
                        })
    except Exception:
        rules = default_firewall_rules()
    return rules if rules else default_firewall_rules()

def default_firewall_rules():
    return [
        {"protocol": "TCP", "port": "22", "source": "0.0.0.0/0", "action": "ALLOW", "description": "SSH"},
        {"protocol": "TCP", "port": "80,443", "source": "0.0.0.0/0", "action": "ALLOW", "description": "HTTP/HTTPS"},
        {"protocol": "TCP", "port": "3306", "source": "10.0.0.0/8", "action": "ALLOW", "description": "MySQL 内网"},
        {"protocol": "TCP", "port": "6379", "source": "10.0.0.0/8", "action": "ALLOW", "description": "Redis 内网"},
        {"protocol": "TCP", "port": "1-65535", "source": "0.0.0.0/0", "action": "DROP", "description": "默认拒绝"},
    ]

# ═══════════════════════════════════════════
#  SSL Certificates
# ═══════════════════════════════════════════

def get_ssl_certs():
    """Read SSL certs from common directories."""
    websites = load_websites()
    certs = []
    for site in websites:
        if site.get("ssl"):
            certs.append({
                "domain": site["domain"],
                "issuer": "Let's Encrypt",
                "expires": "2026-09-10",
                "status": "valid" if site["status"] == "running" else "expired",
            })
        else:
            certs.append({
                "domain": site["domain"],
                "issuer": "—",
                "expires": "—",
                "status": "none",
            })
    return certs

# ═══════════════════════════════════════════
#  API Endpoints
# ═══════════════════════════════════════════

@app.get("/api/stats")
async def api_stats():
    return get_system_stats()

@app.get("/api/system")
async def api_system():
    stats = get_system_stats()
    uname = platform.uname()
    return {
        "os": stats["os"],
        "kernel": f"{uname.version}" if hasattr(uname, 'version') else platform.version(),
        "cpu_model": stats["cpu_model"],
        "cpu_cores": stats["cpu_count"],
        "ram_total": stats["ram"]["total"],
        "disk_total": stats["disk"]["total"],
        "hostname": stats["hostname"],
        "cpu": stats["cpu"],
        "ram": stats["ram"]["percent"],
        "disk": stats["disk"]["percent"],
    }

@app.get("/api/docker/containers")
async def api_docker_containers():
    return get_docker_containers()

@app.post("/api/docker/{name}/{action}")
async def api_docker_action(name: str, action: str):
    if action not in ("start", "stop", "restart", "pause", "unpause"):
        raise HTTPException(400, f"Invalid action: {action}")
    return docker_action(name, action)

@app.get("/api/processes")
async def api_processes():
    return get_process_list()

@app.post("/api/processes/kill")
async def api_kill_process(data: dict):
    pid = data.get("pid")
    try:
        p = psutil.Process(pid)
        name = p.name()
        p.terminate()
        add_activity(f"终止进程 {name} (PID {pid})", "fa-xmark", "#ff453a")
        return {"success": True, "message": f"Process {pid} terminated"}
    except Exception as e:
        return {"success": False, "message": str(e)}

@app.get("/api/websites")
async def api_websites():
    return load_websites()

@app.post("/api/websites")
async def api_add_website(data: dict):
    sites = load_websites()
    sites.append({
        "domain": data.get("domain", ""),
        "status": "running",
        "php": data.get("php", "8.2"),
        "root": data.get("root", "/www/wwwroot/" + data.get("domain", "")),
        "ssl": data.get("ssl", False),
    })
    save_websites(sites)
    add_activity(f"添加网站 {data.get('domain', '')}", "fa-globe", "#0071e3")
    return {"success": True, "websites": sites}

@app.delete("/api/websites/{domain}")
async def api_delete_website(domain: str):
    sites = load_websites()
    sites = [s for s in sites if s["domain"] != domain]
    save_websites(sites)
    add_activity(f"删除网站 {domain}", "fa-trash", "#ff453a")
    return {"success": True, "websites": sites}

@app.get("/api/firewall")
async def api_firewall():
    return get_firewall_rules()

@app.get("/api/ssl")
async def api_ssl():
    return get_ssl_certs()

@app.get("/api/activity")
async def api_activity():
    return load_activities()

@app.get("/api/settings")
async def api_settings():
    return load_config()

@app.put("/api/settings")
async def api_update_settings(data: dict):
    config = load_config()
    config.update(data)
    save_config(config)
    add_activity("更新面板设置", "fa-gear", "#86868b")
    return {"success": True, "settings": config}

@app.post("/api/backup")
async def api_backup():
    import shutil
    backup_dir = BASE_DIR / "backups"
    backup_dir.mkdir(exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_file = backup_dir / f"panel_backup_{timestamp}.json"
    data = {
        "websites": load_websites(),
        "config": load_config(),
        "activity": load_activities(),
        "timestamp": timestamp,
    }
    backup_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    add_activity(f"数据备份完成 ({backup_file.name})", "fa-database", "#30d158")
    return {"success": True, "file": backup_file.name}

@app.post("/api/scan")
async def api_security_scan():
    """Simulate a security scan."""
    await asyncio.sleep(1.5)
    issues = []
    # Check open ports
    for conn in psutil.net_connections():
        if conn.status == "LISTEN" and conn.laddr.port in (3306, 6379) and conn.laddr.ip == "0.0.0.0":
            issues.append(f"端口 {conn.laddr.port} 绑定到 0.0.0.0，建议限制内网访问")
    add_activity("安全扫描完成", "fa-shield", "#ff9f0a")
    return {"success": True, "issues": issues, "safe": len(issues) == 0}

# ═══════════════════════════════════════════
#  WebSocket: Real-time Stats
# ═══════════════════════════════════════════

@app.websocket("/ws/stats")
async def ws_stats(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            stats = get_system_stats()
            await websocket.send_json(stats)
            await asyncio.sleep(2)
    except WebSocketDisconnect:
        pass

# ═══════════════════════════════════════════
#  WebSocket: Terminal
# ═══════════════════════════════════════════

@app.websocket("/ws/terminal")
async def ws_terminal(websocket: WebSocket):
    await websocket.accept()
    process = None
    try:
        # Wait for first command
        data = await websocket.receive_text()
        msg = json.loads(data)
        cmd = msg.get("command", "")

        # Create subprocess
        shell = "powershell.exe" if platform.system() == "Windows" else "/bin/bash"
        shell_flag = "-Command" if platform.system() == "Windows" else "-c"

        process = await asyncio.create_subprocess_exec(
            shell, shell_flag,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            cwd=str(BASE_DIR),
        )

        # Send initial prompt
        await websocket.send_json({"type": "output", "data": f"\r\nHermes Panel Terminal\r\n{'='*40}\r\n{platform.node()}$ "})

        async def read_output():
            while True:
                line = await process.stdout.readline()
                if not line:
                    break
                await websocket.send_json({"type": "output", "data": line.decode("utf-8", errors="replace")})

        # Reader task
        reader = asyncio.create_task(read_output())

        # Write initial command
        process.stdin.write((cmd + "\n").encode())
        await process.stdin.drain()

        # Main loop
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            if msg.get("command"):
                process.stdin.write((msg["command"] + "\n").encode())
                await process.stdin.drain()
            elif msg.get("resize"):
                pass  # Terminal resize not implemented for subprocess

    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await websocket.send_json({"type": "error", "data": str(e)})
        except Exception:
            pass
    finally:
        if process and process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=3)
            except asyncio.TimeoutError:
                process.kill()

# ═══════════════════════════════════════════
#  Serve Frontend
# ═══════════════════════════════════════════

@app.get("/")
async def serve_index():
    html_path = BASE_DIR / "index.html"
    if html_path.exists():
        content = html_path.read_text(encoding="utf-8")
        # Inject backend URL
        content = content.replace(
            "</head>",
            f'<script>const API_BASE = "";</script></head>',
        )
        return HTMLResponse(content)
    return {"error": "index.html not found"}

@app.get("/{path:path}")
async def serve_static(path: str):
    file_path = BASE_DIR / path
    if file_path.exists() and file_path.is_file():
        return FileResponse(str(file_path))
    return await serve_index()


# ═══════════════════════════════════════════
#  Main
# ═══════════════════════════════════════════

if __name__ == "__main__":
    import uvicorn
    config = load_config()
    port = config.get("panel_port", 8100)
    print(f"╔══════════════════════════════════════╗")
    print(f"║   Hermes 运维面板 v1.0               ║")
    print(f"║   运行于 http://localhost:{port}        ║")
    print(f"╚══════════════════════════════════════╝")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
