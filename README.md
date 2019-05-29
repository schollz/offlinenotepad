
<p align="center">
<img
    src="https://user-images.githubusercontent.com/6550035/58387410-d2e33780-7fc2-11e9-8823-ce290b1cce7a.png"
    width="408px" border="0" alt="offlinenotepad">
</p>

<p align="center"><code><a href="https://offlinenotepad.com">https://offlinenotepad.com</a></code></p>

*offlinenotepad* is an [open-source](https://github.com/schollz/offlinenotepad) offline note taking app. It is a browser-based offline-first notepad that securely syncs across your devices: including smartphones, laptops, and chromebooks. Ideally, its a minimalist note-writing experience that can be accessed anywhere, anytime. 

**Offline-first.** All information is stored as encrypted data in the browser, by utilizing the local storage. There are client-side libraries for search and encryption so that everything happens in the browser.

**Secure.** offlinenotepad uses [crypto-js](https://github.com/brix/crypto-js) to encrypt data on the client using AES with the PBE algorithm (PBKDF2).

**Minimal.** This offline notepad aims to do as much as possible with as little as possible.

**Publish.** Any page can be "published" so that is accessible by anyone with a simple random link, like [`offlinenotepad.com/50e5791a`](https://offlinenotepad.com/50e5791a). The raw data can easily be easily cURLed by adding `/raw` to the end, e.g. [`offlinenotepad.com/50e5791a/raw`](https://offlinenotepad.com/50e5791a/raw).

**Code.** If the title of any document contains a period (".") then it will force the editor to be monospace and it will show the plain text in the viewer instead of transformed Markdown to HTML.

This writing tool is largely based of its predecessors: [cowyo](https://cowyo.com) and [rwtxt.com](https://rwtxt.com) (both also available on Github).

## Install

To run your own server for backing up notes you can simply install with Go.

```
$ git clone https://github.com/schollz/offlinenotepad
$ cd offlinenotepad
$ go build -v
```

And then you can run

```

$ ./offlinenotepad
```

Log into `localhost:8251` to see the site.

## Acknowledgements

I took a lot of help from @GoogleChromeLabs with their [airhorn](https://github.com/GoogleChromeLabs/airhorn).

## License

MIT
