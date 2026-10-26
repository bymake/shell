# ShellPro 云同步后端构建镜像
# 多阶段：编译阶段 + 运行阶段（scratch / alpine）
FROM golang:1.26-alpine AS builder
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/cloud-api ./cmd/api

FROM alpine:3.20
RUN adduser -D -u 10001 shellpro
COPY --from=builder /out/cloud-api /usr/local/bin/cloud-api
USER shellpro
EXPOSE 8080
ENV GIN_MODE=release
ENTRYPOINT ["/usr/local/bin/cloud-api"]
