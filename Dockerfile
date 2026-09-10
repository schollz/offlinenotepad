FROM node:24-alpine AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY frontend ./frontend
RUN npm run build

FROM golang:1.27-alpine AS builder
WORKDIR /go/offlinenotepad
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
COPY --from=frontend /app/frontend/dist ./frontend/dist
RUN CGO_ENABLED=0 go build -trimpath -o /offlinenotepad .

FROM alpine:3.23
VOLUME /data
EXPOSE 8251
COPY --from=builder /offlinenotepad /offlinenotepad
ENTRYPOINT ["/offlinenotepad"]
CMD ["--db", "/data/offlinenotepad.db", "--debug"]
