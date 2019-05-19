package main

import (
	"encoding/json"
	"fmt"
	"io/ioutil"
	"net/http"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	log "github.com/schollz/logger"
	bolt "go.etcd.io/bbolt"
)

func main() {
	log.SetLevel("trace")
	s, err := New()
	if err != nil {
		log.Error(err)
	}
	err = s.Serve()
	if err != nil {
		log.Error(err)
	}
}

type server struct {
	db *bolt.DB
}

func New() (s *server, err error) {
	s = new(server)
	log.Debug("opening database")
	s.db, err = bolt.Open("data.db", 0666, nil)
	if err != nil {
		return
	}
	return
}

func (s *server) Serve() (err error) {
	port := 8003
	log.Infof("listening on :%d", port)
	http.HandleFunc("/", s.handler)
	return http.ListenAndServe(fmt.Sprintf(":%d", port), nil)
}

func (s *server) handler(w http.ResponseWriter, r *http.Request) {
	t := time.Now().UTC()
	err := s.handle(w, r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		log.Error(err)
	}
	log.Infof("%v %v %v %s\n", r.RemoteAddr, r.Method, r.URL.Path, time.Since(t))
}

func (s *server) handlePost(w http.ResponseWriter, r *http.Request) (err error) {
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

func (s *server) handle(w http.ResponseWriter, r *http.Request) (err error) {
	if r.Method == http.MethodPost {
		return s.handlePost(w, r)
	}
	// very special paths
	if r.URL.Path == "/robots.txt" {
		// special path
		w.Write([]byte(`User-agent: * 
Disallow: /`))
	} else if r.URL.Path == "/ws" {
		return s.handleWebsocket(w, r)
	} else if r.URL.Path == "/favicon.ico" {
		// TODO
	} else if r.URL.Path == "/sitemap.xml" {
		// TODO
	} else {
		if !strings.HasPrefix(r.URL.Path, "/static") {
			r.URL.Path = "/static/index.html"
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
	// message meta
	Type    string `json:"t"`
	Success bool   `json:"s"`
	Message string `json:"me"`

	// data that can be passed
	User  string   `json:"u,omitempty"`
	Hash  string   `json:"h,omitempty"`
	UUID  string   `json:"i,omitempty"`
	Data  string   `json:"d,omitempty"`
	Datas []string `json:"ds,omitempty"`
}

func (s *server) handleWebsocket(w http.ResponseWriter, r *http.Request) (err error) {
	// handle websockets on this page
	c, errUpgrade := wsupgrader.Upgrade(w, r, nil)
	if errUpgrade != nil {
		return errUpgrade
	}
	defer c.Close()

	log.Debugf("%s connected\n", c.RemoteAddr().String())

	var p Payload
	for {
		err := c.ReadJSON(&p)
		if err != nil {
			log.Debug("error reading JSON")
			break
		}
		log.Debugf("recv: %v", p)
		rp, err := s.dbHandlePayload(p)
		if err != nil {
			rp.Type = "message"
			rp.Success = false
			rp.Message = err.Error()
		} else {
			rp.Success = true
		}
		log.Debugf("send: %+v", rp)
		err = c.WriteJSON(rp)
		if err != nil {
			log.Debug("error writing JSON")
			break
		}
	}
	log.Error(err)
	return
}

func (s *server) dbHandlePayload(p Payload) (rp Payload, err error) {
	// create buckets for user if they do not exist
	err = s.dbCreateBuckets(p.User)
	if err != nil {
		return
	}

	// switch on the type of payload
	switch p.Type {
	case "offer":
		// check database for hash and see if its new and should request it
		rp, err = s.dbHandleOffer(p)
	case "update":
		// update the database with the specified payload
		rp, err = s.dbHandleUpdate(p)
	default:
		log.Debug("unknown type")
	}

	return
}

func (s *server) dbHandleUpdate(p Payload) (rp Payload, err error) {
	// got offer from user, check if the uuid exists
	// and whether the hash for that uuid is different
	rp.Type = "message"
	rp.Message = "updated"
	err = s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte(p.User + "-hashes"))
		return b.Put([]byte(p.UUID), []byte(p.Hash))
	})
	if err != nil {
		return
	}
	err = s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte(p.User + "-data"))
		return b.Put([]byte(p.UUID), []byte(p.Data))
	})
	if err != nil {
		return
	}
	return
}

func (s *server) dbHandleOffer(p Payload) (rp Payload, err error) {
	// got offer from user, check if the uuid exists
	// and whether the hash for that uuid is different
	rp.Type = "request"
	rp.UUID = p.UUID
	rp.Hash = p.Hash
	rp.Message = "ok"
	err = s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte(p.User + "-hashes"))
		v := b.Get([]byte(p.UUID))
		if v != nil && string(v) == p.Hash {
			// no request needed
			rp = Payload{Type: "message", Message: p.UUID[:4] + " ok"}
		}
		return nil
	})
	return
}

func (s *server) dbCreateBuckets(user string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		_, err := tx.CreateBucketIfNotExists([]byte(user + "-data"))
		if err != nil {
			return fmt.Errorf("create bucket: %s", err)
		}
		_, err = tx.CreateBucketIfNotExists([]byte(user + "-hashes"))
		if err != nil {
			return fmt.Errorf("create bucket: %s", err)
		}
		return nil
	})
}
