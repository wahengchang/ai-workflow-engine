# RFC 0002 — AWE CLI 從零重新設計

Status: **PROPOSED / NOT IMPLEMENTED**
取代：v0.1 的 CLI 介面（`run` / `simulate` / `dev` 三套並存、11 個 flag）。
不變：workflow 檔案格式（`ENTRY.md`、編號 `.md`、`FLOW.json`、`{{ steps["1.1"].output }}`）。

## 1. 要解決的問題

四個使用者角色在實際操作中，真正重複的動作只有一個：**跑某一步 → 看結果 → 改 prompt → 再跑**。
v0.1 把這個動作拆成 `run`、`simulate`、`dev`，並且：

- `run` 預設用 echo，卻顯示 `COMPLETED`，第一次使用的人以為內容已生成。
- 要接真的 AI CLI，得寫 `executor.argv` 陣列，或自己寫 wrapper（claude 要 `-p`、omp 要 `-p` 加 stdin、opencode 只吃參數）。
- timeout 固定 120 秒、無法由 CLI 覆蓋，逾時後 stderr 被丟掉。
- 切點錯誤只回 `Unknown cut point`，不列合法值。
- 需要值的 flag 會吞掉下一個 flag。
- `status` / `inspect` 只能在 workflow 根目錄跑，否則吐 raw `ENOENT`。

## 2. 設計原則

1. **一個動作一個命令。** 只有 `run` 會執行東西；其他命令都是唯讀。
2. **整個 workflow 是逐步累積出來的。** 從 1.1 單獨跑起，1.2 用 1.1 的結果單獨跑，一路往下。完整跑一次只是這個過程的最後一步。
3. **cache 只有一個開關**，而且每次輸出都明講這次有沒有用 cache。
4. **config 裡寫一條命令字串**，不是 JSON 陣列、不是 type/argv。
5. **沒有假的成功。** 沒設定 executor 就報錯，不再退回 echo。
6. **每個錯誤都要可行動：** 說發生什麼、為什麼、下一條命令是什麼；列舉型的值一律列出合法選項。

## 3. 命令

```text
awe init <dir>                     建立 workflow，偵測 PATH 上的 AI CLI 並寫入 awe.json
awe run  [dir] [step] [options]    執行（唯一會呼叫 executor 的命令）
awe show [dir] [step] [options]    看結果（取代 status / inspect / explain）
awe check [dir]                    validate + plan + 檢查 executor 是否可用（取代 validate / plan / doctor）
```

- `dir` 省略時為目前目錄，並**往上層尋找 `ENTRY.md`**，所以在子資料夾裡也能跑。
- `step` 是形如 `1.2`、`3.1.2`、`2.1.1@2`（LOOP 第 2 圈）的位址。`dir` 與 `step` 靠格式區分，因此在 workflow 裡直接 `awe run 1.2` 即可。
- 全部命令都支援 `--json`。

### `awe run` 的 flag（共 6 個）

| Flag | 說明 |
| --- | --- |
| `--var key=value` | 覆蓋 `awe.json` 的 input，可重複 |
| `--cache` / `--no-cache` | 同一個開關的兩種狀態，見 §5 |
| `--dry` | 只渲染 prompt，不呼叫 executor、不寫 cache、不建立 run（取代 `simulate` 與 echo） |
| `--executor <name>` | 使用 `awe.json` 裡具名的 executor，缺值時錯誤訊息列出所有名稱 |
| `--timeout <seconds>` | 覆蓋這次的 timeout |
| `--json` | 機器可讀輸出 |

### `awe show`

```text
awe show                  最近一次 run 的摘要：每步的狀態、是否來自 cache、輸出檔路徑
awe show 1.2              1.2 的輸出文字
awe show 1.2 --prompt     1.2 實際送出的渲染後 prompt
awe show 1.2 --err        1.2 的 stderr（失敗或逾時時最有用）
awe show --run <id>       指定某次 run，預設為最近一次
```

## 4. 設定：`awe.json`

