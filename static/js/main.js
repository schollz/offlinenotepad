/* init */
// initialize local storage
localforage.setDriver([
    localforage.LOCALSTORAGE,
    localforage.WEBSQL,
    localforage.INDEXEDDB,
]).then(function() {
    console.log("[debug] initialized localforage");
});

/* globals */
// this is a list of globals
var socket; // websocket
var hasConnected = false;


/* generic functions */

// export JSON (from SO https://stackoverflow.com/a/30800715)
function downloadObjectAsJson(exportObj, exportName) {
    var dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportObj));
    var downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", exportName + ".json");
    document.body.appendChild(downloadAnchorNode); // required for firefox
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
}

// expand text area
var autoExpand = function(field) {
    // Get the computed styles for the element
    var computed = window.getComputedStyle(field);
    // Calculate the height
    var height = parseInt(computed.getPropertyValue('border-top-width'), 10) +
        parseInt(computed.getPropertyValue('padding-top'), 10) +
        field.scrollHeight +
        parseInt(computed.getPropertyValue('padding-bottom'), 10) +
        parseInt(computed.getPropertyValue('border-bottom-width'), 10);
    if (field.style.height != height + 'px') {
        // Reset field height
        field.style.height = 'inherit';
        field.style.height = height + 'px';
    }
};


// debounce function
const debounce = function(func, wait, immediate) {
    var timeout;
    return function() {
        var context = this,
            args = arguments;
        var later = function() {
            timeout = null;
            if (!immediate) {
                func.apply(context, args);
            }
        };
        var callNow = immediate && !timeout;
        clearTimeout(timeout);
        timeout = setTimeout(later, wait || 200);
        if (callNow) {
            func.apply(context, args);
        }
    };
};

// replace all
String.prototype.replaceAll = function(search, replacement) {
    var target = this;
    return target.replace(new RegExp(search, 'g'), replacement);
};

function makeid() {
    const length = 8;
    var result = '';
    var characters = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var charactersLength = characters.length;
    for (var i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
}


// slugify the current text
function slugify(text) {
    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) {
        var slug = lines[i].toString().toLowerCase()
            .replace(/\s+/g, '-') // Replace spaces with -
            .replace(/[^\w\-]+/g, '') // Remove all non-word chars
            .replace(/\-\-+/g, '-') // Replace multiple - with single -
            .replace(/^-+/, '') // Trim - from start of text
            .replace(/-+$/, ''); // Trim - from end of text
        if (slug.length > 1) {
            return slug;
        }
    }
    return "";
}

// update the history
function updateURL(url1, url2) {
    var newwindowname = slugify(url1);
    if (newwindowname == "") {
        newwindowname = url2;
    }
    // console.log(newwindowname);
    if (newwindowname != undefined && newwindowname.length > 0 && "/" + newwindowname !=
        window.location
        .pathname && newwindowname != window.location.pathname) {
        history.pushState({
            showView: app.showView,
            showEdit: app.showEdit,
            showList: app.showList,
            showSearch: app.showSearch,
        }, newwindowname, newwindowname);
        if (url1 == "/") {
            url1 = "Offline Notepad"
        }
        document.title = url1;
    }
}

/* websockets */
const socketMessageListener = (event) => {
    var data = JSON.parse(event.data);
    processSocketMessage(data);
};
const socketOpenListener = (event) => {
    console.log('[debug] connected');
    if (!hasConnected) {
        // request hashes for syncing down
        socketSend({
            "type": "get-hashes",
            "user": app.usernameHash,
        });
    }
};
const socketCloseListener = (event) => {
    if (socket) {
        console.log('[debug] disconnected');
        hasConnected = false;
    }
    var url = window.origin.replace("http", "ws") + '/ws';
    try {
        socket = new WebSocket(url);
        socket.addEventListener('open', socketOpenListener);
        socket.addEventListener('message', socketMessageListener);
        socket.addEventListener('close', socketCloseListener);
    } catch (err) {
        console.log("[debug] no connection available")
    }
};



