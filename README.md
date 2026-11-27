# WorkBuddy Bridge

鎶婅吘璁?WorkBuddy 璐﹀彿閲岀殑妯″瀷锛屾帴杩?**Codex** 鍜?**Claude**锛堟闈㈢増 + CLI锛夈€?
WorkBuddy 鏈韩涓嶆彁渚涘叕寮€鐨?OpenAI/Anthropic 鍏煎鎺ュ彛锛孋odex 鍜?Claude 涔熷悇璇村悇鐨勫崗璁€傝繖涓伐鍏峰湪鏈満璧蜂竴涓綉鍏筹細

```
Codex 妗岄潰鐗?/ CLI  鈹€鈹€鈻? http://127.0.0.1:4000/v1/responses   (OpenAI Responses API)
Claude 妗岄潰鐗?/ CLI  鈹€鈹€鈻? http://127.0.0.1:4001/v1/messages    (Anthropic Messages API)
                           鈹?                           鈻?                    WorkBuddy 涓婃父 (/v2/chat/completions)
```

Windows 涓婃槸涓€涓?*妗岄潰杞欢**锛氳瀹屽弻鍑绘墦寮€锛岄厤缃晫闈㈠湪绐楀彛閲岋紝缃戝叧璺熺潃绋嬪簭涓€璧疯窇锛屽叧鎺夌獥鍙ｅ畠缁х画鍦ㄦ墭鐩橀噷寰呯潃銆?
![妗岄潰杞欢](docs/desktop-shot.png)

---

## 鐗规€?
- **涓嶉渶瑕?WorkBuddy 瀹樻柟 API Key** 鈥斺€?鐩存帴澶嶇敤妗岄潰瀹㈡埛绔凡缁忕櫥褰曠殑浼氳瘽锛孴oken 杩囨湡鑷姩鍒锋柊銆?- **Windows 妗岄潰杞欢** 鈥斺€?瀹夎鍖呭弻鍑诲嵆鐢紝涓嶇敤瑁?Node锛涚晫闈€佺綉鍏炽€佸紑鏈鸿嚜鍚兘鍦ㄤ竴涓▼搴忛噷銆?- **涓や釜鍗忚鍚勪竴涓鍙?* 鈥斺€?Codex 鍙蛋 Responses API锛孋laude 鍙蛋 Messages API锛屼簰涓嶅共鎵般€?- **Claude 妗岄潰鐗堝吋瀹?* 鈥斺€?妗岄潰鐗堝彧鎺ュ彈 `claude-*` 褰㈠紡鐨勬ā鍨嬪悕锛屽伐鍏峰湪缃戝叧渚у仛鏄犲皠锛涜嚜鍔ㄧ敓鎴?`claude-sonnet-5` / `claude-opus-5` / `claude-fable-5` / `claude-haiku-4-5` 鍥涙潯璺敱銆?- **妯″瀷鐩綍鑷姩鍚屾** 鈥斺€?鎶?WorkBuddy 閲岀殑妯″瀷鍐欒繘 Codex 鐨勬ā鍨嬬洰褰曪紝妗岄潰鐗堟ā鍨嬮€夋嫨鍣ㄩ噷鐩存帴鑳介€夈€?- **cc-switch 淇濇姢** 鈥斺€?濡傛灉浣犺浜?cc-switch锛堜細鏀瑰啓鍚屼竴鎵归厤缃枃浠剁殑鍒囨崲鍣級锛屽伐鍏蜂細娉ㄥ唽鑷繁涓?provider 骞惰涓哄綋鍓嶏紝閬垮厤瀹冩妸閰嶇疆鏀瑰洖鍘汇€?- **鍙鏈満銆佸洖鐜湴鍧€** 鈥斺€?缃戝叧鍙洃鍚?127.0.0.1锛屾嫆缁濋潪鍥炵幆鐨?Host / Origin锛屽甫 Bearer 浠ょ墝銆?- **鍛戒护琛屽悓鏍峰彲鐢?* 鈥斺€?妗岄潰杞欢閲屾敼鐨勪笢瑗匡紝鍛戒护琛岄兘鑳芥敼锛屼袱杈瑰叡鐢ㄥ悓涓€濂楅厤缃枃浠躲€?
---

## 鐜瑕佹眰

| 椤圭洰 | 瑕佹眰 |
| --- | --- |
| 妗岄潰杞欢 | Windows 10/11 x64锛堝畨瑁呭寘鑷甫杩愯鏃讹級 |
| 璐﹀彿 | 宸插畨瑁呭苟鐧诲綍 WorkBuddy 妗岄潰瀹㈡埛绔?|
| 瀹㈡埛绔?| Codex銆丆laude Code 鎴?Claude 妗岄潰鐗堬紝鍙€?|
| 鍛戒护琛岀増 | Node.js 鈮?22.5锛堢敤鍒板唴缃?`node:sqlite` 鍋?cc-switch 淇濇姢锛?|