```json
{
  "version": 2,
  "input": { "topic": "How to choose coffee beans" },
  "run": "claude -p {prompt}",
  "timeout": 300,
  "executors": {
    "search": { "run": "omp -p --tools websearch {prompt}", "timeout": 900 }
  },
  "steps": {
    "1.1": { "executor": "search" },
    "2.1": { "timeout": 600 }
  }
}
```

- `run` 是預設 executor。`executors.<name>` 為具名 executor，可帶自己的 `timeout`。
- `steps.<id>.executor` 與 `steps.<id>.timeout` 針對單一步驟覆蓋。優先順序：CLI flag > `steps.<id>` > 具名 executor > 頂層預設。
- 檔案格式不動，所以不採用 prompt 檔 front-matter，per-step 設定留在 `awe.json`（`steps` 這個 key v0.1 就已存在，用於 output files）。
- `steps.<id>.outputs`（named output files）維持 `docs/dev-mode.md` 的語意。

### 命令字串與 `{prompt}`

字串以**引號感知的方式切成 argv，再逐一代入，不經過 shell**，所以 prompt 內容不會被當成 shell 語法。三種寫法：

| 寫法 | 行為 |
| --- | --- |
| 含 `{prompt}` | 渲染後的 prompt 放進該參數。過長時（預設超過 64 KB）自動改為檔案路徑，見下 |
| 含 `{prompt_file}` | 永遠代入渲染後 prompt 檔的絕對路徑 |
| 都沒有 | prompt 從 stdin 送入 |

prompt 本身是一份含變數的 md。AWE 會先把變數渲染完，存成
`.awe/runs/<run-id>/prompts/<step>.md`，這份檔案就是 `show --prompt` 看到的內容。
當它太長不適合放進參數，`{prompt}` 自動換成一句短指示：`Read and follow the instructions in <絕對路徑>`。使用者不需要自己寫 wrapper。

`awe init` 會偵測 PATH 上的 `claude` / `codex` / `opencode` / `omp`，把第一個找到的寫入 `run`；都沒有時 `run` 為空，`awe run` 會直接報錯並印出四種可貼上的範例。

## 5. cache 規則

一個開關，預設值由「有沒有指定 step」決定，因為這就是兩種使用情境：

| 命令 | 預設 | 行為 |
| --- | --- | --- |
| `awe run . 1.2` | cache 開 | 上游用 cache；上游沒有有效 cache 就先跑；**1.2 本身一定重跑**（AI 每次輸出不同，重抽是常見動作） |
| `awe run .` | cache 關 | 從 1.1 開始整個重跑，不讀 cache |
| 任一種加 `--cache` | 開 | 有效的 step 一律重用，連完整 run 也只補缺的 |
| 任一種加 `--no-cache` | 關 | 包含上游全部重跑 |

每次輸出第一段固定標明模式，使用者不需要記預設值：

```text
$ awe run 1.2
Workflow  coffee (6 steps)       Executor  claude -p {prompt}
Cache     on — upstream reused, 1.2 always runs (use --no-cache to rerun everything)

  1.1  cached   14:02  (prompt unchanged)
  1.2  ran      18s    -> .awe/runs/2026-11-11T…/artifacts/1.2.md
Reused 1 step · Ran 1 step
Next  awe show 1.2   ·   awe run 1.3
```

```text
$ awe run
Cache     off — full run from 1.1 (use --cache to reuse valid steps)
```

失效判定沿用 `docs/dev-mode.md` 的指紋規則：prompt、`ENTRY.md`、input、executor、上游結果任一改變，該步與其後的步驟失效；
一旦某步重跑失敗，不會悄悄退回舊的成功結果。run 與 dev 合併成**同一套**儲存，不再有分開的 session。

## 6. 錯誤與提示範例

```text
awe: --executor needs a name. Available: search, write   (e.g. awe run 1.1 --executor search)
awe: unknown step "3.1.1" — it is inside a PARALLEL group; run its group instead: awe run 3.1
awe: no step "4.2". Steps: 1.1  1.2  2.1  3.1  3.2   (see: awe check)
awe: no executor configured. Add one to awe.json, e.g.
       "run": "claude -p {prompt}"      "run": "codex exec {prompt}"
       "run": "opencode run {prompt}"   "run": "omp -p {prompt}"
awe: 1.1 timed out after 120s (awe.json "timeout", or --timeout 600). Last stderr:
       … searching "arabica vs robusta" (23 of ?)
     Next  awe run 1.1 --timeout 600
awe: not inside a workflow (no ENTRY.md in /repo or its parents). Next  cd <workflow> or awe run <dir>
```

