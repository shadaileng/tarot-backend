---
title: 塔罗牌统一后台服务
emoji: 🔮
colorFrom: purple
colorTo: blue
sdk: docker
pinned: false
env:
  - name: GEMINI_API_KEY
    value: ""
    required: true
---

## 塔罗牌统一后台服务

整合 AI 解读（Gemini API）和海报生成（Puppeteer）的统一后端服务。

### API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/` | 服务信息 |
| `GET` | `/health` | 健康检查（Gemini + Chromium） |
| `GET` | `/metrics` | Prometheus 指标 |
| `POST` | `/reading` | AI 塔罗解读 |
| `POST` | `/poster` | 海报生成 PNG |
| `GET` | `/logs` | 查询解读日志 |

### 环境变量

| 变量 | 用途 | 必填 |
|------|------|:----:|
| `GEMINI_API_KEY` | Google Gemini API 密钥 | **✅** |
