FROM golang:1.12-alpine as builder
RUN apk add --no-cache git 
WORKDIR /go/offlinenotepad
COPY . .
RUN go generate -x -v
RUN go build -v

FROM alpine:latest 
VOLUME /data
EXPOSE 8251
COPY --from=builder /go/offlinenotepad/offlinenotepad /offlinenotepad
ENTRYPOINT ["/offlinenotepad"]
CMD ["--db","/data/offlinenotepad.db","--debug"]
