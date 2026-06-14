# Hermes Panel — 运维面板

Apple 设计风格的宝塔形式运维面板，FastAPI + psutil 后端，实时系统监控。

## 快速启动

```bash
pip install fastapi uvicorn psutil websockets pyyaml aiofiles
python3 server.py
```

打开浏览器访问 **http://localhost:8100**

## 功能模块

| 页面 | 功能 | 数据源 |
|------|------|--------|
| 仪表盘 | CPU/内存/磁盘/网络/运行时间实时监控、折线图 | `psutil` |
| 网站管理 | CRUD 网站配置、Nginx 虚拟主机管理 | JSON 持久化 |
| 数据库 | MySQL / Redis 状态监控 | 系统检测 |
| Docker | 容器列表、启动/停止/重启操作 | `docker ps` CLI |
| 进程管理 | 进程列表(CPU/内存排序)、一键终止 | `psutil` |
| Web 终端 | WebSocket 实时终端、远程命令行 | subprocess |
| 防火墙 | 防火墙规则查看 (iptables / netsh) | 系统命令 |
| SSL 证书 | 证书到期时间、状态跟踪 | 网站关联 |
| 系统信息 | 硬件详情、资源进度条 | `platform` + `psutil` |
| 系统设置 | 深色模式/通知/备份 持久化设置 | YAML 文件 |

## API 端点

```
GET  /api/stats          系统实时状态
GET  /api/system         硬件信息
GET  /api/docker/containers  Docker 容器
POST /api/docker/{name}/{action}  容器操作
GET  /api/processes      进程列表
POST /api/processes/kill 终止进程
GET  /api/websites       网站列表
POST /api/websites       添加网站
DELETE /api/websites/{domain}  删除网站
GET  /api/firewall       防火墙规则
GET  /api/ssl            SSL 证书
GET  /api/activity       活动日志
GET  /api/settings       面板设置
PUT  /api/settings       更新设置
POST /api/backup         一键备份
POST /api/scan           安全扫描
WS   /ws/stats           实时状态推送
WS   /ws/terminal        Web 终端
```

## 技术栈

- **后端**: Python 3.10+ / FastAPI / uvicorn
- **前端**: Vanilla HTML/CSS/JS + Chart.js + Font Awesome
- **系统接口**: psutil / Docker CLI / netsh(Windows) / iptables(Linux)

## 设计

Apple 设计风格：SF Pro 字体栈、毛玻璃效果(`backdrop-filter`)、柔和阴影、渐变圆角、深色模式支持。
