package main

import (
	"encoding/json"
	"fmt"
	"io/ioutil"
	"math"
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
	port := 8251
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
		if kind != "text/html" {
			w.Header().Set("Cache-Control", "max-age:290304000, public")
			w.Header().Set("Last-Modified", time.Now().Format(http.TimeFormat))
			w.Header().Set("Expires", time.Now().AddDate(60, 0, 0).Format(http.TimeFormat))
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
	Type    string `json:"type"`
	Success bool   `json:"success"`
	Message string `json:"message"`

	// data that can be passed
	User  string            `json:"user,omitempty"`
	Datas map[string]string `json:"datas,omitempty"`
}

func (p Payload) String() string {
	b, _ := json.Marshal(p)
	return string(b)
}

func (s *server) handleWebsocket(w http.ResponseWriter, r *http.Request) (err error) {
	// handle websockets on this page
	c, errUpgrade := wsupgrader.Upgrade(w, r, nil)
	if errUpgrade != nil {
		return errUpgrade
	}
	log.Debugf("%s connected\n", c.RemoteAddr().String())

	defer func() {
		log.Debugf("%s connection closed", c.RemoteAddr().String())
		c.Close()
	}()

	var sentBytes, receivedBytes int
	var p Payload

	// on initiation, send a hashlist
	for {
		err := c.ReadJSON(&p)
		if err != nil {
			break
		}
		bb, _ := json.Marshal(p)
		receivedBytes += len(bb)

		log.Tracef("recv: %s", p)
		rp, err := s.dbHandlePayload(p)
		if err != nil {
			rp = Payload{Type: "message", Success: false, Message: err.Error()}
		} else {
			rp.Success = true
		}
		log.Tracef("send: %s", rp)
		err = c.WriteJSON(rp)
		if err != nil {
			log.Debug("error writing JSON")
			break
		}
		bb, _ = json.Marshal(rp)
		sentBytes += len(bb)
		log.Debugf("%s, sent: %s, recv: %s",
			c.RemoteAddr().String(),
			humanizeBytes(sentBytes),
			humanizeBytes(receivedBytes),
		)
	}
	return
}

func (s *server) dbHandlePayload(p Payload) (rp Payload, err error) {
	// check validity of payload
	if p.User == "" {
		err = fmt.Errorf("need to supply user")
		return
	}

	// create buckets for user if they do not exist
	err = s.dbCreateBuckets(p.User)
	if err != nil {
		return
	}

	// switch on the type of payload
	switch p.Type {
	case "update-data":
		// update the database with the specified encrypted data
		rp, err = s.dbHandleUpdate(p, "data")
	case "update-hashes":
		// update the database of the hashes
		rp, err = s.dbHandleUpdate(p, "hashes")
	case "get-hashes":
		// client requests a list of ALL hashes
		rp, err = s.dbHandleGetHashes(p)
	case "get-data":
		// client requests data for specified UUIDs
		rp, err = s.dbHandleRequest(p)
	default:
		log.Debug("unknown type")
	}

	return
}

func (s *server) dbHandleRequest(p Payload) (rp Payload, err error) {
	// got offer from user, check if the uuid exists
	// and whether the hash for that uuid is different
	rp.Type = "update"
	rp.Datas = make(map[string]string)
	rp.Message = "ok"
	for uuid := range p.Datas {
		err = s.db.View(func(tx *bolt.Tx) error {
			b := tx.Bucket([]byte(p.User + "-data"))
			v := b.Get([]byte(uuid))
			if v == nil {
				return fmt.Errorf("%s not found", uuid)
			}
			rp.Datas[uuid] = string(v)
			return nil
		})
		if err != nil {
			return
		}
	}
	return
}

func (s *server) dbHandleGetHashes(p Payload) (rp Payload, err error) {
	rp.Type = "hashes"
	rp.Datas = make(map[string]string)
	err = s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte(p.User + "-hashes"))
		c := b.Cursor()
		for k, v := c.First(); k != nil; k, v = c.Next() {
			rp.Datas[string(k)] = string(v)
		}
		return nil
	})
	rp.Message = fmt.Sprintf("found %d hashes", len(rp.Datas))
	return
}

func (s *server) dbHandleUpdate(p Payload, kind string) (rp Payload, err error) {
	// got offer from user, check if the uuid exists
	// and whether the hash for that uuid is different
	rp.Type = "message"
	rp.Message = fmt.Sprintf("updated %d entries", len(p.Datas))
	for uuid, val := range p.Datas {
		err = s.db.Update(func(tx *bolt.Tx) error {
			b := tx.Bucket([]byte(p.User + "-" + kind))
			return b.Put([]byte(uuid), []byte(val))
		})
		if err != nil {
			return
		}
	}
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

var sizes = []string{"B", "kB", "MB", "GB", "TB", "PB", "EB"}

const base = 1000

func logn(n, b float64) float64 {
	return math.Log(n) / math.Log(b)
}

func humanizeBytes(s int) string {
	if s < 10 {
		return fmt.Sprintf("%d B", s)
	}
	e := math.Floor(logn(float64(s), base))
	suffix := sizes[int(e)]
	val := math.Floor(float64(s)/math.Pow(base, e)*10+0.5) / 10
	f := "%.0f %s"
	if val < 10 {
		f = "%.1f %s"
	}

	return fmt.Sprintf(f, val, suffix)
}