/* vue apps */
var app = new Vue({
    el: '#app',
    data: {
        installed: false,
        startTime: moment.now(),
        username: "",
        usernameHash: "",
        password: "",
        docs: {},
        docList: [],
        doc: {},
        sortedItems: [],
        docsFound: [],
        showView: false,
        showEdit: false,
        showList: false,
        showSearch: false,
        showCheck: false,
        showImport: false,
        showSearchBar: false,
        searchText: "",
        searchedText: "",
        searchIndex: {},
        searchIndexLastModified: 0,
        indexing: false,
        markInstance: {},
        markWords: [],
        hasData: false,
        loginUser: "",
        loginPass: "",
    },
    methods: {
        exportDocs: function() {
            downloadObjectAsJson(this.docs, "offlinenotepad_" + this.username);
        },
        getHash: function(s) {
            return CryptoJS.SHA256("offlinenotepad" + s).toString().substring(0, 8);
        },
        install: function() {
            install();
        },
        logIn: function() {
            if (this.loginPass != "" && this.loginUser != "") {
                app.password = this.loginPass;
                app.username = this.loginUser;
                Cookies.set('app.username', app.username);
                var passPass = getHash(moment().format("dddd, MMMM Do YYYY") + app.username);
                sessionStorage.setItem("app.p", encode(app.password, passPass));
                return startup();
            }
            // promptUser();
        },
        logOut: function() {

            Swal.fire({
                title: 'Are you sure?',
                text: "This will clear log you out, but your encrypted data is saved.",
                type: 'warning',
                showCancelButton: true,
                confirmButtonColor: '#3085d6',
                cancelButtonColor: '#d33',
                confirmButtonText: 'Yes, log me out.'
            }).then((result) => {
                if (result.value) {
                    console.log("[debug] logging out");
                    Cookies.remove("app.username");
                    sessionStorage.removeItem("app.p");
                    this.username = "";
                    this.password = "";
                    this.docs = {};
                    this.docList = [];
                    this.doc = {};
                    this.docsFound = [];
                    this.searchIndex = {};
                }
            })
        },
        clearAllData: function() {
            Swal.fire({
                title: 'Are you sure?',
                text: "This will clear all local data, but your encrypted data is safely stored on the server.",
                type: 'warning',
                showCancelButton: true,
                confirmButtonColor: '#3085d6',
                cancelButtonColor: '#d33',
                confirmButtonText: 'Yes, clear all.'
            }).then((result) => {
                if (result.value) {
                    console.log("[debug] clearing data");
                    Cookies.remove("app.username");
                    sessionStorage.removeItem("app.p");
                    localforage.clear();
                    this.username = "";
                    this.password = "";
                    this.docs = {};
                    this.docList = [];
                    this.doc = {};
                    this.docsFound = [];
                    this.searchIndex = {};
                    this.hasData = false;
                }
            })
        },
        searchDocs: debounce(function() {
            console.log(this.searchText.length);
            if (this.searchText.length == 0) {
                return;
            }
            console.log(`[debug] conducting search for ${this.searchText}`)
            this.updateIndex();

            var _this = this;
            this.showSearch = true;
            this.searchedText = this.searchText;
            this.docsFound = [];
            var searchTerm = this.searchText
            // if (!searchTerm.includes(" ")) {
            //     searchTerm = "*" + searchTerm + "*";
            // }

            console.log(`[debug] searching ${searchTerm}`)
            wordsFound = {}
            this.searchIndex.search(searchTerm).forEach(function(el) {
                console.log(el);
                var doc = _this.docs[el.ref];
                // extract snippets from search
                var locations = [];
                var wordFound = "";
                for (var word in el.matchData.metadata) {
                    wordsFound[word] = true;
                    wordFound = word;
                    if ("text" in el.matchData.metadata[word]) {
                        for (var pos in el.matchData.metadata[word].text.position) {
                            locations.push(el.matchData.metadata[word].text.position[pos][
                                0
                            ]);
                        }
                    }
                }
                snippet = getSnippet(doc.markdown, wordFound, locations);
                _this.docsFound.push({
                    title: doc.title,
                    snippet: snippet,
                    uuid: doc.uuid,
                    modified: doc.modified,
                    created: doc.created,
                    published: doc.published,
                });
            });
            this.markWords = [];
            for (var word in wordsFound) {
                this.markWords.push(word);
            }
        }, 500),
        flashCheck: function() {
            this.showCheck = true;
            var _this = this;
            setTimeout(function() {
                _this.showCheck = false;
            }, 500)
        },
        tabber: function(event) {
            let text = this.doc.markdown,
                originalSelectionStart = event.target.selectionStart,
                textStart = text.slice(0, originalSelectionStart),
                textEnd = text.slice(originalSelectionStart);

            this.doc.markdown = `${textStart}\t${textEnd}`
            event.target.value = this.doc.markdown
            event.target.selectionEnd = event.target.selectionStart = originalSelectionStart + 1

        },
        formatDate: function(datestr) {
            return moment(datestr).format("MM-DD hh:mm A")
        },
        makeNew: function(e) {
            this.doc = new Document();
            this.showEdit = true;
        },
        select: function(event) {
            var i = event.currentTarget.id;
            this.doc = {
                title: this.docs[i].title,
                markdown: this.docs[i].markdown,
                uuid: i,
                hash: this.docs[i].hash,
                modified: this.docs[i].modified,
                created: this.docs[i].created,
                published: this.docs[i].published,
            }
            this.showView = true;
        },
        keyDown: function(e) {
            var keyCode = e.keyCode || e.which;

            if (keyCode == 9) {
                e.preventDefault();
                var start = e.currentTarget.selectionStart;
                var end = e.currentTarget.selectionEnd;
                this.doc.markdown = [this.doc.markdown.slice(0, start), "\t", this.doc.markdown
                    .slice(start)
                ].join('');
                e.currentTarget.selectionStart = start;
                e.currentTarget.selectionEnd = end;
            }
        },
        deleteDoc: function(e) {
            Swal.fire({
                title: 'Are you sure?',
                text: "You won't be able to revert this!",
                type: 'warning',
                showCancelButton: true,
                confirmButtonColor: '#3085d6',
                cancelButtonColor: '#d33',
                confirmButtonText: 'Yes, delete it!'
            }).then((result) => {
                if (result.value) {
                    console.log(`[debug] removing '${this.doc.uuid}'`)

                    var _this = this;
                    this.doc.rawHTML = "";
                    this.doc.markdown = "";
                    this.doc.title = "deleted";
                    this.doc.modified = moment.utc();
                    this.doc.hash = getHash(this.doc.uuid + this.doc.title + this
                        .doc.markdown);
                    this.docs[this.doc.uuid] = {
                        title: this.doc.title,
                        hash: this.doc.hash,
                        modified: this.doc.modified,
                        created: this.doc.created,
                        markdown: this.doc.markdown,
                        published: this.doc.published,
                    }
                    var encoded = encode(JSON.stringify(this.doc), this.password);

                    // update data and hash in server
                    var datas = {};
                    datas[this.doc.uuid] = encoded;
                    socketSend({
                        type: "update-data",
                        user: this.usernameHash,
                        datas: datas,
                    })
                    var hashes = {}
                    hashes[this.doc.uuid] = this.doc.hash;
                    socketSend({
                        type: "update-hashes",
                        user: this.usernameHash,
                        datas: hashes,
                    })
                    var datas2 = {};
                    datas2[this.doc.uuid] = "";
                    socketSend({
                        type: "delete-publish",
                        user: this.usernameHash,
                        datas: datas2,
                    })

                    localforage.setItem(this.doc.uuid, encoded).then(function() {
                        console.log(`[debug] removed ${_this.doc.uuid}`);
                        _this.doc = new Document();
                        _this.showList = true;
                        _this.flashCheck();
                    }).catch(function(err) {
                        console.log("[error] problem removing: " + err);
                    });
                }
            })
        },
        publishDocument: function() {
            _this = this;
            if (!this.doc.published) {
                Swal.fire({
                    title: 'Are you sure?',
                    text: "This will publish a public version of this document that anyone can view.",
                    type: 'warning',
                    showCancelButton: true,
                    confirmButtonColor: '#3085d6',
                    cancelButtonColor: '#d33',
                    confirmButtonText: 'Yes, publish.'
                }).then((result) => {
                    if (result.value) {
                        var datas = {};
                        datas[_this.doc.uuid] = JSON.stringify({
                            ID: _this.doc.uuid,
                            Title: _this.doc.title,
                            HTML: (new showdown.Converter({ simplifiedAutoLink: true, strikethrough: true })).makeHtml(this.doc.markdown),
                            Markdown: _this.doc.markdown,
                        });
                        socketSend({
                            type: "update-publish",
                            user: _this.usernameHash,
                            datas: datas,
                        });
                    }
                })
            } else {
                var datas = {};
                datas[this.doc.uuid] = JSON.stringify({
                    ID: this.doc.uuid,
                    Title: this.doc.title,
                    HTML: (new showdown.Converter({ simplifiedAutoLink: true, strikethrough: true })).makeHtml(this.doc.markdown),
                    Markdown: this.doc.markdown,
                });
                socketSend({
                    type: "update-publish",
                    user: this.usernameHash,
                    datas: datas,
                });
                this.flashCheck();
            }
        },
        updateIndex: function() {
            if (moment.utc() - this.searchIndexLastModified > 10000 && !this.indexing) {
                this.indexing = true;
                console.log("[debug] indexing")
                var documents = [];
                for (var i in this.docs) {
                    documents.push({
                        "id": i,
                        "title": this.docs[i].title,
                        "text": this.docs[i].markdown,
                    });
                }
                this.searchIndex = lunr(function() {
                    this.ref('id');
                    this.field('title');
                    this.field('text');
                    this.metadataWhitelist = ['position']

                    documents.forEach(function(doc) {
                        this.add(doc)
                    }, this)
                })
                this.searchIndexLastModified = moment.utc();
                this.indexing = false;
            }
        },
        markSearchResults: function() {
            console.log("[debug] marking")
            this.markInstance = new Mark(document.querySelectorAll(".snippet"));
            _this = this;
            this.markWords.forEach(function(el) {
                _this.markInstance.mark(el, {});
            });
        },
        updateDoc: debounce(function() {
            autoExpand(document.getElementById("editable"));
            if (this.showEdit) { // only update if in edit mode
                // update the modified timestamp
                this.doc.modified = moment.utc();

                // update the hash
                this.doc.hash = getHash(this.doc.uuid + this.doc.title + this.doc.markdown)

                // update the URL
                updateURL(this.doc.title, this.doc.uuid);

                if (this.password != null) {
                    encoded = encode(JSON.stringify(this.doc), this.password);

                    // update in the local storage
                    localforage.setItem(this.doc.uuid, encoded);

                    // update data and hash in server
                    var datas_to_send = {};
                    datas_to_send[this.doc.uuid] = encoded;
                    socketSend({
                        type: "update-data",
                        message: "updateDoc",
                        user: this.usernameHash,
                        datas: datas_to_send,
                    })
                    var hashes_to_send = {}
                    hashes_to_send[this.doc.uuid] = this.doc.hash;
                    socketSend({
                        type: "update-hashes",
                        message: "updateDoc",
                        user: this.usernameHash,
                        datas: hashes_to_send,
                    })
                };


                // update in the app
                this.docs[this.doc.uuid] = {
                    title: this.doc.title,
                    uuid: this.doc.uuid,
                    hash: this.doc.hash,
                    modified: this.doc.modified,
                    created: this.doc.created,
                    markdown: this.doc.markdown,
                    published: this.doc.published,
                }
                this.flashCheck();
            }
        }, 400),
    },
    updated: function() {
        _this = this;
        this.$nextTick(function() {
            // Code that will run only after the
            // entire view has been re-rendered
            if (_this.showSearch) {
                _this.markSearchResults();
            }
            if (_this.showEdit) {
                autoExpand(document.getElementById("editable"));
            }
        })
    },
    computed: {
        isChrome: function() {
            return navigator.userAgent.toLowerCase().indexOf('chrome') > -1;
        },
        showWelcomeText: function() {
            if (this.username == "undefined" || this.username == "" || this.username == undefined) {
                return false;
            }
            return this.showList && this.docList.length == 0;
        },
        showIntroText: function() {
            return (this.username == "undefined" || this.username == "" || this.username ==
                undefined);
        },
        showListOrSearch: function() {
            return this.showList || this.showSearch;
        },
        showViewOrEdit: function() {
            return this.showView || this.showEdit;
        },
        isCode: function() {
            if (this.doc.title == undefined) {
                return false;
            }
            return this.doc.title.includes(".");
        }
    },
    watch: {
        showSearchBar: function(val) {
            if (val) {
                this.updateIndex();
            }
        },
        username: function() {
            if (this.username == undefined || this.username == "undefined" || this.username == "") {
                this.usernameHash = "";
            } else {
                this.usernameHash = getHash(this.username);
                // check is has data
                this.hasData = false;
                localforage.keys().then((keys) => {
                    this.hasData = (keys.length > 0);
                }).catch(function(err) {
                    console.log(`[error] ` + err);
                });
            }
        },
        showView: function(val) {
            if (val == true) {
                this.showSearchBar = false;
                this.showEdit = false;
                // update the html (for viewer)
                this.doc.rawHTML = (new showdown.Converter({ simplifiedAutoLink: true, strikethrough: true })).makeHtml(this.doc.markdown)
                window.scrollTo(0, 0);
            }
        },
        showEdit: function(val) {
            if (val == true) {
                this.showSearchBar = false;
                this.showView = false;
                window.scrollTo(0, 0);
            }
        },
        showList: function(val) {
            if (this.username == "" || this.password == "") {
                promptUser();
            }
            if (val == true) {
                sortDocList();
                this.showSearchBar = false;
                this.showEdit = false;
                this.showView = false;
                this.showSearch = false;
                updateURL("/", "/");
                window.scrollTo(0, 0);
            }
        },
        showSearch: function(val) {
            if (val) {
                this.showEdit = false;
                this.showView = false;
                window.scrollTo(0, 0);
            }
        },
        showViewOrEdit: function(val) {
            if (val == true) {
                this.showSearchBar = false;
                this.showList = false;
                this.showSearch = false;
                updateURL(this.doc.title, this.doc.uuid);
            }
        },
    }
})







