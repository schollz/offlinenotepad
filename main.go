package main

//go:generate go install -v github.com/jteeuwen/go-bindata/go-bindata@latest
//go:generate go-bindata static/ static/css/ static/images/ static/js/ static/images/touch/ static/images/icons/

import (
	"compress/gzip"
	"crypto/sha256"
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"net/http"
	"path"
	"path/filepath"
	"strings"
	"text/template"
	"time"

	"github.com/gorilla/websocket"
	log "github.com/schollz/logger"
	bolt "go.etcd.io/bbolt"
)

type Document struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	HTML     string `json:"html"`
	Markdown string `json:"markdown"`
}

// http server port
var port int

func main() {
	var debug bool
	var dbname string
	flag.StringVar(&dbname, "db", "data.db", "location to database")
	flag.BoolVar(&debug, "debug", false, "debug mode")
	flag.IntVar(&port, "port", 8251, "listen port")
	flag.Parse()

	if debug {
		log.SetLevel("debug")
	} else {
		log.SetLevel("info")
	}

	s, err := New(dbname)
	if err != nil {
		log.Error(err)
	}
	err = s.Serve(port)
	if err != nil {
		log.Error(err)
	}
}

type server struct {
	db *bolt.DB
}

func New(dbname string) (s *server, err error) {
	s = new(server)
	log.Debug("opening database " + dbname)
	s.db, err = bolt.Open(dbname, 0666, nil)
	if err != nil {
		return
	}
	err = s.db.Update(func(tx *bolt.Tx) error {
		_, err := tx.CreateBucketIfNotExists([]byte("published"))
		if err != nil {
			return fmt.Errorf("create bucket: %s", err)
		}
		return nil
	})
	return
}

func (s *server) Serve(port int) (err error) {
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

	// check to see if path is in the database
	doc, err := s.handleGetPublished(r.URL.Path)
	if err == nil {
		if strings.Contains(r.URL.Path, "raw") {
			_, err = w.Write([]byte(doc.Markdown))
			return
		}
		// use template
		var t *template.Template
		log.Tracef("found doc: %+v", doc)
		b, _ := Asset("static/view.html")
		t, err = template.New("view").Parse(string(b))
		if err != nil {
			log.Error(err)
			return err
		}
		type view struct {
			Title string
			HTML  string
		}
		return t.Execute(w, view{doc.Title, doc.HTML})
	}

	// very special paths
	if r.URL.Path == "/robots.txt" {
		// special path
		w.Write([]byte(`User-agent: * 
Disallow: /`))
	} else if r.URL.Path == "/ws" {
		return s.handleWebsocket(w, r)
	} else if r.URL.Path == "/sitemap.xml" {
		// TODO
	} else {
		if r.URL.Path == "/sw.js" {
			r.URL.Path = "/static/js/sw.js"
		} else if r.URL.Path == "/favicon.ico" {
			r.URL.Path = "/static/images/favicon.ico"
		} else if !strings.HasPrefix(r.URL.Path, "/static") {
			r.URL.Path = "/static/index.html"
		}
		urlPath := r.URL.Path

		var b []byte
		b, err = Asset(path.Clean(r.URL.Path[1:]))
		if err != nil {
			// try to see if index is nested
			b, err = Asset(path.Join(path.Clean(r.URL.Path[1:]), "index.html"))
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
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("Content-Type", kind)

		gz := gzip.NewWriter(w)
		defer gz.Close()
		gz.Write(b)
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

	// on initiation, send a hashlist
	timer := time.Now()
	for {
		var p Payload
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
		timer = time.Now()
		err = c.WriteJSON(rp)
		log.Tracef("send: %s [%2.2fms]", rp, float64(time.Since(timer).Nanoseconds())/1000000)
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
	if err = validate(p.User); err != nil {
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
	case "update-publish":
		// client requests data for specified UUIDs
		rp, err = s.dbHandlePublishUpdate(p)
	case "delete-publish":
		// client requests data for specified UUIDs
		rp, err = s.dbHandlePublishDelete(p)
	default:
		log.Debug("unknown type")
	}

	return
}

func (s *server) handleGetPublished(urlpath string) (d Document, err error) {
	fields := strings.Split(urlpath, "/")
	if len(fields) < 2 {
		err = fmt.Errorf("not a valid url")
		return
	}
	uuid := strings.TrimSpace(fields[1])
	err = s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte("published"))
		v := b.Get([]byte(uuid))
		if v == nil {
			return fmt.Errorf("not found")
		} else {
			return json.Unmarshal(v, &d)
		}
		return nil
	})
	return
}

func (s *server) dbHandlePublishUpdate(p Payload) (rp Payload, err error) {
	rp.Type = "published"
	rp.Datas = make(map[string]string)
	for uuid, val := range p.Datas {
		if err = validate(uuid); err != nil {
			log.Error(err)
			continue
		}
		if err = validate(val); err != nil {
			log.Error(err)
			continue
		}
		var document Document
		err = json.Unmarshal([]byte(val), &document)
		if err != nil {
			log.Errorf("could not unmarshal: %s", val)
			continue
		}
		// make sure its a valid user's document
		err = s.db.View(func(tx *bolt.Tx) error {
			b := tx.Bucket([]byte(p.User + "-data"))
			v := b.Get([]byte(uuid))
			if v == nil {
				return fmt.Errorf("%s not found", uuid)
			}
			return nil
		})
		if err != nil {
			log.Error(err)
			return
		}

		h := sha256.New()
		h.Write([]byte("offlinenotepad" + uuid))
		document.ID = fmt.Sprintf("%x", h.Sum(nil))[:8]
		rp.Datas[uuid] = document.ID
		documentBytes, err := json.Marshal(document)
		if err != nil {
			log.Error(err)
			continue
		}
		err = s.db.Update(func(tx *bolt.Tx) error {
			b := tx.Bucket([]byte("published"))
			return b.Put([]byte(document.ID), documentBytes)
		})
		if err != nil {
			log.Error(err)
			return rp, err
		}
	}
	rp.Message += fmt.Sprintf("published %d documents", len(rp.Datas))

	return
}

func (s *server) dbHandlePublishDelete(p Payload) (rp Payload, err error) {
	rp.Type = "message"
	for uuid := range p.Datas {
		if err = validate(uuid); err != nil {
			log.Error(err)
			continue
		}

		h := sha256.New()
		h.Write([]byte("offlinenotepad" + uuid))
		hashedUUID := fmt.Sprintf("%x", h.Sum(nil))[:8]
		log.Tracef("deleting %s (%s)", uuid, hashedUUID)
		err = s.db.Update(func(tx *bolt.Tx) error {
			b := tx.Bucket([]byte("published"))
			return b.Delete([]byte(hashedUUID))
		})
		if err != nil {
			log.Error(err)
			return rp, err
		} else {
			rp.Message += fmt.Sprintf("deleted %s ", uuid)
		}
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
		if err = validate(uuid); err != nil {
			log.Error(err)
			continue
		}
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
		if err = validate(uuid); err != nil {
			log.Error(err)
			continue
		}
		if err = validate(p.Datas[uuid]); err != nil {
			log.Error(err)
			continue
		}
		log.Tracef("%s: %s = %s", p.User, uuid, val)
		if len(val) == 0 {
			err = fmt.Errorf("no data for " + uuid)
			log.Error(err)
			continue
		}
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

func validate(s string) (err error) {
	if strings.TrimSpace(s) == "" {
		return fmt.Errorf("string is empty")
	}
	if strings.TrimSpace(s) == "undefined" {
		return fmt.Errorf("string is undefined")
	}
	return nil
}
