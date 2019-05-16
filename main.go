package main

import (
	"encoding/json"
	"fmt"
	"io/ioutil"
	"net/http"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	log "github.com/schollz/logger"
)

func main() {
	log.SetLevel("trace")
	err := serve()
	if err != nil {
		log.Error(err)
	}
}
func serve() (err error) {
	port := 8003
	log.Infof("listening on :%d", port)
	http.HandleFunc("/", handler)
	return http.ListenAndServe(fmt.Sprintf(":%d", port), nil)
}

func handler(w http.ResponseWriter, r *http.Request) {
	t := time.Now().UTC()
	err := handle(w, r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		log.Error(err)
	}
	log.Infof("%v %v %v %s\n", r.RemoteAddr, r.Method, r.URL.Path, time.Since(t))
}

func handlePost(w http.ResponseWriter, r *http.Request) (err error) {
	type PostData struct {
		Type   string `json:"t,omitempty"`
		Bucket string `json:"b,omitempty"`
		Key    string `json:"k,omitempty"`
		Value  string `json:"v,omitempty"`
	}
	decoder := json.NewDecoder(r.Body)
	var t PostData
	err = decoder.Decode(&t)
	if err != nil {
		return
	}
	log.Tracef("got data: %+v", t)

	var js []byte
	if t.Type == "ping" {
		js, err = json.Marshal(PostData{
			Type: "pong",
		})
	}
	if err != nil {
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write(js)
	return
}
func handle(w http.ResponseWriter, r *http.Request) (err error) {
	if r.Method == http.MethodPost {
		return handlePost(w, r)
	}
	// very special paths
	if r.URL.Path == "/robots.txt" {
		// special path
		w.Write([]byte(`User-agent: * 
Disallow: /`))
	} else if r.URL.Path == "/favicon.ico" {
		// TODO
	} else if r.URL.Path == "/sitemap.xml" {
		// TODO
	} else {
		if r.URL.Path == "/" || r.URL.Path == "/new" {
			r.URL.Path = "/index.html"
		}
		urlPath := r.URL.Path

		var b []byte
		b, err = ioutil.ReadFile(path.Join(".", path.Clean(r.URL.Path[1:])))
		if err != nil {
			// try to see if index is nested
			b, err = ioutil.ReadFile(path.Join(".", path.Clean(r.URL.Path[1:]), "index.html"))
			if err != nil {
				err = fmt.Errorf("could not find file")
				return
			} else {
				urlPath = path.Join(path.Clean(r.URL.Path[1:]), "index.html")
			}
		}

		var kind string
		if len(b) > 512 {
			kind = http.DetectContentType(b)
		} else {
			kind = http.DetectContentType(b[:512])
		}

		if strings.HasPrefix(kind, "application/octet-stream") || strings.HasPrefix(kind, "text/plain") {
			// https://developer.mozilla.org/en-US/docs/Web/HTTP/Basics_of_HTTP/MIME_types
			switch filepath.Ext(urlPath) {
			case ".js":
				kind = "text/javascript"
			case ".css":
				kind = "text/css"
			case ".md":
				kind = "text/plain"
			case ".html":
				kind = "text/html"
			}
		}
		w.Header().Set("Content-Type", kind)
		w.Write(b)
	}
	return
}

var wsupgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

type Payload struct {
	Message string `json:"message"`
}

type Connections struct {
	cs map[string]*websocket.Conn
	sync.RWMutex
}

var wsConnections Connections

func handleWebsocket(w http.ResponseWriter, r *http.Request) (err error) {

	// handle websockets on this page
	c, errUpgrade := wsupgrader.Upgrade(w, r, nil)
	if errUpgrade != nil {
		return errUpgrade
	}
	defer c.Close()

	log.Debugf("%s connected\n", c.RemoteAddr().String())
	wsConnections.Lock()
	if len(wsConnections.cs) == 0 {
		wsConnections.cs = make(map[string]*websocket.Conn)
	}
	wsConnections.cs[c.RemoteAddr().String()] = c
	wsConnections.Unlock()
	defer func() {
		wsConnections.Lock()
		delete(wsConnections.cs, c.RemoteAddr().String())
		wsConnections.Unlock()
	}()

	var p Payload
	for {
		err := c.ReadJSON(&p)
		if err != nil {
			log.Debug("read:", err)
			break
		}
		log.Debugf("recv: %v", p)
	}
	return
}