---

## 瀹夎锛圵indows 妗岄潰杞欢锛?
1. 浠?Releases 涓嬭浇 `WorkBuddy-Bridge-Setup-<鐗堟湰>.exe`锛?2. 鍙屽嚮瀹夎锛屽彲鑷€夊畨瑁呯洰褰曪紝浼氬垱寤烘闈㈠拰寮€濮嬭彍鍗曞揩鎹锋柟寮忥紱
3. 鍚姩銆學orkBuddy Bridge銆嶏紝绐楀彛閲屽氨鏄厤缃晫闈€?
杞欢鍚姩鍚庣綉鍏宠嚜鍔ㄥ湪鍚庡彴璺戯紝绐楀彛鍏虫帀瀹冪户缁湪绯荤粺鎵樼洏寰呯潃锛堟墭鐩樺浘鏍囧彸閿彲浠ラ噸鏂版墦寮€鐣岄潰鎴栭€€鍑猴級銆?
### 寮€鏈鸿嚜鍚?
閰嶇疆鐣岄潰銆岀綉鍏炽€嶅尯鍧楁湁銆屽紑鏈鸿嚜鍚€嶅紑鍏筹紝鍕句笂涔嬪悗鐧诲綍 Windows 鏃惰嚜鍔ㄥ惎鍔ㄧ綉鍏筹紙甯?`--hidden`锛屼笉寮圭獥鍙ｏ級銆?
### 鑷繁鏋勫缓瀹夎鍖?
```bash
git clone https://github.com/Lingw2/workbuddy-bridge.git
cd workbuddy-bridge
npm install
npm run dist        # 浜х墿鍦?release/
```

鍥藉唴缃戠粶涓嬭浇 Electron 浜岃繘鍒跺彲鑳藉緢鎱紝鍙互鍔犻暅鍍忥細

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npm run dist
```

---

## 鍛戒护琛岀増

```bash
git clone https://github.com/Lingw2/workbuddy-bridge.git
cd workbuddy-bridge
npm install

node bin/workbuddy-bridge.js ui     # 缃戝叧 + 娴忚鍣ㄦ墦寮€閰嶇疆椤?```

鍏ㄥ眬瀹夎锛?
```bash
npm install -g workbuddy-bridge
workbuddy-bridge ui
```

```bash
workbuddy-bridge ui                # 缃戝叧 + 閰嶇疆椤碉紙榛樿锛?workbuddy-bridge start             # 鍙捣缃戝叧
workbuddy-bridge status            # 鐪嬭繍琛岀姸鎬佸拰閰嶇疆鐘舵€?workbuddy-bridge doctor            # 鑷锛氳处鍙枫€佸鎴风銆侀厤缃€佺綉鍏?workbuddy-bridge models            # 鍒楀嚭璐﹀彿鍙敤鐨勬ā鍨?workbuddy-bridge install           # 鍐欓厤缃紙codex / claude-code / claude-desktop锛?workbuddy-bridge install codex cc-switch
workbuddy-bridge uninstall         # 绉婚櫎鍐欏叆鐨勯厤缃?```

鐜鍙橀噺锛歚WORKBUDDY_BRIDGE_UI_PORT`锛堥厤缃〉绔彛锛岄粯璁?4477锛夈€?
---

## 閰嶇疆鐣岄潰鑳藉仛浠€涔?
| 鍖哄潡 | 浣滅敤 |
| --- | --- |
| **璐﹀彿** | 鏄剧ず褰撳墠鐧诲綍鎬侊紙鍖哄煙 / 鍩熷悕 / 鏉ユ簮 / 鏈夋晥鏈燂級锛屽垪鍑哄彂鐜扮殑璐﹀彿鏂囦欢锛岀偣銆屽埛鏂版ā鍨嬪垪琛ㄣ€嶉噸鏂版媺鍙栥€?|
| **瀹㈡埛绔帴鍏?* | 閫愪釜鎴栦竴閿啓鍏?Codex銆丆laude Code銆丆laude 妗岄潰鐗堢殑閰嶇疆銆?|
| **妯″瀷涓庤矾鐢?* | 閫?Codex / Claude 鐨勯粯璁ゆā鍨嬨€佹帹鐞嗗己搴︼紱缂栬緫 Claude 璺敱琛紙璺敱鍚?鈫?WorkBuddy 妯″瀷銆佹。浣嶃€佹槸鍚﹂粯璁わ級銆?|
| **缃戝叧** | 鏌ョ湅涓や釜缃戝叧鏄惁鍦ㄨ窇锛屼慨鏀圭鍙ｏ紝鏌ョ湅/澶嶅埗浠ょ墝锛屽紑鏈鸿嚜鍚紑鍏炽€?|
| **鏃ュ織** | 缃戝叧鏈€杩?200 琛屾棩蹇椼€?|

銆屼竴閿帴鍏ュ叏閮ㄣ€嶄細鍋氫笁浠朵簨锛?
1. 鍐?`~/.codex/config.toml`锛屽姞涓?`[model_providers.workbuddy]`锛屽苟鎶婇《灞?`model_provider` 鎸囧悜瀹冿紱
2. 鍐?`~/.claude/settings.json` 鐨?`env` 鍧楋紱
3. 鍐?Claude 妗岄潰鐗堢殑 3p 閰嶇疆锛坄%LOCALAPPDATA%\Claude-3p\configLibrary\...`锛夈€?
姣忎竴姝ラ兘浼氬厛鎶婂師鏂囦欢澶嶅埗涓€浠?`.bak-workbuddy-<鏃堕棿鎴?`銆?
---