var CY = {};



// Constructor function for Person objects
// a = new Document();
Document = function() {
    this.uuid = makeid();
    this.created = moment.utc();
    this.modified = moment.utc();
    this.title = "";
    this.markdown = "";
    this.hash = getHash(this.uuid + this.title + this.markdown);
    this.published = false;
}

const sortDocList = function() {
    console.log(`[debug] sorting ${Object.keys(app.docs).length} loaded docs`)

    app.docList = [];
    for (var i in app.docs) {
        if (app.docs[i].title != "deleted" && i != "undefined" && i != undefined) {
            app.docList.push(app.docs[i]);
        }
    }
    app.docList = app.docList.sort(function(a, b) {
        return new Date(b.modified) - new Date(a.modified);
    });
}

syncUp = function() {
    if (socket.readyState != 1) {
        return
    }
    localforage.keys().then(function(keys) {
        if (app.password != null) {
            keys.forEach(function(key) {
                localforage.getItem(key).then(function(getValue) {
                    decoded = decode(getValue,
                        app.password);
                    if (decoded != null) {
                        try {
                            doc = JSON.parse(decoded);
                        } catch (e) {
                            console.log("[warn]: could not parse json")
                            return;
                        }

                        socketSend({
                            "type": "offer",
                            "user": app.usernameHash,
                            "hash": doc.hash,
                            "uuid": doc.uuid,
                        });
                    }
                });
            });
        }
    }).catch(function(err) {
        // This code runs if there were any errors
        console.log(err);
    });
}


