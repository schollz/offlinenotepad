FROM golang:1.12-alpine as builder
RUN apk add --no-cache git 
WORKDIR /go/offlinenotepad
COPY ./static /go/offlinenotepad/static
COPY ./go.sum /go/offlinenotepad
COPY ./go.mod /go/offlinenotepad
COPY main.go /go/offlinenotepad
RUN go generate -x -v
RUN go build -v

FROM alpine:latest 
VOLUME ./data /data
EXPOSE 8251
COPY --from=builder /go/offlinenotepad/offlinenotepad /offlinenotepad
ENTRYPOINT ["/offlinenotepad"]
CMD ["--db","/data/offlinenotepad.db","--debug"]
