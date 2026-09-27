# turn-restricted-router

带禁转规则的有向图最短路后端。输入路网、起点终点和一批禁转规则，
服务返回**遵守禁转**的最短路径长度与节点序列。纯 HTTP 接口，无网页、
无派单逻辑、不涉及任何真实地理坐标。

## 核心模型

禁转规则是三元组 `(from, via, to)`：在 `via` 节点上，不允许从
`from→via` 这条边直接拐上 `via→to` 这条边。

要正确管住禁转，最短路跑在**扩展状态空间** `(节点, 进入边)` 上，
而不是朴素节点状态上——同一个节点、来向不同，就是不同的状态，
能走的转向也不同。搜索结束后把状态路径展开回节点序列。
（若在朴素节点状态上搜，被禁的转向会照样被走通，这是本服务
从模型层面杜绝的错误。）

## 模块划分

| 文件 | 职责 |
| --- | --- |
| `src/graph.ts` | 图与扩展状态建模 |
| `src/dijkstra.ts` | 状态空间上的 Dijkstra（另附朴素 Dijkstra 作对照基准） |
| `src/orderRoute.ts` | 整单搜索：带「已完成停靠点数」进度维的 Dijkstra（含带来向的段搜索） |
| `src/segments.ts` | 整单状态路径还原为分段明细（按序列下标标注，与搜索相互独立） |
| `src/stitching.ts` | 拆段拼接模拟（朴素不带来向 / 贪心带来向）并逐转向核对错在哪一步 |
| `src/restrictions.ts` | 禁转规则表示与转向判定 |
| `src/path.ts` | 状态路径展开为节点序列 |
| `src/compare.ts` | 「开启/关闭禁转」两情形对比 |
| `src/validation.ts` | 输入校验（不存在的节点、非正边权、指向不存在边的禁转、停靠点超限） |
| `src/heap.ts` | 最小堆优先队列 |
| `src/sample.ts` | 预置 3×3 网格算例（禁掉一个左转） |
| `src/orderSample.ts` | 预置整单算例（拆段拼接违规 / 合法但绕远，全局解更短） |
| `src/app.ts` / `src/server.ts` | Express 接口层 / 进程入口 |

每个请求现场构建自己的图与搜索状态，模块级无可变数据，并发查询互不干扰。

## HTTP 接口

### `POST /shortest-path`

```json
{
  "graph": {
    "nodes": ["S", "A", "B", "T"],
    "edges": [
      {"from": "S", "to": "A", "weight": 1},
      {"from": "A", "to": "B", "weight": 1},
      {"from": "B", "to": "A", "weight": 1},
      {"from": "A", "to": "T", "weight": 5},
      {"from": "S", "to": "T", "weight": 10}
    ]
  },
  "source": "S",
  "target": "T",
  "restrictions": [{"from": "S", "via": "A", "to": "T"}]
}
```

响应（注意路径合法地折返经过 A 两次——扩展状态允许这样做）：

```json
{"source": "S", "target": "T", "reachable": true, "distance": 8, "path": ["S", "A", "B", "A", "T"]}
```

不可达时：`{"reachable": false, "distance": null, "path": []}`。
起点等于终点时：`{"reachable": true, "distance": 0, "path": ["S"]}`。

### `POST /compare`

请求体同上。在同一张图上对比「开启这组禁转」与「关掉这组禁转」：

```json
{
  "source": "S",
  "target": "T",
  "withRestrictions":  {"reachable": true, "distance": 8, "path": ["S", "A", "B", "A", "T"]},
  "withoutRestrictions": {"reachable": true, "distance": 6, "path": ["S", "A", "T"]},
  "delta": 2
}
```

`delta` 就是这条禁转规则带来的绕行代价；任一侧不可达时为 `null`。

### `POST /order-route`

整单路线：给定图、起点、终点、**按顺序排列的停靠点列表** `stops` 和禁转规则，
返回遵守全部禁转、依次经过每个停靠点、最后到达终点的**全局**最短路线。
请求结构完全复用 `/shortest-path` 的 `graph` / `source` / `target` /
`restrictions` 写法，只多一个 `stops` 字段。

搜索跑在三维扩展状态 `(节点, 进入边, 已完成停靠点数)` 上：停车不清空来向，
离开停靠点的那一步照常过禁转检查；只有「按顺序正好轮到」的停靠点才计分，
提前路过后面的停靠点不算完成（轮到它时还得再到一次），重复路过已完成的
停靠点也无影响。因此逐段各查各的拼接结果（接缝漏检、逐段贪心）不会再发生。

请求：

```json
{
  "graph": { "...": "同 /shortest-path" },
  "source": "S",
  "target": "T",
  "stops": ["P"],
  "restrictions": [{"from": "U", "via": "P", "to": "Q"}]
}
```