const getHash = function(s) {
    return CryptoJS.SHA256("offlinenotepad" + s).toString().substring(0, 8);
}

function socketSend(data) {
    if (socket == null) {
        return
    }
    if (socket.readyState != 1) {
        return
    }
    jsonData = JSON.stringify(data);
    console.log("[debug] ws-> " + jsonData)
    socket.send(jsonData);
}

async function parseDoc(value) {
    decoded = decode(value, app.password);
    if (decoded != null) {
        try {
            doc = JSON.parse(decoded);
        } catch (e) {
            console.log("[warn]: could not parse json")
            return;
        }
        app.docs[doc.uuid] = {
            title: doc.title,
            uuid: doc.uuid,
            hash: doc.hash,
            modified: doc.modified,
            created: doc.created,
            markdown: doc.markdown,
            published: doc.published,
        };
    }
}

function loadDocs() {
    console.log("[debug] loading docs")
    app.docs = {};

    localforage.iterate(function(value, key, iterationNumber) {
        parseDoc(value);
    }).then(function() {
        sortDocList();
    }).catch(function(err) {
        // This code runs if there were any errors
        console.log(err);
    });

}

function processSocketMessage(d) {
    console.log("[debug] ws<- " + JSON.stringify(d))
    if (!d.success) { // not a success
        console.log("error: " + d.message);
        return;
    }
    var to_send_hashes = {};
    var to_send_datas = {};
    var message = d.type;
    if (d.type == "hashes") {
        if (d.datas == undefined) {
            d.datas = {};
        }
        hasConnected = true;

        // check to see if any hashes differ to request from server
        var to_request = {};
        for (var uuid in d.datas) {
            if (uuid in app.docs) {
                if (d.datas[uuid] != app.docs[uuid].hash) {
                    to_request[uuid] = "";
                }
            } else {
                to_request[uuid] = "";
            }
        }
        if (Object.keys(to_request).length > 0) {
            var num_requests = Object.keys(to_request).length
            console.log(`[debug] requesting update for ${num_requests} documents`);
            // send server request for differing documents
            socketSend({
                "type": "get-data",
                "user": app.usernameHash,
                "datas": to_request,
            });
        } else {
            console.log("[debug] server documents do not differ");
        }

        // see if server is missing any
        for (var uuid in app.docs) {
            if (uuid in d.datas) {} else {
                app.docs[uuid].hash = getHash(uuid + app.docs[uuid].title + app.docs[uuid].markdown)
                to_send_datas[uuid] = encode(JSON.stringify(app.docs[uuid]), app.password);
                to_send_hashes[uuid] = app.docs[uuid].hash;
            }
        }
    } else if (d.type == "published") {
        for (var uuid in d.datas) {
            app.docs[uuid].published = true;
            if (uuid == app.doc.uuid) {
                app.doc.published = true;
            }

            // update in the server and locally
            var encoded = encode(JSON.stringify(app.docs[uuid]), app.password);

            localforage.setItem(uuid, encoded);

            // update data and hash in server
            var datas = {};
            datas[uuid] = encoded;
            socketSend({
                type: "update-data",
                user: app.usernameHash,
                datas: datas,
            });
            var hashes = {}
            hashes[uuid] = app.docs[uuid].hash;
            socketSend({
                type: "update-hashes",
                user: app.usernameHash,
                datas: hashes,
            });
        }
    } else if (d.type == "update") {
        // received an update for the data in the app
        var updated = false;
        for (var uuid in d.datas) {
            console.log(`[debug] received ${uuid} from server`)
            var decoded = decode(d.datas[uuid], app.password);
            if (decoded == null || decoded == undefined) {
                console.log(`[warn] could not decode ${uuid}: ${d.datas[uuid]}`);
                continue
            }
            var doc = {};
            try {
                doc = JSON.parse(decoded)
            } catch (err) {
                console.log(`[warn] could not parse ${decoded}`);
                continue
            }

            if (doc.uuid in app.docs) {
                // check the modified timestamp, keep newer
                incoming_doc_is_newer = doc.modified > app.docs[doc.uuid].modified;
                if (incoming_doc_is_newer) {
                    // re-encode and save and update the app
                    console.log(`[debug] incoming '${doc.uuid}' is newer`)
                    localforage.setItem(uuid, d.datas[uuid]);
                    app.docs[doc.uuid] = doc;
                    if (app.doc.uuid == doc.uuid) {
                        app.doc = doc;
                    }
                    updated = true;
                } else {
                    // update the server with the current version
                    console.log(`[debug] incoming '${doc.uuid}' is older, updating server`)
                    to_send_datas[doc.uuid] = encode(JSON.stringify(app.docs[doc.uuid]), app.password);
                    to_send_hashes[doc.uuid] = app.docs[doc.uuid].hash;
                }
            } else {
                // add new doc
                app.docs[doc.uuid] = {
                    title: doc.title,
                    markdown: doc.markdown,
                    uuid: doc.uuid,
                    hash: doc.hash,
                    modified: doc.modified,
                    created: doc.created,
                    published: doc.published,
                }

                // update in the local storage
                localforage.setItem(uuid, d.datas[uuid]);
                updated = true;
            }
        }
        // update the doc list
        if (updated) {
            sortDocList();
        }
    } else if (d.type == "message") {} else {
        // console.log("[info] message: " + d.message);        } else {
        console.log(`[warn] unknown type: ${d.type}`)
    }
    if (Object.keys(to_send_hashes).length > 0) {
        console.log(`[debug] server is missing ${Object.keys(to_send_hashes).length} documents`);
        // send server hashes, data for the documents it doesn't have or that needs updating
        socketSend({
            type: "update-data",
            message: message,
            user: app.usernameHash,
            datas: to_send_datas,
        })
        socketSend({
            type: "update-hashes",
            message: message,
            user: app.usernameHash,
            datas: to_send_hashes,
        })
    } else {
        console.log("[debug] server is not missing any")
    }
}