## 宸ヤ綔鍘熺悊

### 1. 鍑嵁浠庡摢鏉?
鎸夐『搴忔壘杩欎簺浣嶇疆锛屾壘鍒扮涓€涓彲鐢ㄧ殑锛?
| 浣嶇疆 | 璇存槑 |
| --- | --- |
| `~/.workbuddy-bridge/session.json` | 鏈伐鍏疯嚜宸辩殑缂撳瓨 |
| `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info` | WorkBuddy 妗岄潰绔櫥褰曟€?|
| `~/.dsh/workbuddy-vault/cn/*.json` | dsh 鎻掍欢鐨勫嚟鎹簱锛堜腑鍥界珯锛?|
| `~/.dsh/workbuddy-vault/global/*.json` | dsh 鎻掍欢鐨勫嚟鎹簱锛堝浗闄呯珯锛?|

鎷垮埌 `accessToken` / `refreshToken` 鍚庯紝Token 蹇繃鏈熸椂璋冪敤 `POST {chatBase}/v2/plugin/auth/token/refresh` 缁湡锛屽苟鎶婃柊 Token 鍐欏洖缂撳瓨銆?
### 2. 妯″瀷鐩綍

`GET {configBase}/v3/config` 鎷垮埌瀹屾暣鐩綍锛屽啀浠?`agents[name="cli"]` 閲屽彇鍑?CLI 鍙敤鐨勯偅鎵规ā鍨嬨€備腑鍥界珯鍦?`/v3/config` 澶辫触鏃跺洖钀藉埌 `/v2/enterprises/personal/models`銆?
### 3. 鍗忚杞崲

