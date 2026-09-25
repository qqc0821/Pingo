# dsh-plugin-pet-notify

DeepSeek Harness 主机插件:监听 DSH 的通知类事件,自动推送给 AI 桌面宠物(Pingo)显示气泡。

## 数据流

```
DSH 事件(turn/end / subagent/end / goal/changed …)
  → 本插件(POST)
  → Pingo 主进程本地入口 (http://127.0.0.1:8790/notify)
  → 宠物窗口:气泡 + 动画
```

> 通知路径**直连 Pingo**,不依赖 pet-mcp-server(8765)。
> pet-mcp-server 仅用于 agent 手动调用 `mcp__pet__*` 工具时控制宠物。

## 安装(接入 DSH web profile)

在 `~/.dsh/profiles/web/package.json` 的 `dependencies` 里加:

```json
"dsh-plugin-pet-notify": "file:/Users/nicolas/Projects_app/Pingo/dsh-plugin-pet-notify"
```

在 `~/.dsh/profiles/web/cordis.patch.yml` 里加一个 insert 项:

```yaml
- insert:
    - id: pet-notify
      name: 'dsh-plugin-pet-notify'
      config:
        url: http://127.0.0.1:8790/notify
        announceTurnEnd: true
        announceSubagentEnd: true
        announceGoalChange: true
        announceSessionCreated: false
```

然后在 profile 目录执行 `pnpm install`,并**重启 dsh web 服务**使新条目生效。

## 配置项

| 项 | 默认 | 说明 |
|---|---|---|
| `url` | `http://127.0.0.1:8790/notify` | 宠物通知地址(也可用环境变量 `DSH_PET_NOTIFY_URL` 覆盖) |
| `announceTurnEnd` | `true` | DSH 正常回复完成时通知(最常见的情况) |
| `announceSubagentEnd` | `true` | 后台子代理结束时通知 |
| `announceGoalChange` | `true` | 目标(goal)状态变更时通知 |
| `announceSessionCreated` | `false` | 新会话创建时通知(子代理也会建会话,噪声大,默认关闭) |

## 依赖的进程

- Pingo Electron 应用(端口 8790 的本地通知入口,`npm run dev` 或打包版)
