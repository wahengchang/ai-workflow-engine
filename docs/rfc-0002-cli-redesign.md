# RFC 0002 — AWE CLI 從零重新設計

Status: **IMPLEMENTED** (v0.2). User documentation: [cli.md](cli.md). Where the implementation differs from the first proposal, the text below has been updated and the difference is listed in §11.
取代：v0.1 的 CLI 介面（`run` / `simulate` / `dev` 三套並存、11 個 flag）。
不變：workflow 檔案格式（編號 `.md`、`FLOW.json`、`{{ steps["1.1"].output }}`）。後來決定移除 `ENTRY.md`，由 `awe.json` 負責根標記與共用文字（見 §11）。

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

- `dir` 省略時為目前目錄，並**往上層尋找 `awe.json`**（最初的提案是 `ENTRY.md`），所以在子資料夾裡也能跑。
- `step` 是形如 `1.2`、`3.1.2`、`2.1.1@2`（LOOP 第 2 圈；巢狀 LOOP 由外到內依序列出，如 `1.1.2.1@2.1`）的位址。`dir` 與 `step` 靠格式區分，因此在 workflow 裡直接 `awe run 1.2` 即可。
- 全部命令都支援 `--json`。

### `awe run` 的 flag（共 7 個，其中 `--retry` 只在中斷後復原時使用）

| Flag | 說明 |
| --- | --- |
| `--var key=value` | 覆蓋 `awe.json` 的 input，可重複 |
| `--cache` / `--no-cache` | 同一個開關的兩種狀態，見 §5 |
| `--dry` | 只渲染 prompt，不呼叫 executor、不寫 cache、不建立 run（取代 `simulate` 與 echo） |
| `--executor <name>` | 使用 `awe.json` 裡具名的 executor，缺值時錯誤訊息列出所有名稱 |
| `--timeout <seconds>` | 覆蓋這次的 timeout |
| `--retry <step>` | 讓一個「結果未知」的步驟再跑一次（取代 `--acknowledge`） |
| `--json` | 機器可讀輸出 |

### `awe show`

```text
awe show                  最近一次 run 的摘要：每步的狀態、是否來自 cache、輸出檔路徑
awe show 1.2              1.2 的輸出文字
awe show 2.1.1@2          LOOP 第 2 圈的輸出（位址寫法與 awe run 相同）
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
    "search": { "run": "omp -p", "timeout": 900 }
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
- `steps.<id>.outputs`（named output files）維持 [cli.md](cli.md#output-files) 所述的語意。

### 命令字串與 `{prompt}`

字串以**引號感知的方式切成 argv，再逐一代入，不經過 shell**，所以 prompt 內容不會被當成 shell 語法。三種寫法：

| 寫法 | 行為 |
| --- | --- |
| 含 `{prompt}` | 渲染後的 prompt 放進該參數。過長時（預設超過 64 KB）自動改為檔案路徑，見下 |
| 含 `{prompt_file}` | 永遠代入渲染後 prompt 檔的絕對路徑 |
| 都沒有 | prompt 從 stdin 送入 |

prompt 本身是一份含變數的 md。AWE 會先把變數渲染完，存成
`.awe/runs/<run-id>/artifacts/prompt-<step>-attempt-<n>.md`，這份檔案就是 `show --prompt` 看到的內容。預設會保存；`awe.json` 設 `"storePrompts": false` 時只在命令需要的那一刻保留。
當它太長不適合放進參數（超過 64 KB；Windows 為 16 KB），`{prompt}` 自動換成一句短指示：`Read and follow the instructions in <絕對路徑>`。使用者不需要自己寫 wrapper。

`awe init` 會偵測 PATH 上的 `claude` / `codex` / `opencode` / `omp`，把第一個找到的寫入 `run`（`omp` 寫成 `omp -p`，由 stdin 讀入）；都沒有時不寫 `run`，`awe run` 會直接報錯並印出四種可貼上的範例。預設 timeout 為 300 秒。

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
  1.2  ran      18s    -> .awe/runs/2026-11-11T…/artifacts/1-2-attempt-1.md
Reused 1 step · Ran 1 step
Next  awe show 1.2   ·   awe run 1.3
```

```text
$ awe run
Cache     off — full run from 1.1 (use --cache to reuse valid steps)
```