規則：

- 需要值的 flag 拒絕以 `-` 開頭的值，不會吞掉下一個 flag。
- 逾時與失敗都保存 stderr 末 20 行，`awe show <step> --err` 可看，錯誤訊息直接印出。
- `--var` 與 cache 並用不再報錯：`--var` 改變 input 就是改變指紋，相關步驟自然失效。
- 完整的 workflow 失敗後，輸出最後一行永遠是建議的下一條命令。
- 退出碼：`0` 成功、`1` 某步失敗、`2` 用法或設定錯誤、`130` 被中斷。

## 7. 被移除的東西

| 移除 | 由什麼取代 |
| --- | --- |
| `simulate`、echo executor | `awe run --dry` |
| `dev`、`--fresh` | `awe run <step>`、`--no-cache` |
| `--executor echo\|command`、`--command`、`--arg` | `awe.json` 的命令字串、`--executor <name>` |
| `--from` / `--reuse` 成對規則 | 在 `<step>` 上直接用 cache |
| `status`、`inspect`、`explain` | `awe show` |
| `validate`、`plan` | `awe check` |
| `--invocation` | `step@n` 位址 |
| `SIMULATED` / `COMMAND` 執行模式標籤 | 不再有假成功，也就不需要標籤；`--dry` 的輸出自帶 `DRY` 標頭 |

## 8. 舊設定的相容

舊的 `executor: { type, argv, timeoutMs }` 仍可讀取，每次執行印一行警告：

```text
awe: awe.json uses the deprecated "executor" block. Replace with:  "run": "claude -p {prompt}", "timeout": 120
```

- `type: "echo"` 不再可用：`run` 報錯並提示 `--dry` 或設定真正的 executor。
- 舊的 `.awe/runs` 與 `.awe/dev` 不會被匯入，也不會被刪除。

## 9. 實作範圍

保留：`discover.js`、`template.js`、`preflight.js`、`outputs.js`、指紋與 cache 驗證邏輯（`dev.js`/`dev-store.js` 內）。

重寫：

- `cli.js`：新命令與 flag 解析，含「值不得以 `-` 開頭」的檢查。
- `executor.js`：命令字串切分、`{prompt}` / `{prompt_file}` / stdin、長 prompt 轉檔、stderr 尾部保存。
- `runtime.js` + `dev.js` + `dev-store.js`：合併為一套（目標步驟、cache 開關、同一份 run 記錄）。
- 新增 `show.js`（取代 status/inspect/explain）、`find-root.js`（往上找 `ENTRY.md`）。
- `init.js`：偵測 PATH 上的 AI CLI。
- 同一個 PR 更新 `README.md`、`docs/dev-mode.md`（改名並縮短）、`.agents/skills/awe/SKILL.md`。

## 10. 尚未決定

1. **LOOP / IF 內的目標位址。** 提議 `step@n`（第 n 圈），省略時取最近一次；IF 未選中的分支維持 `TARGET_UNREACHABLE`，但錯誤要說明目前選中的是哪個分支。
2. **`UNKNOWN_EFFECT`（指令被中斷、不確定是否已產生副作用）。** 提議保留機制，但把 flag 縮成 `--retry <step>`，並在錯誤訊息裡印出完整命令。
3. **`--dry` 遇到 IF / LOOP。** 提議只印每個 prompt，上游輸出以 `[output of 1.1]` 佔位，IF 顯示所有分支，LOOP 只展開一圈。
4. **長 prompt 門檻。** 預設 64 KB，是否需要 `awe.json` 可調，尚未決定。
5. **step 級 timeout 之外，是否需要「搜尋次數預算」。** 提議不內建：只在 `init` 的範例 prompt 裡寫明 "at most N searches"，並在文件標明建議的 timeout。
