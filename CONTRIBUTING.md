# 贡献指南

感谢参与。这个项目很小，改动前先看一眼下面的约定，能省掉很多来回。

## 开发环境

- Node.js ≥ 22.5（`node:sqlite` 是内置模块，cc-switch 保护依赖它）
- 运行时零依赖；`npm install` 只是为了开发工具（测试、Electron、打包）

```bash
npm test                   # 单元测试
npm run smoke              # 端到端（需要先起网关）
npm run desktop            # 开发模式启动桌面软件
npm run icon               # 重新生成图标
node bin/workbuddy-bridge.js doctor
```

## 桌面软件

`desktop/` 是 Electron 外壳，负责窗口、托盘、开机自启和菜单；配置界面和网关逻辑仍然在 `src/`，两边共用同一份实现和同一份配置文件。

- 外壳是 ESM（`"type": "module"`），不要用 `require()`。
- 窗口关闭不退出程序：网关要继续在托盘里待着。
- 开机自启直接写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`（`desktop/autostart.js`），不用 Electron 的 `setLoginItemSettings` —— 开发态下它会以 Electron 的可执行文件名写注册表。
- 打包时 `build.files` 必须带上整个 `desktop/` 目录（`desktop/**/*.js`），漏文件会在用户机器上才暴露。

## 代码风格

- ESM，Node 内置模块优先，不要引入运行时依赖。
- 文件顶部写一段注释说明这个文件负责什么，尤其是协议转换的部分 —— 上游的字段形状很容易记混。
- 注释解释「为什么」，不复述代码在做什么。

## 改协议转换层要特别小心

`src/gateway/anthropic.js` 和 `src/gateway/responses.js` 里的字段形状，都是从真实客户端抓包反推出来的：

- Anthropic 的 `system` 是**数组**，`messages[].content` 是**typed blocks 数组**，`tools[]` 是**扁平**的 `{name, description, input_schema}`。
- Responses 的 `input[]` 混合 `message` / `function_call` / `function_call_output` 三种 item，`tools[]` 也是**扁平**的 `{type:'function', name, description, parameters}`。

改动前先确认客户端版本有没有升级。抓包可以用 mock server + 真实 CLI 的方式，不用真连上游。

## 上游 channel gate 规则

`src/gateway/rewrite.js` 里的规则表是实测出来的，不是猜的：

- 上游做的是**大小写不敏感的任意位置子串匹配**；
- 上游会规范化不可见字符，插零宽字符无效，必须改措辞；
- 一条提示可能命中多处，有些命中是两段组合。

如果客户端升级后开始报 `11128`，按这个顺序排查：把 system 提示按行逐条发上游测，找出独立即被拒的行，再在规则表里补对应改写。

## 别提交这些东西

- `~/.workbuddy-bridge/` 里的任何东西（会话、Token、配置）
- `config.json`、`*.local.json`
- `dumps/`、`captures/`、`*.log`
- 抓包原样内容（可能含用户提示词）

`.gitignore` 已经覆盖了大部分，提交前再扫一眼 `git status`。

## 每日积分功能

`src/credit/service.js` 负责每天自动领积分，`src/upstream/credit.js` 是那套 billing 接口的封装。

- **上游是幂等的** —— 当天重复签到只会返回「今天已签到，请明天再来」。所以代码仍然先查 `today_checked_in` 再决定要不要领，因为「今天领过了」和「今天领到了」是两回事。
- **按本地日历日切分**，跨零点自动开始新的一天；状态落在 `~/.workbuddy-bridge/credit-state.json`，进程重启不重复领。
- **每个通道互相独立**。一次性活动挂了不影响每日签到。
- **失败退避重试**（1/5/15/30/60 分钟），不硬打上游。
- **只有上游标成 `available` 的阶梯才兑**，锁定状态绝不发写请求。
- 测试用本地 mock 上游（`test/credit.test.mjs`、`test/credit-service.test.mjs`），不连真实上游 —— 真实上游一天只能领一次，测不了第二次。

改 billing 接口时注意路径前缀不统一：`checkin-activity-status` 和 `daily-checkin` 带 `/v2`，而 `compensation-status` / `check-gift-claimed` / `claim-*` **不带** `/v2`（带了会 404）。

## 第三方免费渠道

`src/channels/` 放了十家第三方服务的账号与领取逻辑（providers.js 是接口，store.js 是账号库，service.js 是调度器，probe.js 是连通检测，dsh-store.js 负责从 dsh 插件那边读账号）。

- **每家上游的字段形状都不一样**，别照抄别家：LobsterAI 的活动上下文在 `/{code}/context?configRevision=` 且要带 `state.claimedToday`；Qoder 领的是 `campaigns` 里的 `CLAIM_BENEFIT`；MiniMax 是 7 天日历面板（看 `is_today` 那一天的 `status`）；TRAE 的鉴权头是 `Cloud-IDE-JWT` 而不是 `Bearer`；Loomy 成功码是字符串 `'000000'`。
- **区分「今天没领」和「看不出来」**。有些上游不告诉今天领没领（比如 ZCode 的领取端点被验证码挡着，Loomy 只有额度流水），这时候 `todayCheckedIn` 要给 `null`，界面上显示「—」，不要谎报成「今天未领」再反复去打。
- **一次只打一个账号**。这些上游对并发敏感，串行来。
- **领之前先查状态**，已领的账号跳过，不要天天去打扰。
- **ZCode 的 captcha 不绕**。上游对领取端点强制人机验证，工具明确报「需要在官网手动领取」。
- 测试同样用本地 mock（`test/channels.test.mjs`），mock 上游通过 `credential.baseUrl` 指向本地端口。

改渠道代码时，先确认上游接口形状 —— 参考实现可以看 dsh 插件的 `vendor/channel-pack/pack.js`（本机已安装的包里就有），但**不要直接依赖那个包**，它是别人的构建产物。

## 提交前自查

```bash
node --test "test/**/*.test.mjs"
node bin/workbuddy-bridge.js status
git diff --stat
```

如果改动涉及写客户端配置，请在本机实际跑一遍：

```bash
node bin/workbuddy-bridge.js install
codex exec --skip-git-repo-check --model deepseek-v4-pro "reply with exactly: OK"
claude -p "reply with exactly: OK" --model claude-sonnet-5
```

## 提 issue

带上这些信息会快很多：

- 系统（Windows / macOS / Linux）和 Node 版本
- `workbuddy-bridge doctor` 的输出
- 客户端版本（Codex / Claude Code / Claude 桌面版）
- 相关日志（**去掉 Token 和提示词内容**）

## License

贡献即表示同意以 MIT 协议发布。