// encryption
const keySize = 128;
const ivSize = 64;
const iterations = 10;

// http://www.adonespitogo.com/articles/encrypting-data-with-cryptojs-aes/
function encode(msgString, pass) {
    msg = CryptoJS.enc.Utf16.parse(LZString.compressToUTF16(msgString))
    var salt = CryptoJS.lib.WordArray.random(128 / 8);

    var key = CryptoJS.PBKDF2(pass, salt, {
        keySize: keySize / 32,
        iterations: iterations
    });

    var iv = CryptoJS.lib.WordArray.random(128 / 8);

    var encrypted = CryptoJS.AES.encrypt(msg, key, {
        iv: iv,
        padding: CryptoJS.pad.Pkcs7,
        mode: CryptoJS.mode.CBC

    });

    // salt, iv will be hex 32 in length
    // append them to the ciphertext for use  in decryption
    var transitmessage = salt.toString() + iv.toString() + encrypted.toString();
    return transitmessage;
}

function decode(transitmessage, pass) {
    if (transitmessage == null) {
        console.log("[debug] got null transmit message")
        return null;
    }
    var salt = CryptoJS.enc.Hex.parse(transitmessage.substr(0, 32));
    var iv = CryptoJS.enc.Hex.parse(transitmessage.substr(32, 32))
    var encrypted = transitmessage.substring(64);

    var key = CryptoJS.PBKDF2(pass, salt, {
        keySize: keySize / 32,
        iterations: iterations
    });

    var decrypted = CryptoJS.AES.decrypt(encrypted, key, {
        iv: iv,
        padding: CryptoJS.pad.Pkcs7,
        mode: CryptoJS.mode.CBC

    })
    return LZString.decompressFromUTF16(decrypted.toString(CryptoJS.enc.Utf16));
}

