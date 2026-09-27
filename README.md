# turn-restricted-router

带禁转规则的有向图最短路后端。输入路网、起点终点和一批禁转规则，
服务返回**遵守禁转**的最短路径长度与节点序列；也支持按顺序经过多个
停靠点的整单路线（停靠点处来向延续，分段明细一并返回）。纯 HTTP 接口，
无网页、无派单逻辑、不涉及任何真实地理坐标。

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
| `src/multistop.ts` | 整单路线：分层状态 `(节点, 进入边, 已完成停靠点数)` 上的 Dijkstra |
| `src/segments.ts` | 分段明细还原；以及调度员「拆段拼接」做法的参照实现与违例诊断 |
| `src/restrictions.ts` | 禁转规则表示与转向判定 |
| `src/path.ts` | 状态路径展开为节点序列 |
| `src/compare.ts` | 「开启/关闭禁转」两情形对比 |
| `src/validation.ts` | 输入校验（不存在的节点、非正边权、指向不存在边的禁转、停靠点超上限） |
| `src/heap.ts` | 最小堆优先队列 |
| `src/sample.ts` | 预置 3×3 网格算例（禁掉一个左转） |
| `src/orderSample.ts` | 预置整单算例（拆段拼接踩中禁转 vs 更短的全局解） |
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

### `POST /ordered-route`

整单路线：车辆出库后按 `stops` 中的先后顺序依次停靠，最后到达终点。
请求结构与 `/shortest-path` 完全复用，只多一个 `stops` 字段（省略等价于空列表）：

```json
{
  "graph": { "...同前..." },
  "source": "S",
  "target": "T",
  "stops": ["X", "Y"],
  "restrictions": [{"from": "Xa", "via": "X", "to": "T"}]
}
```

搜索跑在**分层扩展状态** `(节点, 进入边, progress)` 上，`progress` 是已按顺序
完成的停靠点个数。停靠点处不做任何重置——靠边停车不清空来向，离开停靠点那一步
与普通路口走同一个禁转检查；顺序是硬约束：路过排在后面的停靠点不提前完成，
重访已完成的停靠点无影响；相邻同名停靠点表示同处连卸两单，对应长度为 0 的段。

成功响应除总长度与完整节点序列外，还给出 `stopIndices`（每个停靠点在序列中被
完成时的**下标**，同一节点可能出现多次，所以必须按下标定位）与 `segments` 分段
明细（每段的起终点、段长、在完整序列中的起止下标）。各段长度之和等于总长度，
相邻两段在交界处首尾相接：

```json
{
  "source": "S", "target": "T", "stops": ["X"],
  "reachable": true, "distance": 4,
  "path": ["S", "Xb", "X", "T"],
  "stopIndices": [2],
  "segments": [
    {"index": 0, "from": "S", "to": "X", "distance": 3, "startIndex": 0, "endIndex": 2},
    {"index": 1, "from": "X", "to": "T", "distance": 1, "startIndex": 2, "endIndex": 3}
  ]
}
```

整单走不通时不是一句不可达，而是指出**哪一个停靠点之后开始接不上**：

```json
{"reachable": false, "distance": null, "path": [],
 "unreachableAfter": {"segmentIndex": 2, "from": "B", "to": "C",
                      "reachedStopCount": 2, "afterStop": "B", "message": "..."}}
```

语义约定：`stops` 为空时结果与 `/shortest-path` 完全一致；停靠点上限 16，
超过或引用不存在的节点一律 400 并说明原因。

### `GET /order-sample`

预置整单算例，专门演示**拆段拼接为什么会错**。订单 S → 停靠 [X] → T，
禁转 `(Xa, X, T)`：

- 拆段拼接：第 1 段独立最短 S→Xa→X（2）+ 第 2 段独立最短 X→T（1）= **3**，
  但在停靠点 X 恰好做了被禁的转向 `(Xa, X, T)`——第 2 段把 X 当全新起点，
  丢了「从 Xa 进来」这个来向；
- 承认来向、老实绕开禁转：X→U→X 换个来向再走 X→T，整单 **5**；
- 全局解：第 1 段多走 1、改从 Xb 方向进 X，S→Xb→X→T = **4**，既合法又更短。

返回里同时给出输入、`globalSolution`（含分段明细）、`stitchedFromSegments`
（各段路径、拼接序列、`firstViolation` 指出错在哪一步）以及 `repairedStitch`。

### `GET /sample`

预置 3×3 网格算例：A→I 的最短路 `A-B-E-F-I`（长度 4）在 E 路口用了一个左转，
禁转规则 `(B, E, F)` 禁掉它后只能绕行 `A-B-E-H-I`（长度 8）。
启动服务后访问即可直接核对：`delta = 4`。

### `GET /health`

存活探针，返回 `{"status": "ok"}`。

### 错误输入（一律 400 + 原因）

- 边、起终点或禁转规则引用了不存在的节点；
- 停靠点引用了不存在的节点，或停靠点数量超过 16；
- 边权非正（负权、零权，含负权自环）；
- 禁转规则指向图中不存在的边；
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
- 预置网格算例：禁转后严格变长（4 → 8）。

整单路线（`/ordered-route`）覆盖的不变量：

- 无禁转时，整单长度等于各相邻点对独立最短路长度之和（200 组随机图）；
- 有禁转时，整单长度不小于各段独立最短之和（独立查询放掉了交界处的来向约束）；
- 返回序列逐步检查，任何转向（含每个停靠点处的进出）都不在禁转规则里；
- 停靠点按给定顺序作为子序列出现，标出的下标确实落在对应节点上，且相邻段下标首尾相接；
- 删掉中间某个停靠点，总长度不会变长；
- 边界语义：空停靠点与单次查询完全一致、相邻同名停靠点为零长度段、
  首停靠点等于起点（出发即完成）、末停靠点等于终点（到达即完成）；
- 不可达时定位到「第几个停靠点之后接不上」；
- 预置整单算例：拆段拼接踩中 `(Xa, X, T)`，诚实修补为 5，全局解为 4；
- 并发整单查询交错发起，结果各自正确。