失效判定沿用 [cli.md](cli.md#cache) 所述的指紋規則：prompt、共用文字（`common`）、input、executor、上游結果任一改變，該步與其後的步驟失效；
一旦某步重跑失敗，不會悄悄退回舊的成功結果。run 與 dev 合併成**同一套**儲存，不再有分開的 session。

## 6. 錯誤與提示範例

```text
awe: --executor needs a name. Available: search, write   (e.g. awe run 1.1 --executor search)
awe: 3.1 is a PARALLEL group, not a step. Run one of its steps, e.g. awe run 3.1.1  (steps: 3.1.1, 3.1.2)
awe: no step "4.2". Steps: 1.1  1.2  2.1  3.1  3.2   (see: awe check)
awe: no executor configured. Add one to awe.json, e.g.
       "run": "claude -p {prompt}"      "run": "codex exec {prompt}"
       "run": "opencode run {prompt}"   "run": "omp -p {prompt}"
  1.1     FAILED  Command timed out after 120s. Raise it with --timeout <seconds> or "timeout" in awe.json.
          … searching "arabica vs robusta" (23 of ?)
Next  awe run 1.1 --timeout 240    (limit now 120s)   ·   awe show 1.1 --err
awe: Not inside a workflow (no awe.json in /repo or its parents).
Next: cd into a workflow, pass its folder (awe run <dir>), or create one with: awe init <dir>
```

規則：

- 需要值的 flag 拒絕以 `-` 開頭的值，不會吞掉下一個 flag。
- 逾時與失敗都保存 stderr 末 20 行，`awe show <step> --err` 可看，錯誤訊息直接印出。
- `--var` 與 cache 並用不再報錯：`--var` 改變 input 就是改變指紋，舊結果保留在舊 input 之下，新 input 另起一份。
- 執行命令的顯示（run 標頭、`awe check`）只列出執行檔與單純的旗標，其他引數以 `…` 取代，避免命令列上的金鑰出現在終端機或 log。
- 完整的 workflow 失敗後，輸出最後一行永遠是建議的下一條命令。
- 退出碼：`0` 成功、`1` 某步失敗、`2` 用法或設定錯誤（awe 無法開始）、`129` / `130` / `143`（SIGHUP / SIGINT / SIGTERM）被中斷。`awe check` 在 workflow 有效時一律回 `0`，executor 缺少只標示 `NOT READY`。

## 7. 被移除的東西

| 移除 | 由什麼取代 |
| --- | --- |
| `simulate`、echo executor | `awe run --dry` |
| `dev`、`--fresh` | `awe run <step>`、`--no-cache` |
| `--executor echo\|command`、`--command`、`--arg` | `awe.json` 的命令字串、`--executor <name>` |
| `--from` / `--reuse` 成對規則 | 在 `<step>` 上直接用 cache |
| `status`、`inspect`、`explain` | `awe show` |
| `validate`、`plan` | `awe check` |
| `--invocation` | `step@n`（巢狀為 `step@n.m`）位址 |
| `SIMULATED` / `COMMAND` 執行模式標籤 | 不再有假成功，也就不需要標籤；`--dry` 的輸出自帶 `DRY` 標頭 |

## 8. 舊設定的相容

舊的 `executor: { type, argv, timeoutMs }` 仍可讀取，每次執行在 stderr 印一行警告，內容包含可貼上的新寫法：

```text
awe: warning: awe.json uses the deprecated "executor" block. Replace it with: "run": "claude -p x", "timeout": 120
```

- `type: "echo"` 不再可用：`run` 報錯並提示 `--dry` 或設定真正的 executor；`--dry` 仍可預覽該 workflow。
- 舊的 `.awe/runs` 與 `.awe/dev` 不會被匯入，也不會被刪除；`awe show` 仍讀得到舊 run 的 state。

## 9. 實作範圍（已完成）

- `src/cli.js`：新命令與 flag 解析；需要值的 flag 拒絕以 `-` 開頭的值；被移除的命令回報替代寫法。
- `src/command.js`（命令字串切分、顯示）、`src/config.js`（awe.json v2 與舊格式、executor 解析）、`src/executor.js`（`{prompt}` / `{prompt_file}` / stdin、長 prompt 轉檔、stderr 尾部）。
- `src/engine.js`（原 `dev.js`）與 `src/cache.js`（原 `dev-store.js`）：`awe run` 唯一的執行路徑；`src/runtime.js` 只剩 prompt 組裝與 gate 判斷。
- 新增 `src/show.js`、`src/dry.js`、`src/which.js`；`init.js` 偵測 AI CLI。
- 文件：`docs/cli.md` 取代 `docs/dev-mode.md`；README、SKILL、installation、maintenance、architecture 同步更新。
- 測試：既有的引擎、cache、recovery、output files 測試全數移植到新介面，另加 `test/cli.test.js`、`test/command.test.js`。

## 10. 原本未決定的項目，現況

1. **LOOP / IF 內的目標位址。** `step@n`（巢狀為 `step@outer.inner`）；省略時若只見過一個 occurrence 就用它，見過多個則報錯並列出可用寫法。IF 未選中的分支維持 `TARGET_UNREACHABLE` 並說明 gate 選了哪個分支。
2. **`UNKNOWN_EFFECT`。** 保留機制，flag 改為 `--retry <step>`，錯誤訊息印出完整寫法。
3. **`--dry` 遇到 IF / LOOP。** 只印每個 prompt，上游輸出以 `[output of 1.1]` 佔位，IF 顯示所有分支，LOOP 只展開一圈。
4. **長 prompt 門檻。** 固定 64 KB（Windows 16 KB），不開放設定。
5. **搜尋次數預算。** 不內建；範例 prompt 與文件建議自行寫明 "at most N searches"，並為慢的步驟設定較長的 `timeout`。

## 11. 與最初提案的差異

- `--retry` 讓 `awe run` 有 7 個 flag，而不是 6 個。
- 群組位址（例如 PARALLEL 的 `3.1`）不是步驟，錯誤訊息列出群組內可執行的步驟；PARALLEL 內的單一步驟（`3.1.1`）可以直接執行。
- 提案中的 `show --prompt` 路徑改為既有的 `artifacts/prompt-<step>-attempt-<n>.md`，並且預設保存。
- `awe check` 不因 executor 缺少而失敗。
- run 標頭寫 `(N steps in plan)`；有 LOOP 重複時，摘要的計數單位改為 `step runs`，避免同一份輸出裡「step」指兩種東西。
- 執行命令的顯示會保留 workflow 內存在的檔案（例如 `node agent.cjs`），讓兩個不同的 agent 看得出差別。
- 共用文字：移除 `ENTRY.md`，改為 `awe.json` 的 `"common"` 欄位（字串或行陣列），`awe.json` 取代 `ENTRY.md` 成為 workflow 根標記；`ENTRY.md` 不再被讀取（留著會警告；沒有 `awe.json` 的 v0.1 資料夾會被拒絕，錯誤訊息直接附上可貼上的 `awe.json`，內容已跳脫；不另設 `awe migrate`，因為那是一次性的步驟，訊息已含結果。警告也會放進 `--json` 輸出的 `warnings`），也不另設 `COMMON.md`。理由：`ENTRY.md` 同時承擔「每步附加文字」與「根標記」兩件事，名字又讓人以為是入口或第一步。
- `common` 的寫法：目前只支援字串或行陣列。審閱意見指出，多行 Markdown 規則放進 JSON 要跳脫引號、diff 也比檔案難讀；替代方案是另加 `commonFile`（相對路徑、限 workflow 內、不在 `.awe` 下）。決定先不做，因為最初的方向是移除這個檔案；若實際使用中常有超過約十行的共用規則，再以 `commonFile` 補上，不影響現有格式。
- `common` 不再自動附加：prompt 不再有 `# Common instructions` 與 `# Step N (…)` 這兩段自動標題，一個步驟送出的就是它自己的 prompt 檔（渲染後），共用文字只在 prompt 寫 `{{ common }}` 的位置出現（拼法固定為小寫 `common`）。理由：使用者自己決定放在哪、要不要放、長什麼樣；也避免每步都被迫帶上。因此只有寫了 `{{ common }}` 的步驟依賴它（改 `common` 只會讓這些步驟失效）；`awe check` 顯示有哪些步驟使用它，定義了卻沒人用會警告，用了卻沒定義會報錯。執行命令的環境新增 `AWE_STEP`、`AWE_ADDRESS`、`AWE_RUN_ID`，因為 prompt 不再帶有步驟標題，wrapper 需要另一種方式知道自己在服務哪一步。
- JSON 輸出：步驟可在 `awe.json` 的 `steps.<id>.json` 宣告輸出必須是 JSON（`true`，或 `type`、`minItems`、`maxItems`、`items`、`required`、`properties`、`enum` 這個 JSON Schema 子集）。awe 在步驟成功前解析並驗證，失敗則不啟動該分支後續步驟及 join；已啟動的平行兄弟分支仍會各自完成。後續 prompt 以 `{{ steps["1.1"].json[0].role }}` 取值，JSON `null` 會插入文字 `null`。`awe show <step>` 可讀取最近一次被拒絕的原始輸出。詳見 [cli.md](cli.md#json-output)。
- 重跑原因：cache 開啟時，非指定的步驟若重跑，會在該行註明原因（`(the common text changed)`、`(its prompt file changed)`…）；`awe check` 顯示共用文字（`common`）的長度；文件新增「Common text」一節（用途、使用時機、生命週期）。
- 目錄探索：不含編號 prompt 或 `FLOW.json` 的資料夾視為 scratch 並忽略，不再讓執行過程產生的資料夾使後續所有命令失敗。