function tryPromptPassword() {
    app.username = Cookies.get('app.username');
    if (app.username == undefined || app.username == "undefined" || app.username == "") {} else {
        promptPassword();
    }
}

function promptUser() {
    app.username = Cookies.get('app.username');
    if (app.username == undefined || app.username == "undefined" || app.username == "") {
        Swal.fire({
            title: 'Enter a user name',
            input: 'text',
            html: 'If this is your first time, choose any name you will remember.',
            inputPlaceholder: 'Enter a user name',
            inputAttributes: {
                autocapitalize: 'off',
                autocorrect: 'off',
            },
            inputValidator: (value) => {
                if (!value) {
                    return 'You need to write something!'
                }
            }
        }).then(result => {
            if (result.value != undefined && result.value != "undefined") {
                app.username = result.value;
                Cookies.set('app.username', app.username);
                promptPassword();
            }
        })
    } else {
        promptPassword();
    }
}

window.onbeforeunload = function(event) {
    var passPass = getHash(moment().format("dddd, MMMM Do YYYY") + app.username);
    sessionStorage.setItem("app.p", encode(app.password, passPass));
};

window.onunload = function() {
    var passPass = getHash(moment().format("dddd, MMMM Do YYYY") + app.username);
    sessionStorage.setItem("app.p", encode(app.password, passPass));
};

function promptPassword() {
    var p = sessionStorage.getItem("app.p");
    if (p != null) {
        console.log(`[debug] got sesions password: ${p}`)
        sessionStorage.removeItem("app.p");
        var passPass = getHash(moment().format("dddd, MMMM Do YYYY") + app.username);
        p2 = decode(p, passPass);
        if (p2 != null && p2 != undefined && p2 != "") {
            app.password = p2;
            return startup();
        } else {
            console.log("[debug] could not decode password");
        }
    }
    Swal.fire({
        title: 'Welcome ' + app.username,
        html: 'Enter a password to decrypt your data.',
        input: 'password',
        inputPlaceholder: 'Enter your password',
        inputAttributes: {
            autocapitalize: 'off',
            autocorrect: 'off'
        },
        inputValidator: (value) => {
            if (!value) {
                return 'You need to write something!'
            }
        }
    }).then(result => {
        var passPass = getHash(moment().format("dddd, MMMM Do YYYY") + app.username);
        sessionStorage.setItem("app.p", encode(app.password, passPass));
        app.password = result.value;
        startup();
    });
}