- **Responses 鈫?chat**锛歚input[]` 閲岀殑 `message` / `function_call` / `function_call_output` 杩樺師鎴?chat 鐨?`messages`锛宍tools[]`锛堟墎骞筹級杞垚宓屽鐨?`{type:'function',function:{...}}`銆?- **chat 鈫?Responses**锛氫笂娓?SSE 鐨?`delta.content` / `delta.tool_calls` / `delta.reasoning_content` 缈昏瘧鎴?`response.output_text.delta` / `response.function_call_arguments.delta` / `response.reasoning_summary_text.delta` 绛変簨浠躲€?- **Messages 鈫?chat**锛欰nthropic 鐨?`system` 鏁扮粍銆乣content` typed blocks銆乣tool_use` / `tool_result`銆乣thinking` 鍧椾笌 chat 浜掕浆銆?
### 4. 涓婃父 channel gate

WorkBuddy 涓婃父浼氭鏌?`system` / `assistant` 娑堟伅鐨勬帾杈烇紝鍛戒腑鍒殑 agent 鐨勮韩浠界壒寰佸氨杩斿洖 `11128`銆傚疄娴嬩笅鏉ワ細

- 鍖归厤鏄?*澶у皬鍐欎笉鏁忔劅鐨勪换鎰忎綅缃瓙涓插尮閰?*锛屼笉鏄墠缂€鍖归厤锛?- 涓婃父浼氬厛瑙勮寖鍖栦笉鍙瀛楃锛屾墍浠ユ彃闆跺绌烘牸娌＄敤锛屽繀椤荤湡鐨勬敼鎺緸锛?- 涓€鏉℃彁绀洪噷鍙兘鍛戒腑澶氬锛岃€屼笖鏈変簺鍛戒腑鏄€屼袱娈垫嫾鍦ㄤ竴璧枫€嶆墠绠楀懡涓€?
Claude Code 鐨勭郴缁熸彁绀洪噷鏈変袱澶勪細琚嫆锛屽伐鍏峰湪杞彂鍓嶈嚜鍔ㄦ敼鍐欙細

| 鍘熸枃 | 鏀瑰啓鍚?|
| --- | --- |
| `x-anthropic-billing-header:` | `x-request-metadata:` |
| `To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues` | `To give feedback, users should report the issue to the project maintainers` |

瑙勫垯鍦?`src/gateway/rewrite.js`锛屾敼涓婃父鎴栨崲瀹㈡埛绔増鏈椂鎸夐渶澧炲噺銆?
---

## 閰嶇疆鍐欏湪鍝?
| 瀹㈡埛绔?| 鏂囦欢 |
| --- | --- |
| Codex | `~/.codex/config.toml`銆乣~/.codex/cc-switch-model-catalog.json` |
| Claude Code | `~/.claude/settings.json` |
| Claude 妗岄潰鐗?| `%LOCALAPPDATA%\Claude-3p\configLibrary\00000000-0000-4000-8000-000000157210.json` |
| cc-switch | `~/.cc-switch/cc-switch.db`锛坧rovider 琛級銆乣~/.cc-switch/settings.json`銆乣~/.cc-switch/live-state.json` |
| 鏈伐鍏?| `~/.workbuddy-bridge/config.json`銆乣~/.workbuddy-bridge/session.json` |

妗岄潰杞欢鍜屽懡浠よ鐗堣鍐欑殑鏄悓涓€浠芥枃浠讹紝涓よ竟鍙互娣风敤銆?
---

## 宸茬煡闄愬埗

- **鍙敮鎸?WorkBuddy 妗岄潰绔殑鐧诲綍鎬?*銆傞渶瑕佸厛鍦?WorkBuddy 瀹㈡埛绔噷鐧诲綍涓€娆°€?- **Codex 0.163.0 鍙敮鎸?Responses API**銆俙wire_api = "chat"` 宸茶瀹樻柟绉婚櫎锛屽伐鍏峰洜姝よ嚜宸卞疄鐜颁簡 `/v1/responses`銆?- **Claude 妗岄潰鐗堢殑 `inferenceModels` 蹇呴』鏄?`claude-*` 褰㈠紡**锛屾闈㈢増浼氭嫆缁濆惈 `deepseek` / `glm` / `kimi` / `gpt` 绛夊瓧鏍风殑 id銆?- **cc-switch 蹇呴』鍦ㄩ€€鍑虹姸鎬佷笅鎵嶈兘鍐欏畠鐨勬暟鎹簱**銆傝窇鐫€鐨勬椂鍊欏伐鍏蜂細璺宠繃杩欎竴姝ュ苟鎻愮ず銆?- **瀹夎鍖呮病鏈変唬鐮佺鍚?*锛學indows SmartScreen 鍙兘鎻愮ず鏈煡鍙戝竷鑰呫€?- 宸ュ叿璇诲啓鐨勬槸鍒汉鐨勮处鍙锋暟鎹紝鐢ㄥ湪鍝効銆佹€庝箞鐢紝璇疯嚜宸卞垽鏂€?
---

## 寮€鍙?
```bash
npm test                   # 鍗忚杞崲鐨勫崟鍏冩祴璇?npm run smoke              # 瀵圭潃鐪熷疄缃戝叧璺戜竴杞鍒扮
npm run desktop            # 寮€鍙戞ā寮忓惎鍔ㄦ闈㈣蒋浠?npm run icon               # 閲嶆柊鐢熸垚鍥炬爣
node bin/workbuddy-bridge.js doctor
```

鐩綍缁撴瀯锛?
```
bin/            CLI 鍏ュ彛
desktop/        Electron 妗岄潰澶栧３锛氱獥鍙ｃ€佹墭鐩樸€佸紑鏈鸿嚜鍚?src/app.js      搴旂敤瀹瑰櫒锛氱綉鍏炽€佹ā鍨嬨€乁I
src/upstream/   WorkBuddy 涓婃父锛氬嚟鎹€佹ā鍨嬬洰褰曘€丼SE
src/gateway/    鍗忚杞崲灞傦細Anthropic / Responses / 鏀瑰啓
src/config/     瀹㈡埛绔厤缃鍐欙細Codex / Claude / cc-switch / TOML
src/ui/         閰嶇疆椤碉紙鍘熺敓 HTML + JS锛屾棤鏋勫缓姝ラ锛?test/           娴嬭瘯
tools/          鍥炬爣鐢熸垚銆佹埅鍥俱€佽瘖鏂剼鏈?```

鍥炬爣鏄剼鏈敾鍑烘潵鐨勶紙`tools/make-icon.mjs`锛屾墜鍐?PNG 缂栫爜鍣級锛屼粨搴撻噷涓嶆斁浜岃繘鍒剁礌鏉愶紝鏀归厤鑹查噸璺戣剼鏈嵆鍙€?
## License

MIT锛岃 [LICENSE](LICENSE)銆?