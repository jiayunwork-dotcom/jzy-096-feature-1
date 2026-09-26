FROM node:20-alpine

WORKDIR /app

# 先装依赖（含 devDependencies，测试与编译需要）
COPY package.json package-lock.json ./
RUN npm ci

# 编译 TypeScript，并在构建阶段跑通全部测试作为质量门
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build
RUN npm test

EXPOSE 8080
CMD ["node", "dist/src/server.js"]