function startup() {
    loadDocs();
    app.doc = new Document();
    var loadedDoc = false;
    if (window.location.pathname != "/") {
        titleToFind = window.location.pathname.substring(1, window.location.pathname.length);
        localforage.keys().then(function(keys) {
            if (app.password != null) {
                keys.forEach(function(key) {
                    localforage.getItem(key).then(function(getValue) {
                        decoded = decode(getValue,
                            app.password);
                        if (decoded != null) {
                            try {
                                doc = JSON.parse(decoded);
                            } catch (e) {
                                console.log("[warn]: could not parse json")
                                return;
                            }
                            if (slugify(doc.title) == slugify(titleToFind) || doc
                                .uuid == titleToFind) {
                                app.doc = doc;
                                console.log(app.doc);
                                app.showView = true;
                                loadedDoc = true;
                            }
                        }
                    });
                });
            }
        }).catch(function(err) {
            // This code runs if there were any errors
            console.log(err);
        });
    }
    if (loadedDoc == false) {
        app.showList = true;
    }
    socketCloseListener();
}


function getSnippet(text, word, locations) {
    const locationLimit = 60;

    function trimLeftWords(text) {
        text = text.split(/[ ]+/).join(" ");
        for (var i = 0; i < text.length - 1; i++) {
            if (text[i] == " ") {
                text = text.substring(i + 1, text.length);
                break;
            }
        }
        return "..." + text;
    }

    function trimRightWords(text) {
        text = text.split(/[ ]+/).join(" ");
        for (var i = text.length; i > 1; i--) {
            if (text[i] == " ") {
                text = text.substring(0, i);
                break;
            }
        }
        return text + "...";
    }

    function formatSnippet(text, currentSection, word) {
        var re = new RegExp(word, 'g');
        snippet = text.substring(currentSection[0], currentSection[1]);
        if (currentSection[0] > 0) {
            snippet = trimLeftWords(snippet);
        }
        if (currentSection[1] < text.length) {
            snippet = trimRightWords(snippet);
        }
        return snippet.replace(re, "<mark>" + word + "</mark>");
    }

    var snippets = [];
    var currentSection = [0, locationLimit];
    for (var i = 0; i < locations.length; i++) {
        if (locations[i] > currentSection[1] + locationLimit) {
            snippets.push(formatSnippet(text, currentSection, word));
            currentSection[0] = locations[i] - locationLimit;
        }
        currentSection[1] = locations[i] + locationLimit;
    }
    snippets.push(formatSnippet(text, currentSection, word));

    return snippets.join(" ");
}




window.onload = function() {
    document.getElementById('import').onclick = function() {
        var files = document.getElementById('selectFiles').files;
        if (files.length <= 0) {

            return false;
        }
        var fr = new FileReader();
        fr.onload = function(e) {
            console.log(e);
            var result = JSON.parse(e.target.result);
            console.log(result);
            result.forEach(function(doc) {
                console.log(doc.id);
                app.docs[doc.id] = {
                    "uuid": doc.id,
                    "title": doc.slug,
                    "created": doc.created,
                    "modified": doc.modified,
                    "markdown": doc.data,
                    "published": doc.published,
                    "hash": getHash(doc.id + doc.slug + doc.data),
                };
                encoded = encode(JSON.stringify(app.docs[doc.id]), app.password);
                localforage.setItem(doc.id, encoded);
            })
        }
        fr.readAsText(files.item(0));
    };

    tryPromptPassword();

}


