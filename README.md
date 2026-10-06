# Opus Archive Audit

海洋声学站归档 Ogg Opus 记录的**分页完整性审计服务**。播放器对损坏的
Ogg/Opus 流相当宽容，可能掩盖页截断、跨页丢包或时长漂移；本服务在归档前
对单一逻辑流做严格的结构校验，绝不做"容错式"重同步。

- `POST /api/opus/audit`（`Content-Type: audio/ogg`，体积 ≤ 8 MiB，页数 ≤ 2048）
- `GET /health` 健康检查

支持标准声道映射族：

- **映射族 0**（RFC 7845 5.1.1.1）：1/2 声道，每个 Ogg 音频包一个 Opus 包；
- **映射族 1**（RFC 7845 5.1.1.2，Vorbis 顺序）：3 至 8 声道的多子流记录
  （另有族 1 的 1/2 声道单子流形式）。每个 Ogg 音频包按 OpusHead 声明打包
  N 个 Opus 子流：前 N-1 个使用 RFC 6716 附录 B 自定界成帧，最后一个使用
  常规成帧。归档平台逐子流核验，避免某一声道流损坏被整体时长掩盖。

## 审计内容

每页依次核验：

1. 捕获标识 `OggS`、流结构版本（必须为 0）、保留标志位；
2. 32 位序列号（必须从 0 起严格连续）与逻辑流序列号（全流一致）；
3. 段表与正文实际长度一致；
4. 整页 Ogg CRC-32（多项式 0x04c11db7）；
5. BOS / EOS / 跨页续包标志与上一页结束状态一致，EOS 后不得再有页；
6. 前两个完整包依次为 `OpusHead` 与结构合法的 `OpusTags`，两页粒度必须为 0，
   跨页标签页粒度为 -1；
   - 族 0：仅 1/2 声道，头包恰好 19 字节；
   - 族 1：头包为 21+C 字节，核对声道数（1..8）、流数 N、耦合流数 M 及
     C 项声道映射表，必须与 RFC 7845 的标准布局一致；其余映射族拒绝；
7. 每个 Ogg 音频包：
   - 族 0：按 RFC 6716 TOC 解析 code 0/1/2/3 成帧（含 VBR/CBR、Opus
     padding、1275 字节帧长、120 ms 上限），立体声标志须与声道配置一致；
   - 族 1：**必须恰好包含声明数量的 Opus 子流，边界完整**（自定界长度不得
     越界、末子流不得缺失）；前 M 个子流必须为立体声、其余为单声道；
     **同一包内各子流的解码样本数必须一致**；
8. 时间线：
   - 无完整包结束的页粒度必须为 `-1`；
   - 普通音频页粒度必须严格等于该页结束的全部 Ogg 包的 48 kHz 累计样本数；
   - EOS 页可向前裁剪，但粒度不得小于上一粒度，也不得超过
     "上一粒度 + 本页完成包样本数"。

多声道包的时长按 **Ogg 音频包计一次**，绝不按子流重复计数；页粒度、EOS
裁剪与 pre-skip 仍沿用同一套 48 kHz 时间线规则。

## 返回

成功（200）：

```json
{
  "pageCount": 4,
  "audioPacketCount": 3,
  "decodedSamples": 2640,
  "playableSamples": 2328
}
```

- `decodedSamples`：所有完整 **Ogg 音频包**按 TOC 累计的 48 kHz 解码
  样本数（多声道包按包计一次，不按子流翻倍）；
- `playableSamples`：最终 EOS 粒度减去 OpusHead pre-skip（钳为非负），
  即真实可播放样本数。

族 1 多声道记录成功时字段完全相同——例如 5.1 记录每个 Ogg 包含 4 个
Opus 子流，但 8 个 20 ms 包仍只计 `decodedSamples = 7680`、
`audioPacketCount = 8`。

失败返回 422（体积超限 413、空体 400、类型不符 415），并给出稳定错误码与
**首个失败页索引**。映射族 1 新增的稳定错误码：

| 错误码 | 含义 |
| --- | --- |
| `CHANNEL_MAPPING_INVALID` | 族 1 OpusHead 的流数/耦合流数/映射表与标准布局不符，或头长/流数非法 |
| `SUBSTREAM_TRUNCATED` | Ogg 包内子流缺失或自定界长度越界（边界不完整） |
| `MULTISTREAM_PACKET_INVALID` | 某个子流内部 Opus 成帧矛盾（如末子流奇数长、零帧等） |
| `CHANNEL_CONFIG_MISMATCH` | 子流立体声标志与"前 M 个耦合、其余单声道"布局不符 |
| `SUBSTREAM_DURATION_MISMATCH` | 同一 Ogg 包内各子流解码样本数不一致 |

```json
{ "error": { "code": "SUBSTREAM_DURATION_MISMATCH", "page": 2, "message": "..." } }
```

## 本地运行

```bash
npm ci
npm test          # 104 个单元/HTTP 测试
npm run build     # tsc -> dist/
npm start         # 默认 0.0.0.0:3000
```

跨页 HTTP 冒烟（先启动服务）：

```bash
BASE_URL=http://127.0.0.1:3000 node scripts/smoke.ts
```

## Docker / Compose

```bash
# 宿主机端口可配置
HOST_PORT=8080 docker compose up -d --build api

# 一次性校验：等 API 健康后执行 typecheck、单测、生产构建、跨页冒烟，
# 容器退出码汇总全部结果（任一失败非 0）
docker compose up --build verify
```

`verify` 服务通过 `depends_on: condition: service_healthy` 且 `/health`
健康检查通过后才启动，`restart: "no"`，仅运行一次。

## 目录

- `src/crc32ogg.ts` — Ogg CRC-32
- `src/opusToc.ts` — RFC 6716 TOC/成帧与附录 B 自定界成帧校验及样本数推导
- `src/audit.ts` — 页解析、包重组、映射族 0/1 子流核验、标志与时间线审计
- `src/server.ts` / `src/main.ts` — HTTP 服务
- `test/` — 单测、HTTP 测试、夹具（含真实 libopus 编码样本与族 1 多声道用例）
- `scripts/smoke.ts` — 含跨页音频包与映射族 0/1 的 HTTP 冒烟