响应：

```json
{
  "source": "S",
  "target": "T",
  "stops": ["P"],
  "reachable": true,
  "distance": 7,
  "path": ["S", "W", "P", "Q", "T"],
  "segments": [
    {"index": 0, "from": "S", "to": "P", "distance": 5, "startIndex": 0, "endIndex": 2},
    {"index": 1, "from": "P", "to": "T", "distance": 2, "startIndex": 2, "endIndex": 4}
  ],
  "failedAfterStop": null,
  "failedAtTarget": false
}
```

分段语义（硬性保证）：

- `segments` 共 `stops.length + 1` 段；同一节点在序列里可出现多次，
  停靠点位置一律按 `path` 的**数组下标**标注（`startIndex`/`endIndex`）；
- 各段 `distance` 之和等于总 `distance`，相邻两段交界处
  `上一段.endIndex === 下一段.startIndex`；
- 相邻停靠点相同（同处连卸两单）、首停靠点等于起点、末停靠点等于终点，
  对应段长度为 0、起止下标相同；
- `stops` 为空（或缺省）时，结果与 `/shortest-path` 完全一致；
- 整单走不通时 `reachable: false`，并由 `failedAfterStop` 指出
  「最后一个确实能完成的停靠点」下标（第一个就到不了为 `-1`），
  断点发生在「全部停靠点之后去终点」时 `failedAtTarget: true`。

### `GET /order-sample`

预置整单算例，专门体现「拆段拼接会出错」。停靠点 P，禁转 `(U,P,Q)`：

- 朴素拼接（每段全新查询、不带来向）：`S-U-P-Q-T`，合计 4，
  但 `violation` 明确指出它在停靠点 P（下标 2、第 0 个停靠点接缝处）
  用了被禁的转弯 `(U,P,Q)`；
- 贪心合法拼接（下一段带来向）：无违规，但只能 `S-U-P-D-T`，合计 11；
- 全局解换个方向进 P：`S-W-P-Q-T`，合计 7，合法且严格更短。

响应同时给出算例输入、`globalRoute`、`naiveStitch`（含 `legs` 与
`violation`）和 `greedyLegalStitch`，启动服务即可直接对照。

### `GET /sample`

预置 3×3 网格算例：A→I 的最短路 `A-B-E-F-I`（长度 4）在 E 路口用了一个左转，
禁转规则 `(B, E, F)` 禁掉它后只能绕行 `A-B-E-H-I`（长度 8）。
启动服务后访问即可直接核对：`delta = 4`。

### `GET /health`

存活探针，返回 `{"status": "ok"}`。

### 错误输入（一律 400 + 原因）

- 边、起终点或禁转规则引用了不存在的节点；
- 边权非正（负权、零权，含负权自环）；
- 禁转规则指向图中不存在的边；
- `stops` 不是数组、元素不是图中存在的节点 id，或数量超过 16；
- 请求体不是合法 JSON。

## 本地运行

```bash
npm ci
npm test          # 编译 + 跑全部测试
npm start         # 监听 8080（可用 PORT 环境变量覆盖）
```

## Docker

```bash
docker build -t turn-restricted-router .   # 构建阶段会自动跑测试，失败则构建失败
docker run --rm -p 8080:8080 turn-restricted-router
docker run --rm turn-restricted-router npm test   # 在容器里单独跑测试
```

## 测试覆盖的不变量

- 无禁转时，状态空间搜索结果与朴素 Dijkstra 完全一致（300 组随机图）；
- 新增一条禁转、且原最短路用到了该转向，新最短路不会变短（300 组随机图）；
- 调大任意一条边的权重，最短路长度不会减少（300 组随机图）；
- 起点等于终点：长度为零、序列只含该节点；
- 不可达：明确的 `reachable: false`；
- 构造性用例：朴素节点搜索会错误走通被禁转向，状态空间搜索给出正确的折返路径；
- 预置网格算例：禁转后严格变长（4 → 8）；
- 整单不变量（随机图）：无禁转时总长等于各段独立最短之和；有禁转时只长不短；
  逐转向合法（含每个停靠点进出）；停靠点按序作为子序列、下标落点正确；
  删掉中间任一停靠点不会变长；空停靠点与点到点查询逐项一致；
- 整单顺序硬语义：提前路过后面的停靠点不计分、末停靠点为终点时到达即完成；
- 不可达时按停靠点下标定位断点（含 `failedAtTarget`）；
- 预置整单算例：朴素拼接在停靠点处违规，贪心合法拼接 11、全局解 7；
- 并发整单查询的搜索状态相互隔离。
