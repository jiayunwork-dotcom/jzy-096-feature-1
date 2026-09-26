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
| `src/restrictions.ts` | 禁转规则表示与转向判定 |
| `src/path.ts` | 状态路径展开为节点序列 |
| `src/compare.ts` | 「开启/关闭禁转」两情形对比 |
| `src/validation.ts` | 输入校验（不存在的节点、非正边权、指向不存在边的禁转） |
| `src/heap.ts` | 最小堆优先队列 |
| `src/sample.ts` | 预置 3×3 网格算例（禁掉一个左转） |
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