/* some basic benchmarking */
s = `Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Egestas tellus rutrum tellus pellentesque. Vitae sapien pellentesque habitant morbi. Sit amet nisl purus in mollis nunc sed. Aenean et tortor at risus. Massa id neque aliquam vestibulum. Sed risus ultricies tristique nulla aliquet. Lacus vel facilisis volutpat est. Est ullamcorper eget nulla facilisi etiam dignissim diam quis enim. Curabitur gravida arcu ac tortor dignissim convallis aenean. Posuere ac ut consequat semper viverra nam. Nulla aliquet enim tortor at. Tempor id eu nisl nunc mi ipsum faucibus vitae. Arcu bibendum at varius vel. Aliquam sem et tortor consequat id porta. Felis bibendum ut tristique et. Proin nibh nisl condimentum id venenatis a condimentum vitae. Purus sit amet luctus venenatis. Tincidunt tortor aliquam nulla facilisi cras fermentum odio eu feugiat. Erat pellentesque adipiscing commodo elit at imperdiet dui accumsan.

Est ullamcorper eget nulla facilisi. Molestie at elementum eu facilisis sed odio morbi quis commodo. Pellentesque nec nam aliquam sem et. Diam vulputate ut pharetra sit amet aliquam id. Magna fermentum iaculis eu non diam phasellus vestibulum lorem. Vitae tortor condimentum lacinia quis vel eros donec ac odio. Tempus egestas sed sed risus. A iaculis at erat pellentesque adipiscing commodo elit at imperdiet. Faucibus ornare suspendisse sed nisi lacus sed viverra. Enim neque volutpat ac tincidunt vitae. Massa vitae tortor condimentum lacinia. Lacus viverra vitae congue eu consequat.

Faucibus turpis in eu mi. Augue ut lectus arcu bibendum at varius. Ultrices sagittis orci a scelerisque purus semper eget. Morbi non arcu risus quis varius. Id porta nibh venenatis cras sed felis eget velit aliquet. Imperdiet nulla malesuada pellentesque elit eget gravida. Malesuada fames ac turpis egestas. Lobortis elementum nibh tellus molestie nunc. Condimentum lacinia quis vel eros donec ac odio. Egestas sed tempus urna et pharetra pharetra massa massa ultricies. Lectus magna fringilla urna porttitor rhoncus dolor purus. Sed elementum tempus egestas sed sed risus pretium quam. Ut sem nulla pharetra diam sit amet nisl suscipit adipiscing. Ultrices in iaculis nunc sed augue. Nec sagittis aliquam malesuada bibendum arcu vitae elementum curabitur vitae. Leo urna molestie at elementum eu facilisis sed odio morbi. Enim nulla aliquet porttitor lacus luctus accumsan tortor. Cras fermentum odio eu feugiat pretium. Volutpat commodo sed egestas egestas fringilla phasellus faucibus.

Ligula ullamcorper malesuada proin libero nunc consequat interdum varius. Egestas sed tempus urna et pharetra pharetra. Libero id faucibus nisl tincidunt. Ultrices gravida dictum fusce ut. Tellus integer feugiat scelerisque varius. Maecenas accumsan lacus vel facilisis volutpat est. Malesuada proin libero nunc consequat interdum varius. Lectus nulla at volutpat diam ut. Curabitur vitae nunc sed velit dignissim sodales ut. Nullam eget felis eget nunc lobortis mattis aliquam faucibus purus. Mattis ullamcorper velit sed ullamcorper. Neque egestas congue quisque egestas. Sed felis eget velit aliquet sagittis id consectetur purus. Molestie at elementum eu facilisis sed odio morbi. Morbi tincidunt augue interdum velit euismod. Vel facilisis volutpat est velit. Lobortis elementum nibh tellus molestie nunc non blandit massa enim. Vel turpis nunc eget lorem dolor sed viverra ipsum.

Mi bibendum neque egestas congue quisque egestas. Auctor urna nunc id cursus metus aliquam. A iaculis at erat pellentesque adipiscing commodo elit at. Dignissim diam quis enim lobortis scelerisque fermentum dui. Enim ut sem viverra aliquet eget. Pellentesque elit ullamcorper dignissim cras tincidunt. Malesuada bibendum arcu vitae elementum curabitur vitae nunc. Augue interdum velit euismod in pellentesque massa placerat duis ultricies. Pellentesque elit eget gravida cum sociis natoque. Sit amet aliquam id diam maecenas ultricies mi. Tellus molestie nunc non blandit massa. Leo vel fringilla est ullamcorper eget. In fermentum posuere urna nec tincidunt praesent. A diam sollicitudin tempor id eu. Mi proin sed libero enim sed. Tempor id eu nisl nunc mi ipsum faucibus vitae. Adipiscing bibendum est ultricies integer quis auctor elit.`

var t0 = performance.now();
for (i = 0; i < 10; i++) {
    encode(s, "somepassword");
}
var t1 = performance.now();
console.log("[debug] encode speed: " + Math.round((t1 - t0) / 10 * 1000) + " op/s.")

var encoded = encode(s, "somepassword");
var t0 = performance.now();
for (i = 0; i < 10; i++) {
    decode(encoded, "somepassword");
}
var t1 = performance.now();
console.log("[debug] decoded speed: " + Math.round((t1 - t0) / 10 * 1000) + " op/s.")


/* basics for the installation */
var promptEvent;

const install = function() {
    if (promptEvent) {
        promptEvent.prompt();
        promptEvent.userChoice
            .then(function(choiceResult) {
                // The user actioned the prompt (good or bad).
                // good is handled in 
                promptEvent = null;
                app.installed = true;
            })
            .catch(function(installError) {
                // Boo. update the UI.
                promptEvent = null;
                app.installed = true;
            });
    } else {
        app.installed = true;
    }
};

const installed = function() {
    promptEvent = null;
    app.installed = true;
    // This fires after onbeforinstallprompt OR after manual add to homescreen.
};

const beforeinstallprompt = function(e) {
    promptEvent = e;
    promptEvent.preventDefault();
    return false;
};


window.addEventListener('beforeinstallprompt', beforeinstallprompt);
window.addEventListener('appinstalled', installed);


/* listen to the history */
window.addEventListener('popstate', (event) => {
    console.log("[debug] location: " + document.location + ", state: " + JSON.stringify(event.state));
    app.showView = event.state.showView;
    app.showEdit = event.state.showEdit;
    app.showSearch = event.state.showSearch;
    app.showList = event.state.showList;
});